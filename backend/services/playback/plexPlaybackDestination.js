import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { userOps } from "../../db/helpers/index.js";
import { PlexClient } from "../plex.js";
import { plexConnectionStore } from "../plex/plexConnectionStore.js";
import { plexPlaylistPointerStore } from "../plex/plexPlaylistPointerStore.js";
import { getPathMappings, resolveLocalPath } from "../pathMappings.js";
import {
  PLAYLIST_LIBRARY_DIR,
  isPathInsideRoot,
  resolvePlaylistRoot,
} from "../playlistPaths.js";
import {
  createPlaybackPlaylistIdentity,
  createPlaybackPlaylistSnapshot,
  playbackOperationFailure,
  playbackOperationSuccess,
} from "./playbackDestination.js";

const SYNC_SKIPPED = Symbol("plex-sync-skipped");

export const plexSettings = Object.freeze({
  key: "plex",
  label: "Plex",
  subtitle: "Plexamp",
  customUi: "plex",
  fields: Object.freeze([
    Object.freeze({ key: "url", label: "Server URL", type: "url", required: true }),
    Object.freeze({ key: "token", label: "Account token", type: "password", secret: true, hidden: true }),
  ]),
  defaults: Object.freeze({ url: "", token: "" }),
  validation: Object.freeze({ required: ["url"], url: ["url"] }),
  testConnection: true,
});

export class PlexPlaybackDestination {
  constructor(weeklyFlowRoot = resolvePlaylistRoot(), { client = null } = {}) {
    this.key = "plex";
    this.name = "Plex";
    this.weeklyFlowRoot = resolvePlaylistRoot(weeklyFlowRoot);
    this.playlistLibraryRoot = path.join(this.weeklyFlowRoot, PLAYLIST_LIBRARY_DIR);
    this.client = client;
    this._configKey = "";
    this._downloadsPath = "";
    this._mainLibrarySectionId = "";
    this._configuredByUserId = null;
    this._sectionId = null;
    this._libraryTracks = null;
    this._mainLibraryTracks = null;
    this._syncHashes = new Map();
    this._catchupRunning = false;
  }

  updateConfig(config = {}) {
    const key = JSON.stringify({
      url: config.url || "",
      token: config.token || "",
      clientId: config.clientId || "",
      downloadsPath: config.downloadsPath || "",
      mainLibrarySectionId: config.mainLibrarySectionId || "",
      configuredByUserId: config.configuredByUserId ?? null,
    });
    if (key === this._configKey) return;
    this._configKey = key;
    this._downloadsPath = config.downloadsPath || "";
    this._mainLibrarySectionId = String(config.mainLibrarySectionId || "").trim();
    this._configuredByUserId =
      config.configuredByUserId != null ? Number(config.configuredByUserId) : null;
    this.client = config.url && config.token
      ? new PlexClient(config.url, config.token, config.clientId)
      : null;
    this._sectionId = null;
    this._libraryTracks = null;
    this._mainLibraryTracks = null;
    this._syncHashes.clear();
  }

  isConfigured() {
    return Boolean(this.client?.isConfigured());
  }

  _libraryPath() {
    const override = String(this._downloadsPath || "").trim();
    if (!override) return this.playlistLibraryRoot.replace(/\\/g, "/").replace(/\/+$/, "");
    return `${override.replace(/\\/g, "/").replace(/\/+$/, "")}/${PLAYLIST_LIBRARY_DIR}`;
  }

  async testConnection() {
    if (!this.isConfigured()) {
      return playbackOperationFailure({
        code: "DESTINATION_NOT_CONFIGURED",
        message: "Plex is not configured",
      });
    }
    try {
      await this.client.ping();
      return playbackOperationSuccess();
    } catch (error) {
      return playbackOperationFailure({
        code: "DESTINATION_UNAVAILABLE",
        message: error?.message || "Plex did not respond",
        retryable: true,
      });
    }
  }

