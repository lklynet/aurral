import path from "path";
import fs from "fs/promises";
import crypto from "crypto";
import { dbOps, userOps } from "../../db/helpers/index.js";
import { PlexClient } from "../plex.js";
import { flowPlaylistConfig } from "./weeklyFlowPlaylistConfig.js";
import { downloadTracker } from "./weeklyFlowDownloadTracker.js";
import { writePlaylistArtworkWebpFromBuffer } from "../playlistArtwork.js";
import {
  getArtworkExtensionForStyle,
  getPlaylistArtworkStyle,
  writeGeneratedPlaylistArtwork,
} from "../playlistArtworkGenerator.js";
import {
  PLAYLIST_LIBRARY_DIR,
  isPathInsideRoot,
  remapLegacyPath,
  resolvePlaylistRoot,
} from "../playlistPaths.js";
import { scheduleLibraryScan } from "../libraryScanWorker.js";
import { ytdlpClient } from "../ytdlpClient.js";
import { plexConnectionStore } from "../plex/plexConnectionStore.js";
import { plexPlaylistPointerStore } from "../plex/plexPlaylistPointerStore.js";
import { getPathMappings, resolveLocalPath } from "../pathMappings.js";
import {
  recoverManagedUserToken,
  resolvePlexClientForOwner,
} from "./weeklyFlowPlexOwnerClients.js";
import {
  assertPlaybackDestination,
  createPlaybackPlaylistIdentity,
  createPlaybackPlaylistSnapshot,
} from "../playback/playbackDestination.js";
import { collectPlaybackPlaylistTracks } from "../playback/playbackPlaylistTracks.js";
import { NavidromePlaybackDestination } from "../playback/navidromePlaybackDestination.js";

const PLEX_SYNC_SKIPPED = Symbol("plex-sync-skipped");
const ARTWORK_FILE_EXTENSIONS = [".webp", ".jpg", ".png"];
const ARTWORK_SUPPRESS_SUFFIX = ".no-artwork";

export class WeeklyFlowPlaylistManager {
  constructor(
    weeklyFlowRoot = resolvePlaylistRoot(),
    { triggerEnsureOnInit = process.env.NODE_ENV !== "test" } = {},
  ) {
    this.weeklyFlowRoot = resolvePlaylistRoot(weeklyFlowRoot);
    this.playlistLibraryRoot = path.join(this.weeklyFlowRoot, PLAYLIST_LIBRARY_DIR);
    this.libraryRoot = path.join(this.playlistLibraryRoot, "_playlists");
    this.navidromeDestination = assertPlaybackDestination(
      new NavidromePlaybackDestination(this.weeklyFlowRoot),
    );
    this.plexClient = null;
    this._plexConfigKey = "";
    this._plexSectionId = null;
    this._plexSyncHashes = new Map();
    this._plexCatchupRunning = false;
    this._ensureInFlight = null;
    this._refreshInFlight = new Map();
    this.updateConfig(triggerEnsureOnInit);
  }

  updateConfig(triggerEnsurePlaylists = true) {
    const settings = dbOps.getSettings();
    const navidromeConfig = settings.integrations?.navidrome || {};
    this.navidromeDestination.updateConfig(navidromeConfig);

    const plexConfig = settings.integrations?.plex || {};
    const nextPlexKey = JSON.stringify({
      url: plexConfig.url || "",
      token: plexConfig.token || "",
      clientId: plexConfig.clientId || "",
      downloadsPath: plexConfig.downloadsPath || "",
    });
    const plexChanged = this._plexConfigKey !== nextPlexKey;
    this._plexConfigKey = nextPlexKey;
    this._plexDownloadsPath = plexConfig.downloadsPath || "";
    this._plexMainLibrarySectionId = String(plexConfig.mainLibrarySectionId || "").trim();
    this._plexConfiguredByUserId =
      plexConfig.configuredByUserId != null ? Number(plexConfig.configuredByUserId) : null;
    if (plexConfig.url && plexConfig.token) {
      if (!this.plexClient || plexChanged) {
        this.plexClient = new PlexClient(plexConfig.url, plexConfig.token, plexConfig.clientId);
        this._plexSectionId = null;
        this._plexSyncHashes.clear();
      }
    } else {
      this.plexClient = null;
      this._plexSectionId = null;
      this._plexSyncHashes.clear();
    }

    if (triggerEnsurePlaylists) {
      this.ensurePlaylists().catch((err) =>
        console.warn("[WeeklyFlowPlaylistManager] ensurePlaylists on config:", err?.message),
      );
    }
  }

