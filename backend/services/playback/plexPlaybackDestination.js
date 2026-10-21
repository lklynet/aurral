import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { userOps } from "../../db/helpers/index.js";
import { PlexClient } from "../plex.js";
import { plexConnectionStore } from "../plex/plexConnectionStore.js";
import { plexPlaylistPointerStore } from "../plex/plexPlaylistPointerStore.js";
import { isPlaybackRetainedFile } from "./playbackFileRetention.js";
import { getPathMappings, normalizePathSeparators, resolveLocalPath } from "../pathMappings.js";
import { isPathWithin } from "../libraryFolders.js";
import { joinServerPath } from "./playbackScanFolders.js";
import { AURRAL_FLOWS_DIR, isPathInsideRoot, resolveDownloadRoot } from "../downloadPaths.js";
import {
  createPlaybackPlaylistIdentity,
  createPlaybackPlaylistSnapshot,
  isRetryablePlaybackError,
  playbackOperationFailure,
  playbackOperationSuccess,
} from "./playbackDestination.js";

const SYNC_SKIPPED = Symbol("plex-sync-skipped");
const MAX_PLEX_FOLDER_REFRESHES = 20;
const ADDED_AT_OVERLAP_SECONDS = 300;
const FULL_READ_INTERVAL_MS = 30_000;
const SCAN_SETTLE_MS = 90_000;

const isWithinAny = (folders, candidate) =>
  folders.some((folder) => isPathWithin(folder, candidate));
const modifiedAt = (stats) => Math.floor(stats.mtimeMs / 1000);
const isStale = (entry, stats) =>
  Boolean(stats) &&
  modifiedAt(stats) > entry.addedAt &&
  entry.confirmedAt < modifiedAt(stats) + SCAN_SETTLE_MS / 1000;
const changedRecently = (stats) =>
  Boolean(stats) && Date.now() < modifiedAt(stats) * 1000 + SCAN_SETTLE_MS;
const currentRatingKey = (entry, stats) => (isStale(entry, stats) ? null : entry.ratingKey);

export const plexSettings = Object.freeze({
  key: "plex",
  label: "Plex",
  subtitle: "Plexamp",
  customUi: "plex",
  fields: Object.freeze([
    Object.freeze({ key: "url", label: "Server URL", type: "url", required: true }),
    Object.freeze({
      key: "token",
      label: "Account token",
      type: "password",
      secret: true,
      hidden: true,
    }),
  ]),
  defaults: Object.freeze({ url: "", token: "" }),
  validation: Object.freeze({ required: ["url"], url: ["url"] }),
  testConnection: true,
});

export class PlexPlaybackDestination {
  constructor(downloadRoot = resolveDownloadRoot(), { client = null } = {}) {
    this.key = "plex";
    this.name = "Plex";
    this.downloadRoot = resolveDownloadRoot(downloadRoot);
    this.playlistFilesRoot = this.downloadRoot;
    this.client = client;
    this._configKey = "";
    this._downloadsPath = "";
    this._mainLibrarySectionId = "";
    this._configuredByUserId = null;
    this._sectionId = null;
    this._sectionPath = null;
    this._indexes = new Map();
    this._fullReadAt = new Map();
    this._readErrors = new Map();
    this._mainRoots = null;
    this._recentScans = [];
    this._syncHashes = new Map();
  }

  updateConfig(config = {}) {
    const key = JSON.stringify({
      url: config.url || "",
      token: config.token || "",
      clientId: config.clientId || "",
      downloadsPath: config.downloadsPath || "",
      mainLibrarySectionId: config.mainLibrarySectionId || "",
      configuredByUserId: config.configuredByUserId ?? null,
      pathMappings: getPathMappings("plex"),
    });
    if (key === this._configKey) return;
    this._configKey = key;
    this._downloadsPath = config.downloadsPath || "";
    this._mainLibrarySectionId = String(config.mainLibrarySectionId || "").trim();
    this._configuredByUserId =
      config.configuredByUserId != null ? Number(config.configuredByUserId) : null;
    this.client =
      config.url && config.token ? new PlexClient(config.url, config.token, config.clientId) : null;
    this._sectionId = null;
    this._sectionPath = null;
    this._indexes = new Map();
    this._fullReadAt = new Map();
    this._readErrors = new Map();
    this._mainRoots = null;
    this._recentScans = [];
    this._syncHashes.clear();
  }