  async ensureLibrary() {
    if (!this.isConfigured()) return playbackOperationSuccess();
    try {
      if (this._sectionId == null) {
        this._sectionId = (await this.client.ensureWeeklyFlowLibrary(this._libraryPath()))?.key ?? null;
      }
      if (this._sectionId == null) throw new Error("Could not create or find the Aurral Plex library");
      await this._loadTracks();
      return playbackOperationSuccess();
    } catch (error) {
      return playbackOperationFailure({
        code: "LIBRARY_SETUP_FAILED",
        message: error?.message || "Could not prepare the Plex library",
        retryable: true,
      });
    }
  }

  async _loadTracks() {
    this._libraryTracks = await this.client.getTracks(this._sectionId);
    this._mainLibraryTracks = null;
    if (!this._mainLibrarySectionId) return;
    try {
      this._mainLibraryTracks = await this.client.getTracks(this._mainLibrarySectionId);
    } catch (error) {
      console.warn(
        "[PlexPlaybackDestination] Failed to read configured main Plex library section:",
        error?.message,
      );
      this._mainLibraryTracks = [];
    }
  }

  _ownerClient(ownerUserId, cache) {
    if (ownerUserId == null) return this.client;
    const key = String(ownerUserId);
    if (cache.has(key)) return cache.get(key);
    const connection = plexConnectionStore.getConnection(ownerUserId);
    if (!connection) {
      cache.set(key, this.client);
      return this.client;
    }
    if (!this.client) {
      cache.set(key, null);
      return null;
    }
    const client = new PlexClient(this.client.url, connection.token, connection.clientId);
    client._machineIdentifier = this.client._machineIdentifier || null;
    cache.set(key, client);
    return client;
  }

  async _recoverManagedUserToken(ownerUserId) {
    const connection = plexConnectionStore.getConnection(ownerUserId);
    if (!connection || connection.linkType !== "managed" || connection.plexAccountId == null) {
      return null;
    }
    if (!this.isConfigured()) return null;
    try {
      const freshToken = await PlexClient.switchHomeUser(
        connection.plexAccountId,
        this.client.token,
        this.client.clientId,
        connection.clientId,
      );
      if (!freshToken) throw new Error("Plex did not return a refreshed token");
      let serverToken = freshToken;
      try {
        const machineIdentifier = await this.client.getMachineIdentifier();
        const { servers } = await PlexClient.getResources(freshToken, connection.clientId);
        const match = (servers || []).find(
          (server) => server.clientIdentifier === machineIdentifier,
        );
        if (match?.accessToken) serverToken = match.accessToken;
      } catch {}
      plexConnectionStore.updateToken(ownerUserId, {
        token: serverToken,
        clientId: connection.clientId,
      });
      const client = new PlexClient(this.client.url, serverToken, connection.clientId);
      client._machineIdentifier = this.client._machineIdentifier || null;
      return client;
    } catch (error) {
      plexConnectionStore.setLastError(ownerUserId, error?.message || "Plex reconnect failed");
      return null;
    }
  }

  async _withOwnerClient(ownerUserId, cache, run) {
    const client = this._ownerClient(ownerUserId, cache);
    try {
      return await run(client);
    } catch (error) {
      if (error?.response?.status !== 401 || client === this.client || ownerUserId == null) {
        throw error;
      }
      const recovered = await this._recoverManagedUserToken(ownerUserId);
      if (recovered) {
        cache.set(String(ownerUserId), recovered);
        try {
          return await run(recovered);
        } catch (retryError) {
          plexConnectionStore.setLastError(
            ownerUserId,
            retryError?.message || "Plex sync failed after reconnect",
          );
          console.warn(
            `[PlexPlaybackDestination] Plex sync skipped for owner ${ownerUserId}: still failing after reconnect`,
          );
          return SYNC_SKIPPED;
        }
      }
      plexConnectionStore.setLastError(ownerUserId, error?.message || "Plex sync failed (401)");
      console.warn(
        `[PlexPlaybackDestination] Plex sync skipped for owner ${ownerUserId}: reconnect needed`,
      );
      return SYNC_SKIPPED;
    }
  }

  _ownerUser(ownerUserId, cache) {
    const key = String(ownerUserId);
    if (!cache.has(key)) cache.set(key, userOps.getUserById(ownerUserId));
    return cache.get(key);
  }