  _sanitize(str) {
    return String(str || "")
      .replace(/[<>:"/\\|?*]/g, "_")
      .trim();
  }

  _getPlaylistLibraryHostPath() {
    return this.playlistLibraryRoot.replace(/\\/g, "/").replace(/\/+$/, "");
  }

  _getPlaylistBaseName(playlistName) {
    return this._sanitize(playlistName);
  }

  async ensurePlaylists() {
    if (this._ensureInFlight) {
      return this._ensureInFlight;
    }
    this._ensureInFlight = this._ensurePlaylistsInternal();
    try {
      return await this._ensureInFlight;
    } finally {
      this._ensureInFlight = null;
    }
  }

  async ensureSmartPlaylists() {
    return this.ensurePlaylists();
  }

  async refreshPlaylist(playlistType) {
    const key = String(playlistType || "");
    if (this._refreshInFlight.has(key)) {
      return this._refreshInFlight.get(key);
    }
    const task = this._refreshPlaylistInternal(playlistType).finally(() => {
      this._refreshInFlight.delete(key);
    });
    this._refreshInFlight.set(key, task);
    return task;
  }

  async _refreshPlaylistInternal(playlistType) {
    const flow = flowPlaylistConfig.getFlow(playlistType);
    if (flow) {
      if (!flow.enabled) return null;
      return this._publishNavidromePlaylist(flow, "Flow");
    }
    const sharedPlaylist = flowPlaylistConfig.getSharedPlaylist(playlistType);
    if (!sharedPlaylist) return null;
    return this._publishNavidromePlaylist(sharedPlaylist, "Playlist");
  }

  scheduleScanLibrary(force = false) {
    return scheduleLibraryScan(force);
  }

  async _ensureFlowArtwork(playlistType, playlistName, artworkKind) {
    await fs.mkdir(this.libraryRoot, { recursive: true });
    const baseName = this._getPlaylistBaseName(playlistName);
    const artworkExtension = getArtworkExtensionForStyle(getPlaylistArtworkStyle());
    const artworkPath = path.join(this.libraryRoot, `${baseName}${artworkExtension}`);
    const safeRoot = path.resolve(this.libraryRoot);
    const suppressed = await this._isArtworkGenerationSuppressed(safeRoot, baseName);
    if (!(await this._playlistArtworkExists(baseName)) && !suppressed) {
      const artworkContext = this.getArtworkContextForPlaylistId(playlistType);
      await writeGeneratedPlaylistArtwork({
        outputPath: artworkPath,
        title: artworkContext?.title || playlistName,
        kind: artworkContext?.kind || artworkKind,
      });
    }
  }

  async _createPlaybackSnapshot(entity) {
    const tracks = await collectPlaybackPlaylistTracks(entity.id, {
      weeklyFlowRoot: this.weeklyFlowRoot,
    });
    return createPlaybackPlaylistSnapshot({
      entityId: entity.id,
      ownerUserId: entity.ownerUserId ?? null,
      displayName: entity.name,
      description: entity.description || null,
      tracks,
    });
  }

  async _publishNavidromePlaylist(entity, artworkKind) {
    const snapshot = await this._createPlaybackSnapshot(entity);
    const result = await this.navidromeDestination.publishPlaylist(snapshot);
    if (!result.ok) throw new Error(result.error.message);
    const playlistName = this.navidromeDestination.getPlaylistName(snapshot);
    await this._ensureFlowArtwork(entity.id, playlistName, artworkKind);
    return result;
  }

  async _ensurePlaylistsInternal() {
    const flows = flowPlaylistConfig.getFlows();
    const sharedPlaylists = flowPlaylistConfig.getSharedPlaylists();
    const syncEntity = async (entityId, run) => {
      try {
        await run();
      } catch (err) {
        console.warn(
          `[WeeklyFlowPlaylistManager] Navidrome sync failed for ${entityId}:`,
          err?.message,
        );
      }
    };
    try {
      const ensured = await this.navidromeDestination.ensureLibrary();
      if (!ensured.ok) throw new Error(ensured.error.message);
    } catch (err) {
      console.warn("[WeeklyFlowPlaylistManager] Navidrome library setup failed:", err?.message);
    }
    for (const flow of flows) {
      await syncEntity(flow.id, async () => {
        if (flow.enabled) {
          await this._publishNavidromePlaylist(flow, "Flow");
          return;
        }
        const deleted = await this.navidromeDestination.deletePlaylist(
          createPlaybackPlaylistIdentity({
            entityId: flow.id,
            ownerUserId: flow.ownerUserId ?? null,
          }),
        );
        if (!deleted.ok) throw new Error(deleted.error.message);
        const playlistName = this.navidromeDestination.getPlaylistName({
          entityId: flow.id,
          ownerUserId: flow.ownerUserId ?? null,
          displayName: flow.name,
        });
        await this._ensureFlowArtwork(flow.id, playlistName, "Flow");
      });
    }
    for (const playlist of sharedPlaylists) {
      await syncEntity(playlist.id, () => this._publishNavidromePlaylist(playlist, "Playlist"));
    }

    if (this.plexClient?.isConfigured()) {
      try {
        await this._syncPlexPlaylists(flows, sharedPlaylists);
      } catch (err) {
        console.warn("[WeeklyFlowPlaylistManager] Plex playlist sync failed:", err?.message);
      }
    }
  }

  // The location must be the path the Plex server uses, which differs from
  // Aurral's host path when Plex runs in its own container.
  _getPlexLibraryPath() {
    const override = String(this._plexDownloadsPath || "").trim();
    if (override) {
      const base = override.replace(/\\/g, "/").replace(/\/+$/, "");
      return `${base}/${PLAYLIST_LIBRARY_DIR}`;
    }
    return this._getPlaylistLibraryHostPath();
  }

  _hashKeys(ratingKeys) {
    const sorted = (ratingKeys || []).map(String).sort();
    return crypto.createHash("sha1").update(sorted.join(",")).digest("hex");
  }

  async _ensurePlexSectionId() {
    if (this._plexSectionId != null) return this._plexSectionId;
    const libraryPath = this._getPlexLibraryPath();
    const library = await this.plexClient.ensureWeeklyFlowLibrary(libraryPath);
    // Plex section objects expose the section id as `key`.
    const id = library?.key ?? null;
    this._plexSectionId = id;
    return id;
  }

  async _withOwnerPlexClient(ownerUserId, ownerClientCache, fn) {
    const client = resolvePlexClientForOwner(this.plexClient, ownerUserId, ownerClientCache);
    try {
      return await fn(client);
    } catch (error) {
      if (error?.response?.status !== 401 || client === this.plexClient || ownerUserId == null) {
        throw error;
      }
      const recovered = await recoverManagedUserToken(ownerUserId, this.plexClient);
      if (recovered) {
        ownerClientCache.set(String(ownerUserId), recovered);
        try {
          return await fn(recovered);
        } catch (retryError) {
          plexConnectionStore.setLastError(
            ownerUserId,
            retryError?.message || "Plex sync failed after reconnect",
          );
          console.warn(
            `[WeeklyFlowPlaylistManager] Plex sync skipped for owner ${ownerUserId}: still failing after reconnect`,
          );
          return PLEX_SYNC_SKIPPED;
        }
      }
      plexConnectionStore.setLastError(ownerUserId, error?.message || "Plex sync failed (401)");
      console.warn(
        `[WeeklyFlowPlaylistManager] Plex sync skipped for owner ${ownerUserId}: reconnect needed`,
      );
      return PLEX_SYNC_SKIPPED;
    }
  }

  _getCachedOwnerUser(ownerUserId, ownerUserCache) {
    const key = String(ownerUserId);
    if (ownerUserCache.has(key)) return ownerUserCache.get(key);
    const owner = userOps.getUserById(ownerUserId);
    ownerUserCache.set(key, owner);
    return owner;
  }

  // Whether this owner is the one whose Plex identity the shared/global
  // connection resolves to. Once an admin has actually connected the global
  // Plex account (configuredByUserId set), only they get the fallback -
  // every other owner, admin or not, must link their own account. Installs
  // that haven't reconnected since this existed fall back to the legacy
  // any-admin rule.
  _ownsGlobalPlexFallback(ownerUserId, owner) {
    if (this._plexConfiguredByUserId != null) {
      return Number(ownerUserId) === this._plexConfiguredByUserId;
    }
    return !owner || owner.role === "admin";
  }

  _resolveOwnerPlexTitle(ownerUserId, desired, ownerClientCache, ownerUserCache = new Map()) {
    if (ownerUserId == null) return desired;
    const client = resolvePlexClientForOwner(this.plexClient, ownerUserId, ownerClientCache);
    if (client !== this.plexClient) return desired;
    const owner = this._getCachedOwnerUser(ownerUserId, ownerUserCache);
    if (this._ownsGlobalPlexFallback(ownerUserId, owner)) return desired;
    return `${desired} (${owner?.username || "unlinked"})`;
  }

  _isOwnerPlexSyncBlocked(ownerUserId, ownerClientCache, ownerUserCache = new Map()) {
    if (ownerUserId == null) return false;
    const client = resolvePlexClientForOwner(this.plexClient, ownerUserId, ownerClientCache);
    if (client !== this.plexClient) return false;
    if (this._plexConfiguredByUserId != null) {
      return Number(ownerUserId) !== this._plexConfiguredByUserId;
    }
    const owner = this._getCachedOwnerUser(ownerUserId, ownerUserCache);
    return Boolean(owner) && owner.role !== "admin";
  }

  _resolvePlexLocationKey(ownerUserId) {
    if (ownerUserId == null) return "global";
    const connection = plexConnectionStore.getConnection(ownerUserId);
    if (!connection) return "global";
    return `${connection.linkType}:${connection.plexAccountId ?? connection.plexUuid ?? ownerUserId}`;
  }

  async _cleanupRelocatedPointer(pointer) {
    if (pointer.location !== "global") return;
    try {
      await this.plexClient.deletePlaylist(pointer.ratingKey);
    } catch (err) {
      if (err?.response?.status !== 404) {
        console.warn(
          `[WeeklyFlowPlaylistManager] Failed to clean up relocated Plex playlist (ratingKey ${pointer.ratingKey}):`,
          err?.message,
        );
      }
    }
  }

  async _deleteTrackedPlaylist(entityId, targetKey, pointer, ownerClientCache) {
    const ownerUserId = targetKey === "global" ? null : Number(targetKey);
    const client =
      pointer.location === "global"
        ? this.plexClient
        : resolvePlexClientForOwner(this.plexClient, ownerUserId, ownerClientCache);
    if (client === this.plexClient && pointer.location !== "global") {
      plexPlaylistPointerStore.deletePointer(entityId, targetKey);
      return;
    }
    try {
      await client.deletePlaylist(pointer.ratingKey);
    } catch (err) {
      if (err?.response?.status !== 404) {
        console.warn(
          `[WeeklyFlowPlaylistManager] Failed to delete Plex playlist (ratingKey ${pointer.ratingKey}):`,
          err?.message,
        );
      }
    }
    plexPlaylistPointerStore.deletePointer(entityId, targetKey);
  }

  async cleanupUserPlexPlaylists(userId) {
    const targetKey = String(userId);
    const pointers = plexPlaylistPointerStore.getPointersForTarget(targetKey);
    const ownerClientCache = new Map();
    for (const pointer of pointers) {
      await this._deleteTrackedPlaylist(pointer.entityId, targetKey, pointer, ownerClientCache);
    }
  }

  async cleanupEntityPlexPlaylists(entityId) {
    const pointers = plexPlaylistPointerStore.getPointersForEntity(entityId);
    const ownerClientCache = new Map();
    for (const pointer of pointers) {
      await this._deleteTrackedPlaylist(entityId, pointer.targetKey, pointer, ownerClientCache);
    }
  }

  async _resolveMainLibraryRatingKeys(playlistIds) {
    const membership = new Map(playlistIds.map((id) => [id, []]));
    const sectionId = this._plexMainLibrarySectionId;
    if (!sectionId) return membership;

    const activeIds = new Set(playlistIds);
    const reusedJobs = downloadTracker.getAll().filter((job) => {
      if (job?.status !== "done" || typeof job?.finalPath !== "string") return false;
      if (!activeIds.has(String(job.playlistType || ""))) return false;
      const finalPath = path.resolve(remapLegacyPath(job.finalPath, this.weeklyFlowRoot));
      return !isPathInsideRoot(finalPath, this.playlistLibraryRoot);
    });
    if (!reusedJobs.length) return membership;

    let mainLibraryTracks;
    try {
      mainLibraryTracks = await this.plexClient.getTracks(sectionId);
    } catch (err) {
      console.warn(
        "[WeeklyFlowPlaylistManager] Failed to read configured main Plex library section:",
        err?.message,
      );
      return membership;
    }

    const plexMappings = getPathMappings("plex");
    const byPath = new Map();
    for (const t of mainLibraryTracks) {
      if (!t.ratingKey) continue;
      for (const file of t.files || []) {
        const localPath = path.resolve(resolveLocalPath(file, plexMappings));
        if (!byPath.has(localPath)) byPath.set(localPath, t.ratingKey);
      }
    }

    for (const job of reusedJobs) {
      const finalPath = path.resolve(remapLegacyPath(job.finalPath, this.weeklyFlowRoot));
      const ratingKey = byPath.get(finalPath);
      if (!ratingKey) continue;
      membership.get(String(job.playlistType)).push(ratingKey);
    }
    return membership;
  }

  // Plex has no equivalent of Navidrome's .nsp smart playlists, so we build
  // regular playlists from indexed tracks, grouped by their weekly-flow subfolder.
  async _syncPlexPlaylists(flows, sharedPlaylists) {
    const sectionId = await this._ensurePlexSectionId();
    if (sectionId == null) return;

    const tracks = await this.plexClient.getTracks(sectionId);
    if (tracks.length === 0) {
      // Plex hasn't indexed anything yet (fresh library, or a scan triggered
      // by syncPlexNow()/catch-up hasn't finished) rather than the library
      // actually being emptied. Skip this pass instead of wiping every
      // tracked playlist; the next successful sync/catch-up reconciles
      // normally once tracks are indexed.
      return;
    }
    // Plex de-duplicates the same song across flow folders inconsistently:
    // sometimes one track with one path, sometimes two separate tracks sharing
    // a relative path. So resolve membership per relative file (Artist/Album/
    // Title.ext) from disk, picking ONE representative track per file — the
    // copy whose own path is in this flow when available. This puts shared
    // songs in every flow that holds the file without duplicating a track.
    const relativeOf = (file) => {
      const parts = (file || "").replace(/\\/g, "/").split("/aurral-weekly-flow/");
      if (parts.length < 2) return null;
      const segs = parts[1].split("/");
      segs.shift(); // drop the flow-id segment
      return segs.join("/") || null;
    };
    const byRelative = new Map();
    for (const t of tracks) {
      const rel = relativeOf(t.files[0]);
      if (!rel) continue;
      if (!byRelative.has(rel)) byRelative.set(rel, []);
      byRelative.get(rel).push(t);
    }
    const playlistIds = [
      ...new Set([...flows.map((f) => f.id), ...sharedPlaylists.map((p) => p.id)]),
    ];
    const membership = new Map(playlistIds.map((id) => [id, []]));
    for (const id of playlistIds) {
      for (const [rel, group] of byRelative) {
        const ownsPath = (t) => t.files.some((f) => f.replace(/\\/g, "/").includes(`/${id}/`));
        let present = group.some(ownsPath);
        if (!present) {
          try {
            await fs.access(path.join(this.playlistLibraryRoot, id, rel));
            present = true;
          } catch {}
        }
        if (!present) continue;
        const best = group.find(ownsPath) || group[0];
        if (best?.ratingKey) membership.get(id).push(best.ratingKey);
      }
    }

    const mainLibraryMembership = await this._resolveMainLibraryRatingKeys(playlistIds);
    for (const [id, ratingKeys] of mainLibraryMembership) {
      membership.get(id).push(...ratingKeys);
    }

    const ratingKeysFor = (playlistType) => [...new Set(membership.get(playlistType) || [])];

    const ownerClientCache = new Map();
    const ownerUserCache = new Map();
    const syncHashKey = (ownerUserId, desired) => `${ownerUserId ?? "global"}:${desired}`;

    const resolveOwnerPlexTitle = (ownerUserId, desired) =>
      this._resolveOwnerPlexTitle(ownerUserId, desired, ownerClientCache, ownerUserCache);

    const deleteCurrentPointerTarget = async (entityId, ownerUserId) => {
      const targetKey = String(ownerUserId ?? "global");
      const pointer = plexPlaylistPointerStore.getPointer(entityId, targetKey);
      if (!pointer) return;
      const location = this._resolvePlexLocationKey(ownerUserId);
      if (pointer.location === location) {
        await this._withOwnerPlexClient(ownerUserId, ownerClientCache, async (client) => {
          try {
            await client.deletePlaylist(pointer.ratingKey);
          } catch (err) {
            if (err?.response?.status !== 404) {
              console.warn(
                `[WeeklyFlowPlaylistManager] Failed to delete Plex playlist (ratingKey ${pointer.ratingKey}):`,
                err?.message,
              );
            }
          }
        });
      } else {
        await this._cleanupRelocatedPointer(pointer);
      }
      plexPlaylistPointerStore.deletePointer(entityId, targetKey);
    };

    const buildIfChanged = async (entityId, ownerUserId, desired, ratingKeys, description) => {
      const cacheKey = syncHashKey(ownerUserId, desired);
      const hash = `${this._hashKeys(ratingKeys)}|${description || ""}`;
      if (this._plexSyncHashes.get(cacheKey) === hash) return;

      const targetKey = String(ownerUserId ?? "global");
      const location = this._resolvePlexLocationKey(ownerUserId);
      const pointer = plexPlaylistPointerStore.getPointer(entityId, targetKey);
      if (pointer && pointer.location !== location) {
        await this._cleanupRelocatedPointer(pointer);
      }
      const reusable = pointer && pointer.location === location ? pointer : null;

      const result = await this._withOwnerPlexClient(ownerUserId, ownerClientCache, (client) =>
        client.syncPlaylist({
          ratingKey: reusable?.ratingKey ?? null,
          previousTitle: reusable?.title ?? null,
          previousDescription: reusable?.description ?? null,
          title: desired,
          description,
          ratingKeys,
        }),
      );
      if (result === PLEX_SYNC_SKIPPED) return;
      if (result?.ratingKey) {
        plexPlaylistPointerStore.setPointer(entityId, targetKey, {
          location,
          ratingKey: result.ratingKey,
          title: desired,
          description,
        });
      } else {
        plexPlaylistPointerStore.deletePointer(entityId, targetKey);
      }
      this._plexSyncHashes.set(cacheKey, hash);
    };

    for (const flow of flows) {
      const ownerUserId = flow.ownerUserId ?? null;
      const desired = String(flow.name || "").trim();
      if (this._isOwnerPlexSyncBlocked(ownerUserId, ownerClientCache, ownerUserCache)) {
        await deleteCurrentPointerTarget(flow.id, ownerUserId);
        this._plexSyncHashes.delete(syncHashKey(ownerUserId, resolveOwnerPlexTitle(ownerUserId, desired)));
        continue;
      }
      const title = resolveOwnerPlexTitle(ownerUserId, desired);
      if (flow.enabled) {
        const ratingKeys = ratingKeysFor(flow.id);
        if (ratingKeys.length) {
          await buildIfChanged(flow.id, ownerUserId, title, ratingKeys, flow.description);
        } else {
          await deleteCurrentPointerTarget(flow.id, ownerUserId);
          this._plexSyncHashes.delete(syncHashKey(ownerUserId, title));
        }
      } else {
        await deleteCurrentPointerTarget(flow.id, ownerUserId);
        this._plexSyncHashes.delete(syncHashKey(ownerUserId, title));
      }
    }

    for (const playlist of sharedPlaylists) {
      const ownerUserId = playlist.ownerUserId ?? null;
      const desired = String(playlist.name || "").trim();
      const ratingKeys = ratingKeysFor(playlist.id);
      if (this._isOwnerPlexSyncBlocked(ownerUserId, ownerClientCache, ownerUserCache)) {
        await deleteCurrentPointerTarget(playlist.id, ownerUserId);
        this._plexSyncHashes.delete(syncHashKey(ownerUserId, resolveOwnerPlexTitle(ownerUserId, desired)));
        continue;
      }
      const title = resolveOwnerPlexTitle(ownerUserId, desired);
      if (ratingKeys.length) {
        await buildIfChanged(playlist.id, ownerUserId, title, ratingKeys, playlist.description);
      } else {
        await deleteCurrentPointerTarget(playlist.id, ownerUserId);
        this._plexSyncHashes.delete(syncHashKey(ownerUserId, title));
      }
    }
  }

  // Returns quickly rather than blocking: Plex's music scan (with online
  // metadata matching) can take minutes, so a background catch-up rebuilds the
  // playlists as tracks get indexed.
  async syncPlexNow() {
    if (!this.plexClient?.isConfigured()) {
      return { configured: false };
    }
    const sectionId = await this._ensurePlexSectionId();
    if (sectionId == null) {
      throw new Error("Could not create or find the Aurral Plex library");
    }
    await this.plexClient.scanLibrary(sectionId);

    // Manual sync is authoritative: drop cached fingerprints so we reconcile
    // against Plex's real state (catches manual edits made in Plex).
    this._plexSyncHashes.clear();

    const flows = flowPlaylistConfig.getFlows();
    const sharedPlaylists = flowPlaylistConfig.getSharedPlaylists();
    await this._syncPlexPlaylists(flows, sharedPlaylists);

    const tracks = await this.plexClient.getTracks(sectionId);
    const playlists = await this.plexClient.getPlaylists();

    this._schedulePlexCatchup(sectionId);

    const summaryClientCache = new Map();
    const summaryUserCache = new Map();
    const managedNames = new Set(
      [...flows, ...sharedPlaylists]
        .map((entity) => {
          if (
            this._isOwnerPlexSyncBlocked(entity.ownerUserId, summaryClientCache, summaryUserCache)
          )
            return null;
          const desired = String(entity.name || "").trim();
          if (!desired) return null;
          return this._resolveOwnerPlexTitle(
            entity.ownerUserId,
            desired,
            summaryClientCache,
            summaryUserCache,
          );
        })
        .filter(Boolean),
    );

    return {
      configured: true,
      sectionId,
      indexedTracks: tracks.length,
      scanInProgress: tracks.length === 0,
      playlists: playlists
        .filter((p) => managedNames.has(p.title))
        .map((p) => ({ title: p.title, count: p.leafCount ?? null })),
    };
  }

  _schedulePlexCatchup(sectionId, delaysMs = [30000, 90000, 180000]) {
    if (this._plexCatchupRunning) return;
    this._plexCatchupRunning = true;
    const run = async () => {
      try {
        for (const delay of delaysMs) {
          await new Promise((r) => setTimeout(r, delay));
          if (!this.plexClient?.isConfigured()) break;
          const flows = flowPlaylistConfig.getFlows();
          const sharedPlaylists = flowPlaylistConfig.getSharedPlaylists();
          await this._syncPlexPlaylists(flows, sharedPlaylists);
        }
      } catch (err) {
        console.warn("[WeeklyFlowPlaylistManager] Plex catch-up failed:", err?.message);
      } finally {
        this._plexCatchupRunning = false;
      }
    };
    run();
  }

  async _playlistArtworkExists(baseName) {
    for (const extension of ARTWORK_FILE_EXTENSIONS) {
      try {
        await fs.access(path.join(this.libraryRoot, `${baseName}${extension}`));
        return true;
      } catch {}
    }
    return false;
  }

  async scanLibrary() {
    const results = [];
    if (this.navidromeDestination.isConfigured()) {
      results.push(await this.navidromeDestination.requestScan());
    }
    if (this.plexClient?.isConfigured()) {
      try {
        const sectionId = await this._ensurePlexSectionId();
        if (sectionId != null) {
          results.push(await this.plexClient.scanLibrary(sectionId));
        }
      } catch (err) {
        console.warn("[WeeklyFlowPlaylistManager] Plex scan failed:", err?.message);
      }
    }
    return results.length ? results : null;
  }

  async weeklyReset(playlistTypes = null) {
    const targets =
      playlistTypes && playlistTypes.length
        ? playlistTypes
        : flowPlaylistConfig.getFlows().map((flow) => flow.id);
    const fallbackDir = path.join(this.weeklyFlowRoot, "_fallback");
    try {
      await fs.rm(fallbackDir, { recursive: true, force: true });
    } catch {}

    for (const playlistType of targets) {
      const jobs = downloadTracker.getByPlaylistType(playlistType);
      for (const job of jobs) {
        if (job.downloadClient === "ytdlp") {
          await ytdlpClient.cleanupStaging(job.id);
        }
      }
      const playlistDir = path.join(this.playlistLibraryRoot, playlistType);
      try {
        const { relocateSharedFilesBeforePlaylistRemoval } = await import(
          "./weeklyFlowFileReuse.js"
        );
        await relocateSharedFilesBeforePlaylistRemoval(playlistType, {
          weeklyFlowRoot: this.weeklyFlowRoot,
        });
        await fs.rm(playlistDir, { recursive: true, force: true });
        console.log(`[WeeklyFlowPlaylistManager] Deleted files for ${playlistType}`);
      } catch (error) {
        console.warn(
          `[WeeklyFlowPlaylistManager] Failed to delete files for ${playlistType}:`,
          error.message,
        );
      }
      downloadTracker.clearByPlaylistType(playlistType);
      const { repairJobsUnderRemovedPlaylistDir } = await import("./weeklyFlowFileReuse.js");
      const { weeklyFlowWorker } = await import("./weeklyFlowWorker.js");
      const { existingFileMode } = weeklyFlowWorker.getWorkerSettings();
      await repairJobsUnderRemovedPlaylistDir(playlistType, {
        existingFileMode,
        weeklyFlowRoot: this.weeklyFlowRoot,
      });
    }
  }

  getPlaylistName(playlistType) {
    const entity =
      flowPlaylistConfig.getFlow(playlistType)
      || flowPlaylistConfig.getSharedPlaylist(playlistType);
    if (!entity) return playlistType;
    return this.navidromeDestination.getPlaylistName({
      entityId: entity.id,
      ownerUserId: entity.ownerUserId ?? null,
      displayName: entity.name,
    });
  }

  getArtworkKindForPlaylistId(playlistId) {
    if (flowPlaylistConfig.getFlow(playlistId)) return "Flow";
    return "Playlist";
  }

  getArtworkContextForPlaylistId(playlistId) {
    const flow = flowPlaylistConfig.getFlow(playlistId);
    if (flow) return { kind: "Flow", title: flow.name };
    const playlist = flowPlaylistConfig.getSharedPlaylist(playlistId);
    if (playlist) return { kind: "Playlist", title: playlist.name };
    return null;
  }

  _resolveArtworkBase(playlistId) {
    const playlistName = this.getPlaylistName(playlistId);
    if (!playlistName) return null;
    const baseName = this._getPlaylistBaseName(playlistName);
    const safeRoot = path.resolve(this.libraryRoot);
    return { safeRoot, baseName, playlistName };
  }

  _artworkSuppressPath(safeRoot, baseName) {
    const safePath = path.resolve(safeRoot, `${baseName}${ARTWORK_SUPPRESS_SUFFIX}`);
    if (path.dirname(safePath) !== safeRoot) return null;
    return safePath;
  }

  async _isArtworkGenerationSuppressed(safeRoot, baseName) {
    const suppressPath = this._artworkSuppressPath(safeRoot, baseName);
    if (!suppressPath) return false;
    try {
      const stat = await fs.stat(suppressPath);
      return stat.isFile();
    } catch {
      return false;
    }
  }

  async _setArtworkGenerationSuppressed(safeRoot, baseName, suppressed) {
    const suppressPath = this._artworkSuppressPath(safeRoot, baseName);
    if (!suppressPath) return;
    if (suppressed) {
      await fs.writeFile(suppressPath, "", "utf8");
      return;
    }
    try {
      await fs.unlink(suppressPath);
    } catch {}
  }

  async resolveArtworkFile(playlistId) {
    const resolved = this._resolveArtworkBase(playlistId);
    if (!resolved) return null;
    for (const extension of ARTWORK_FILE_EXTENSIONS) {
      const safePath = path.resolve(resolved.safeRoot, `${resolved.baseName}${extension}`);
      if (path.dirname(safePath) !== resolved.safeRoot) continue;
      try {
        const stat = await fs.stat(safePath);
        if (stat.isFile()) {
          return { ...resolved, safePath, extension };
        }
      } catch {}
    }
    return null;
  }

  async saveArtworkUpload(playlistId, buffer) {
    const resolved = this._resolveArtworkBase(playlistId);
    if (!resolved) {
      throw new Error("Playlist not found");
    }
    await fs.mkdir(resolved.safeRoot, { recursive: true });
    const webpPath = path.join(resolved.safeRoot, `${resolved.baseName}.webp`);
    if (path.dirname(webpPath) !== resolved.safeRoot) {
      throw new Error("Invalid artwork path");
    }
    await writePlaylistArtworkWebpFromBuffer(buffer, webpPath);
    const legacyPng = path.join(resolved.safeRoot, `${resolved.baseName}.png`);
    try {
      await fs.unlink(legacyPng);
    } catch {}
    await this._setArtworkGenerationSuppressed(resolved.safeRoot, resolved.baseName, false);
    return webpPath;
  }

  async removeArtwork(playlistId) {
    const resolved = this._resolveArtworkBase(playlistId);
    if (!resolved) {
      throw new Error("Playlist not found");
    }
    let removed = false;
    for (const extension of ARTWORK_FILE_EXTENSIONS) {
      const safePath = path.join(resolved.safeRoot, `${resolved.baseName}${extension}`);
      if (path.dirname(safePath) !== resolved.safeRoot) continue;
      try {
        await fs.unlink(safePath);
        removed = true;
      } catch {}
    }
    await this._setArtworkGenerationSuppressed(resolved.safeRoot, resolved.baseName, true);
    return removed;
  }

  async generateArtwork(playlistId) {
    const resolved = this._resolveArtworkBase(playlistId);
    if (!resolved) {
      throw new Error("Playlist not found");
    }
    await fs.mkdir(resolved.safeRoot, { recursive: true });
    const artworkExtension = getArtworkExtensionForStyle(getPlaylistArtworkStyle());
    const artworkPath = path.join(resolved.safeRoot, `${resolved.baseName}${artworkExtension}`);
    if (path.dirname(artworkPath) !== resolved.safeRoot) {
      throw new Error("Invalid artwork path");
    }
    const artworkContext = this.getArtworkContextForPlaylistId(playlistId);
    const outputPath = await writeGeneratedPlaylistArtwork({
      outputPath: artworkPath,
      title: artworkContext?.title || resolved.playlistName,
      kind: artworkContext?.kind || this.getArtworkKindForPlaylistId(playlistId),
    });
    await this._setArtworkGenerationSuppressed(resolved.safeRoot, resolved.baseName, false);
    return outputPath;
  }
}

export const playlistManager = new WeeklyFlowPlaylistManager();