  isConfigured() {
    return Boolean(this.client?.isConfigured());
  }

  async getReferencedPaths({ excludeEntityIds = [] } = {}) {
    const excluded = new Set(
      excludeEntityIds.flatMap((id) =>
        plexPlaylistPointerStore.getPointersForEntity(id).map((pointer) => pointer.ratingKey),
      ),
    );
    const clients = new Map([[this.client.token, this.client]]);
    const cache = new Map();
    for (const user of userOps.getAllUsers()) {
      const client = this._ownerClient(user.id, cache);
      if (client) clients.set(client.token, client);
    }
    const paths = new Set();
    for (const client of clients.values()) {
      for (const file of await client.getPlaylistTrackPaths(excluded)) {
        const relative = this._relativeManagedPath(file);
        paths.add(
          relative == null
            ? resolveLocalPath(file, getPathMappings("plex"))
            : path.resolve(this.downloadRoot, relative),
        );
      }
    }
    return { ok: true, paths: [...paths] };
  }

  _libraryPath() {
    const override = String(this._downloadsPath || "").trim();
    return (override || this.downloadRoot).replace(/\\/g, "/").replace(/\/+$/, "");
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
        retryable: isRetryablePlaybackError(error),
      });
    }
  }

  async _ensureSection() {
    if (this._sectionId == null) {
      const libraryPath = this._libraryPath();
      const section = await this.client.ensureAurralLibrary(libraryPath);
      this._sectionId = section?.key ?? null;
      this._sectionPath =
        (section?.Location || [])
          .map((location) => location?.path)
          .find(
            (location) =>
              location &&
              normalizePathSeparators(location).toLowerCase() === libraryPath.toLowerCase(),
          ) ?? null;
    }
    if (this._sectionId == null)
      throw new Error("Could not create or find the Aurral Plex library");
  }

  async ensureLibrary({ full = false } = {}) {
    if (!this.isConfigured()) return playbackOperationSuccess();
    const read = full ? { full: true } : {};
    try {
      await this._ensureSection();
      await this._readSection("managed", read);
    } catch (error) {
      return playbackOperationFailure({
        code: "LIBRARY_SETUP_FAILED",
        message: error?.message || "Could not prepare the Plex library",
        retryable: isRetryablePlaybackError(error),
      });
    }
    if (this._mainLibrarySectionId) {
      try {
        await this._readSection("main", read);
      } catch (error) {
        console.warn(
          "[PlexPlaybackDestination] Failed to read configured main Plex library section:",
          error?.message,
        );
      }
    }
    return playbackOperationSuccess();
  }

  _indexPath(role, file) {
    if (role === "main") return path.resolve(resolveLocalPath(file, getPathMappings("plex")));
    const relative = this._relativeManagedPath(file);
    return relative ? path.resolve(this.downloadRoot, relative) : null;
  }

  async _readSection(role, { full = !this._indexes.has(role) } = {}) {
    const sectionId = role === "main" ? this._mainLibrarySectionId : this._sectionId;
    const current = this._indexes.get(role);
    const readAt = Date.now();
    if (full) this._fullReadAt.set(role, readAt);
    try {
      const [tracks, mainRoots] = await Promise.all([
        this.client.getTracks(
          sectionId,
          full ? {} : { addedSince: Math.max(0, current.watermark - ADDED_AT_OVERLAP_SECONDS) },
        ),
        full && role === "main" ? this._readMainRoots() : this._mainRoots,
      ]);
      const index = full ? { byPath: new Map(), watermark: 0, hasTracks: false } : current;
      index.hasTracks ||= tracks.some((track) => track.ratingKey);
      for (const track of tracks) {
        if (!track.ratingKey) continue;
        const ratingKey = String(track.ratingKey);
        index.watermark = Math.max(index.watermark, track.addedAt);
        for (const file of track.files || []) {
          const localPath = this._indexPath(role, file);
          if (!localPath) continue;
          const known = index.byPath.get(localPath);
          if (!known || track.addedAt >= known.addedAt) {
            index.byPath.set(localPath, {
              ratingKey,
              addedAt: track.addedAt,
              confirmedAt: Math.floor(readAt / 1000),
            });
          }
        }
      }
      this._indexes.set(role, index);
      if (role === "main") this._mainRoots = mainRoots;
      if (full || !this._readErrors.get(role)?.full) this._readErrors.delete(role);
    } catch (error) {
      this._readErrors.set(role, { error, full });
      throw error;
    }
  }

  async _readMainRoots() {
    try {
      const section = (await this.client.getLibraries()).find(
        (library) => String(library?.key) === this._mainLibrarySectionId,
      );
      const mappings = getPathMappings("plex");
      return (section?.Location || [])
        .map((location) => location?.path)
        .filter(Boolean)
        .map((location) => path.resolve(resolveLocalPath(location, mappings)));
    } catch {
      return null;
    }
  }

  _holder(trackPath) {
    if (isPathInsideRoot(trackPath, this.downloadRoot)) return "managed";
    if (!this._mainLibrarySectionId) return null;
    return this._mainRoots == null || isWithinAny(this._mainRoots, trackPath) ? "main" : null;
  }

  _recentlyScannedFolders() {
    const now = Date.now();
    this._recentScans = this._recentScans.filter((scan) => scan.until > now);
    return this._recentScans.map((scan) => scan.folder);
  }

  async _noteScannedFolders(folders) {
    const until = Date.now() + SCAN_SETTLE_MS;
    this._recentScans = [
      ...this._recentScans.filter((scan) => scan.until > Date.now()),
      ...folders.map((folder) => ({ folder, until })),
    ];
    for (const index of this._indexes.values()) {
      for (const localPath of [...index.byPath.keys()]) {
        if (!isWithinAny(folders, localPath)) continue;
        if (!(await fs.stat(localPath).catch(() => null))) index.byPath.delete(localPath);
      }
    }
  }

  async _flowLinks(entityId) {
    const entityRoot = path.join(this.downloadRoot, AURRAL_FLOWS_DIR, entityId);
    const links = [];
    for (const [localPath, entry] of this._indexes.get("managed")?.byPath ?? []) {
      if (!isPathInsideRoot(localPath, entityRoot) || isPlaybackRetainedFile(localPath)) continue;
      const stats = await fs.stat(localPath).catch(() => null);
      if (!stats) continue;
      const ratingKey = currentRatingKey(entry, stats);
      links.push({
        ratingKey,
        file: `${stats.dev}:${stats.ino}`,
        localPath,
        role: "managed",
        settling: !ratingKey && changedRecently(stats),
      });
    }
    return links;
  }

  async _resolveTrack(localPath, links) {
    const stats = await fs.stat(localPath).catch(() => null);
    const fromEntry = (entry, role) => {
      const ratingKey = currentRatingKey(entry, stats);
      return { ratingKey, role, settling: !ratingKey && changedRecently(stats) };
    };
    const managed = this._indexes.get("managed")?.byPath.get(localPath);
    if (managed) return fromEntry(managed, "managed");
    const link = stats && links.find((candidate) => candidate.file === `${stats.dev}:${stats.ino}`);
    if (link) return { ratingKey: link.ratingKey, role: "managed", settling: link.settling };
    const main = this._indexes.get("main")?.byPath.get(localPath);
    if (main) return fromEntry(main, "main");
    return { ratingKey: null, role: this._holder(localPath) };
  }

  async _resolveTracks(snapshot, pendingFolders) {
    const links = await this._flowLinks(snapshot.entityId);
    const settling = [...pendingFolders, ...this._recentlyScannedFolders()];
    const tracks = [];
    for (const track of snapshot.tracks) {
      const localPath = path.resolve(track.path);
      const resolved = await this._resolveTrack(localPath, links);
      tracks.push({
        ...resolved,
        settling: resolved.settling || (!resolved.ratingKey && isWithinAny(settling, localPath)),
      });
    }
    for (const link of links) {
      if (!link.ratingKey)
        tracks.push({ ...link, settling: link.settling || isWithinAny(settling, link.localPath) });
    }
    const used = new Set(tracks.map((track) => track.ratingKey));
    const ratingKeys = [
      ...tracks.map((track) => track.ratingKey).filter(Boolean),
      ...links
        .map((link) => link.ratingKey)
        .filter((ratingKey) => ratingKey && !used.has(ratingKey)),
    ];
    return {
      tracks,
      ratingKeys: [...new Set(ratingKeys)],
      missing: tracks.filter((track) => !track.ratingKey),
    };
  }

  async _resolveWithRereads(snapshot, pendingFolders) {
    const resolved = await this._resolveTracks(snapshot, pendingFolders);
    const roles = new Set([
      ...resolved.missing
        .filter((track) => !track.settling && track.role)
        .map((track) => track.role),
      ...[...this._readErrors].filter(([, readError]) => readError.full).map(([role]) => role),
    ]);
    let reread = false;
    for (const role of roles) {
      if (Date.now() - (this._fullReadAt.get(role) ?? 0) < FULL_READ_INTERVAL_MS) continue;
      reread = true;
      try {
        await this._readSection(role, { full: true });
      } catch (error) {
        console.warn(
          `[PlexPlaybackDestination] Failed to re-read the ${role} Plex library section:`,
          error?.message,
        );
      }
    }
    const result = reread ? await this._resolveTracks(snapshot, pendingFolders) : resolved;
    const blocked = result.tracks.map((track) => this._readErrors.get(track.role)).find(Boolean);
    if (blocked) throw blocked.error;
    return result;
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
    const root = this._libraryPath();
    const marker = `${root}/`;
    if (!normalized.startsWith(marker)) return null;
    const relative = normalized.slice(marker.length);
    const normalizedRelative = path.posix.normalize(relative);
    if (
      !normalizedRelative ||
      normalizedRelative === "." ||
      normalizedRelative === ".." ||
      normalizedRelative.startsWith("../") ||
      path.posix.isAbsolute(normalizedRelative)
    ) {
      return null;
    }
    return normalizedRelative;
  }

  _hash(snapshot, ratingKeys, title) {
    const keys = [...ratingKeys].sort().join(",");
    return crypto
      .createHash("sha256")
      .update(
        `${snapshot.entityId}|${snapshot.ownerUserId ?? "global"}|${title}|${keys}|${snapshot.description || ""}`,
      )
      .digest("hex");
  }

  async _cleanupRelocatedPointer(pointer) {
    if (pointer.location !== "global") return;
    if (!this.client) return;
    try {
      await this.client.deletePlaylist(pointer.ratingKey);
    } catch (error) {
      if (error?.response?.status !== 404) {
        console.warn(
          "[PlexPlaybackDestination] Failed to clean up relocated playlist:",
          error?.message,
        );
      }
    }
  }

  async _deletePointer(entityId, ownerUserId, pointer, clientCache) {
    const targetKey = this._targetKey(ownerUserId);
    const client =
      pointer.location === "global" ? this.client : this._ownerClient(ownerUserId, clientCache);
    if (client === this.client && pointer.location !== "global") {
      plexPlaylistPointerStore.deletePointer(entityId, targetKey);
      return;
    }
    try {
      await client?.deletePlaylist(pointer.ratingKey);
    } catch (error) {
      if (error?.response?.status !== 404) throw error;
    }
    plexPlaylistPointerStore.deletePointer(entityId, targetKey);
    this._syncHashes.delete(`${entityId}:${targetKey}`);
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

  async publishPlaylist(value, { pendingScanFolders = new Map() } = {}) {
    try {
      const snapshot = createPlaybackPlaylistSnapshot(value);
      if (!this.isConfigured()) return playbackOperationSuccess();
      if (!this._indexes.has("managed")) {
        const ensured = await this.ensureLibrary();
        if (!ensured.ok) return ensured;
      }
      if (!this._indexes.get("managed").hasTracks) {
        return playbackOperationSuccess({ pending: snapshot.tracks.length > 0 });
      }
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
      const { ratingKeys, missing } = await this._resolveWithRereads(
        snapshot,
        pendingScanFolders.get(this.key) ?? [],
      );
      const pending = missing.length > 0;
      if (!ratingKeys.length) {
        if (!missing.some((track) => track.settling))
          await this._deleteCurrent(snapshot, clientCache);
        return playbackOperationSuccess({ pending });
      }
      const targetKey = this._targetKey(snapshot.ownerUserId);
      const cacheKey = `${snapshot.entityId}:${targetKey}`;
      const hash = this._hash(snapshot, ratingKeys, title);
      const pointer = plexPlaylistPointerStore.getPointer(snapshot.entityId, targetKey);
      if (pointer && this._syncHashes.get(cacheKey) === hash)
        return playbackOperationSuccess({ pending });
      const location = this._location(snapshot.ownerUserId);
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
      if (result === SYNC_SKIPPED) return playbackOperationSuccess({ pending });
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
      return playbackOperationSuccess({ pending });
    } catch (error) {
      return playbackOperationFailure({
        code: "PLAYLIST_PUBLISH_FAILED",
        message: error?.message || "Could not publish the Plex playlist",
        retryable: isRetryablePlaybackError(error),
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
        retryable: isRetryablePlaybackError(error),
      });
    }
  }

  async deleteOwnerPlaylists(ownerUserId, connection = null) {
    const targetKey = this._targetKey(ownerUserId);
    const clientCache = new Map();
    if (connection && this.client) {
      const client = new PlexClient(this.client.url, connection.token, connection.clientId);
      client._machineIdentifier = this.client._machineIdentifier || null;
      clientCache.set(String(ownerUserId), client);
    }
    for (const pointer of plexPlaylistPointerStore.getPointersForTarget(targetKey)) {
      try {
        await this._deletePointer(pointer.entityId, ownerUserId, pointer, clientCache);
      } catch (error) {
        console.warn("[PlexPlaybackDestination] Failed to delete playlist:", error?.message);
        plexPlaylistPointerStore.deletePointer(pointer.entityId, targetKey);
      }
    }
  }

  getPointerEntityIds() {
    return plexPlaylistPointerStore.getEntityIds();
  }

  async deleteEntityPlaylists(entityId) {
    try {
      const clientCache = new Map();
      for (const pointer of plexPlaylistPointerStore.getPointersForEntity(entityId)) {
        const ownerUserId = pointer.targetKey === "global" ? null : Number(pointer.targetKey);
        await this._deletePointer(entityId, ownerUserId, pointer, clientCache);
      }
      return playbackOperationSuccess();
    } catch (error) {
      return playbackOperationFailure({
        code: "PLAYLIST_DELETE_FAILED",
        message: error?.message || "Could not delete the Plex playlist",
        retryable: isRetryablePlaybackError(error),
      });
    }
  }

  _relativeScanFolders(folders) {
    const relativeFolders = [];
    for (const folder of folders) {
      if (!isPathWithin(this.downloadRoot, folder)) continue;
      const relative = path.relative(this.downloadRoot, folder);
      if (!relative) return null;
      relativeFolders.push(relative);
    }
    return relativeFolders.length > MAX_PLEX_FOLDER_REFRESHES ? null : relativeFolders;
  }

  async requestScan({ folders }) {
    if (!this.isConfigured()) return playbackOperationSuccess();
    await this._noteScannedFolders(folders);
    const relativeFolders = this._relativeScanFolders(folders);
    if (relativeFolders?.length === 0) return playbackOperationSuccess();
    try {
      await this._ensureSection();
      if (relativeFolders) {
        const sectionPath = this._sectionPath ?? this._libraryPath();
        for (const relative of relativeFolders) {
          await this.client.scanLibrary(this._sectionId, joinServerPath(sectionPath, relative));
        }
      } else {
        await this.client.scanLibrary(this._sectionId);
      }
      return playbackOperationSuccess();
    } catch (error) {
      return playbackOperationFailure({
        code: "SCAN_FAILED",
        message: error?.message || "Could not scan the Plex library",
        retryable: isRetryablePlaybackError(error),
      });
    }
  }

  async syncNow(snapshots) {
    if (!this.isConfigured()) return { configured: false };
    const ensured = await this.ensureLibrary({ full: true });
    if (!ensured.ok) throw new Error(ensured.error.message);
    await this.client.scanLibrary(this._sectionId);
    this._syncHashes.clear();
    const pendingEntityIds = [];
    for (const snapshot of snapshots) {
      const result = await this.publishPlaylist(snapshot);
      if (!result.ok) throw new Error(result.error.message);
      if (result.pending) pendingEntityIds.push(snapshot.entityId);
    }
    const playlists = await this.client.getPlaylists();
    const clientCache = new Map();
    const userCache = new Map();
    const indexedTracks = this._indexes.get("managed").byPath.size;
    const managedNames = new Set(
      snapshots
        .filter((snapshot) => !this._isOwnerBlocked(snapshot.ownerUserId, clientCache, userCache))
        .map((snapshot) =>
          this._title(snapshot.ownerUserId, snapshot.displayName, clientCache, userCache),
        ),
    );
    return {
      pendingEntityIds,
      configured: true,
      sectionId: this._sectionId,
      indexedTracks,
      scanInProgress: indexedTracks === 0,
      playlists: playlists
        .filter((playlist) => managedNames.has(playlist.title))
        .map((playlist) => ({ title: playlist.title, count: playlist.leafCount ?? null })),
    };
  }
}