  _ownsGlobalFallback(ownerUserId, owner) {
    if (this._configuredByUserId != null) {
      return Number(ownerUserId) === this._configuredByUserId;
    }
    return !owner || owner.role === "admin";
  }

  _isOwnerBlocked(ownerUserId, clientCache, userCache = new Map()) {
    if (ownerUserId == null) return false;
    if (this._ownerClient(ownerUserId, clientCache) !== this.client) return false;
    if (this._configuredByUserId != null) {
      return Number(ownerUserId) !== this._configuredByUserId;
    }
    const owner = this._ownerUser(ownerUserId, userCache);
    return Boolean(owner) && owner.role !== "admin";
  }

  _title(ownerUserId, desired, clientCache, userCache = new Map()) {
    if (ownerUserId == null) return desired;
    if (this._ownerClient(ownerUserId, clientCache) !== this.client) return desired;
    const owner = this._ownerUser(ownerUserId, userCache);
    if (this._ownsGlobalFallback(ownerUserId, owner)) return desired;
    return `${desired} (${owner?.username || "unlinked"})`;
  }

  _location(ownerUserId) {
    if (ownerUserId == null) return "global";
    const connection = plexConnectionStore.getConnection(ownerUserId);
    if (!connection) return "global";
    return `${connection.linkType}:${connection.plexAccountId ?? connection.plexUuid ?? ownerUserId}`;
  }

  _targetKey(ownerUserId) {
    return String(ownerUserId ?? "global");
  }

  _relativeManagedPath(file) {
    const normalized = String(file || "").replace(/\\/g, "/");
    const marker = `/${PLAYLIST_LIBRARY_DIR}/`;
    const index = normalized.indexOf(marker);
    if (index < 0) return null;
    const segments = normalized.slice(index + marker.length).split("/");
    segments.shift();
    return segments.join("/") || null;
  }

  async _resolveRatingKeys(snapshot) {
    const managedByRelative = new Map();
    for (const track of this._libraryTracks || []) {
      const relative = this._relativeManagedPath(track.files?.[0]);
      if (!relative) continue;
      if (!managedByRelative.has(relative)) managedByRelative.set(relative, []);
      managedByRelative.get(relative).push(track);
    }
    const mainByPath = new Map();
    const mappings = getPathMappings("plex");
    for (const track of this._mainLibraryTracks || []) {
      if (!track.ratingKey) continue;
      for (const file of track.files || []) {
        const localPath = path.resolve(resolveLocalPath(file, mappings));
        if (!mainByPath.has(localPath)) mainByPath.set(localPath, track.ratingKey);
      }
    }
    const keys = [];
    const entityRoot = path.join(this.playlistLibraryRoot, snapshot.entityId);
    for (const track of snapshot.tracks) {
      const localPath = path.resolve(track.path);
      if (!isPathInsideRoot(localPath, this.playlistLibraryRoot)) {
        const ratingKey = mainByPath.get(localPath);
        if (ratingKey) keys.push(ratingKey);
        continue;
      }
      const relative = path.relative(entityRoot, localPath).replace(/\\/g, "/");
      const group = managedByRelative.get(relative) || [];
      const own = group.find((candidate) =>
        candidate.files?.some((file) =>
          String(file).replace(/\\/g, "/").includes(`/${snapshot.entityId}/`),
        ),
      );
      const ratingKey = (own || group[0])?.ratingKey;
      if (ratingKey) keys.push(ratingKey);
    }
    for (const [relative, group] of managedByRelative) {
      try {
        await fs.access(path.join(entityRoot, relative));
      } catch {
        continue;
      }
      const own = group.find((candidate) =>
        candidate.files?.some((file) =>
          String(file).replace(/\\/g, "/").includes(`/${snapshot.entityId}/`),
        ),
      );
      const ratingKey = (own || group[0])?.ratingKey;
      if (ratingKey) keys.push(ratingKey);
    }
    return [...new Set(keys.map(String))];
  }

  _hash(snapshot, ratingKeys, title) {
    const keys = [...ratingKeys].sort().join(",");
    return crypto
      .createHash("sha1")
      .update(`${snapshot.entityId}|${snapshot.ownerUserId ?? "global"}|${title}|${keys}|${snapshot.description || ""}`)
      .digest("hex");
  }

  async _cleanupRelocatedPointer(pointer) {
    if (pointer.location !== "global") return;
    if (!this.client) return;
    try {
      await this.client.deletePlaylist(pointer.ratingKey);
    } catch (error) {
      if (error?.response?.status !== 404) {
        console.warn("[PlexPlaybackDestination] Failed to clean up relocated playlist:", error?.message);
      }
    }
  }

  async _deletePointer(entityId, ownerUserId, pointer, clientCache) {
    const targetKey = this._targetKey(ownerUserId);
    const client = pointer.location === "global"
      ? this.client
      : this._ownerClient(ownerUserId, clientCache);
    if (client === this.client && pointer.location !== "global") {
      plexPlaylistPointerStore.deletePointer(entityId, targetKey);
      return;
    }
    try {
      await client?.deletePlaylist(pointer.ratingKey);
    } catch (error) {
      if (error?.response?.status !== 404) {
        console.warn("[PlexPlaybackDestination] Failed to delete playlist:", error?.message);
      }
    }
    plexPlaylistPointerStore.deletePointer(entityId, targetKey);
  }

  async _deleteCurrent(identity, clientCache = new Map()) {
    const targetKey = this._targetKey(identity.ownerUserId);
    const pointer = plexPlaylistPointerStore.getPointer(identity.entityId, targetKey);
    if (!pointer) return;
    const location = this._location(identity.ownerUserId);
    if (pointer.location === location) {
      await this._withOwnerClient(identity.ownerUserId, clientCache, async (client) => {
        if (!client) return;
        try {
          await client.deletePlaylist(pointer.ratingKey);
        } catch (error) {
          if (error?.response?.status !== 404) throw error;
        }
      });
    } else {
      await this._cleanupRelocatedPointer(pointer);
    }
    plexPlaylistPointerStore.deletePointer(identity.entityId, targetKey);
    this._syncHashes.delete(`${identity.entityId}:${targetKey}`);
  }

  async publishPlaylist(value) {
    try {
      const snapshot = createPlaybackPlaylistSnapshot(value);
      if (!this.isConfigured()) return playbackOperationSuccess();
      if (this._libraryTracks == null) {
        const ensured = await this.ensureLibrary();
        if (!ensured.ok) return ensured;
      }
      if (!this._libraryTracks.length) return playbackOperationSuccess();
      const clientCache = new Map();
      const userCache = new Map();
      if (this._isOwnerBlocked(snapshot.ownerUserId, clientCache, userCache)) {
        await this._deleteCurrent(snapshot, clientCache);
        return playbackOperationSuccess();
      }
      const title = this._title(
        snapshot.ownerUserId,
        snapshot.displayName.trim(),
        clientCache,
        userCache,
      );
      const ratingKeys = await this._resolveRatingKeys(snapshot);
      if (!ratingKeys.length) {
        await this._deleteCurrent(snapshot, clientCache);
        return playbackOperationSuccess();
      }
      const targetKey = this._targetKey(snapshot.ownerUserId);
      const cacheKey = `${snapshot.entityId}:${targetKey}`;
      const hash = this._hash(snapshot, ratingKeys, title);
      if (this._syncHashes.get(cacheKey) === hash) return playbackOperationSuccess();
      const location = this._location(snapshot.ownerUserId);
      const pointer = plexPlaylistPointerStore.getPointer(snapshot.entityId, targetKey);
      if (pointer && pointer.location !== location) await this._cleanupRelocatedPointer(pointer);
      const reusable = pointer?.location === location ? pointer : null;
      const result = await this._withOwnerClient(snapshot.ownerUserId, clientCache, (client) =>
        client.syncPlaylist({
          ratingKey: reusable?.ratingKey ?? null,
          previousTitle: reusable?.title ?? null,
          previousDescription: reusable?.description ?? null,
          title,
          description: snapshot.description || null,
          ratingKeys,
        }),
      );
      if (result === SYNC_SKIPPED) return playbackOperationSuccess();
      if (result?.ratingKey) {
        plexPlaylistPointerStore.setPointer(snapshot.entityId, targetKey, {
          location,
          ratingKey: result.ratingKey,
          title,
          description: snapshot.description || null,
        });
      } else {
        plexPlaylistPointerStore.deletePointer(snapshot.entityId, targetKey);
      }
      this._syncHashes.set(cacheKey, hash);
      return playbackOperationSuccess();
    } catch (error) {
      return playbackOperationFailure({
        code: "PLAYLIST_PUBLISH_FAILED",
        message: error?.message || "Could not publish the Plex playlist",
        retryable: true,
      });
    }
  }

  async deletePlaylist(value) {
    try {
      await this._deleteCurrent(createPlaybackPlaylistIdentity(value));
      return playbackOperationSuccess();
    } catch (error) {
      return playbackOperationFailure({
        code: "PLAYLIST_DELETE_FAILED",
        message: error?.message || "Could not delete the Plex playlist",
        retryable: true,
      });
    }
  }

  async deleteOwnerPlaylists(ownerUserId) {
    const targetKey = this._targetKey(ownerUserId);
    const clientCache = new Map();
    for (const pointer of plexPlaylistPointerStore.getPointersForTarget(targetKey)) {
      await this._deletePointer(pointer.entityId, ownerUserId, pointer, clientCache);
    }
  }

  async deleteEntityPlaylists(entityId) {
    const clientCache = new Map();
    for (const pointer of plexPlaylistPointerStore.getPointersForEntity(entityId)) {
      const ownerUserId = pointer.targetKey === "global" ? null : Number(pointer.targetKey);
      await this._deletePointer(entityId, ownerUserId, pointer, clientCache);
    }
  }

  async requestScan() {
    if (!this.isConfigured()) return playbackOperationSuccess();
    try {
      const ensured = await this.ensureLibrary();
      if (!ensured.ok) return ensured;
      await this.client.scanLibrary(this._sectionId);
      return playbackOperationSuccess();
    } catch (error) {
      return playbackOperationFailure({
        code: "SCAN_FAILED",
        message: error?.message || "Could not scan the Plex library",
        retryable: true,
      });
    }
  }

  async syncNow(snapshots, loadSnapshots) {
    if (!this.isConfigured()) return { configured: false };
    const ensured = await this.ensureLibrary();
    if (!ensured.ok) throw new Error(ensured.error.message);
    await this.client.scanLibrary(this._sectionId);
    this._syncHashes.clear();
    await this._loadTracks();
    for (const snapshot of snapshots) {
      const result = await this.publishPlaylist(snapshot);
      if (!result.ok) throw new Error(result.error.message);
    }
    const playlists = await this.client.getPlaylists();
    const clientCache = new Map();
    const userCache = new Map();
    const managedNames = new Set(
      snapshots
        .filter((snapshot) => !this._isOwnerBlocked(snapshot.ownerUserId, clientCache, userCache))
        .map((snapshot) =>
          this._title(snapshot.ownerUserId, snapshot.displayName, clientCache, userCache),
        ),
    );
    this._scheduleCatchup(loadSnapshots);
    return {
      configured: true,
      sectionId: this._sectionId,
      indexedTracks: this._libraryTracks.length,
      scanInProgress: this._libraryTracks.length === 0,
      playlists: playlists
        .filter((playlist) => managedNames.has(playlist.title))
        .map((playlist) => ({ title: playlist.title, count: playlist.leafCount ?? null })),
    };
  }

  _scheduleCatchup(loadSnapshots, delaysMs = [30000, 90000, 180000]) {
    if (this._catchupRunning || typeof loadSnapshots !== "function") return;
    this._catchupRunning = true;
    const run = async () => {
      try {
        for (const delay of delaysMs) {
          await new Promise((resolve) => setTimeout(resolve, delay));
          if (!this.isConfigured()) break;
          await this._loadTracks();
          for (const snapshot of await loadSnapshots()) await this.publishPlaylist(snapshot);
        }
      } catch (error) {
        console.warn("[PlexPlaybackDestination] Plex catch-up failed:", error?.message);
      } finally {
        this._catchupRunning = false;
      }
    };
    run();
  }
}
