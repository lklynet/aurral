import fs from "node:fs";
import path from "node:path";
import { userOps } from "../../db/helpers/index.js";
import { JellyfinClient } from "../jellyfin.js";
import { jellyfinPlaylistPointerStore } from "../jellyfin/jellyfinPlaylistPointerStore.js";
import { getPathMappings, pathMatchesPrefix, resolveRemotePath, resolveLocalPath } from "../pathMappings.js";
import { resolveDownloadRoot } from "../downloadPaths.js";
import { isPathWithin } from "../libraryFolders.js";
import { logger } from "../logger.js";
import { claimUnmatchedRootWarning, serverScanTargets } from "./playbackScanFolders.js";
import {
  createPlaybackPlaylistIdentity,
  createPlaybackPlaylistSnapshot,
  isRetryablePlaybackError,
  playbackOperationFailure,
  playbackOperationSuccess,
} from "./playbackDestination.js";

const MAX_JELLYFIN_FOLDER_UPDATES = 20;
const FULL_READ_INTERVAL_MS = 30_000;
const SCAN_SETTLE_MS = 90_000;

export const jellyfinSettings = Object.freeze({
  key: "jellyfin",
  label: "Jellyfin",
  subtitle: "Jellyfin API",
  fields: Object.freeze([
    Object.freeze({ key: "url", label: "Server URL", type: "url", required: true }),
    Object.freeze({ key: "apiKey", label: "API key", type: "password", secret: true, required: true }),
    Object.freeze({ key: "userId", label: "User ID", type: "text", required: true }),
  ]),
  defaults: Object.freeze({ url: "", apiKey: "", userId: "" }),
  validation: Object.freeze({ required: ["url", "apiKey", "userId"], url: ["url"] }),
  testConnection: true,
});

const normalizePath = (value) =>
  String(value || "")
    .trim()
    .replace(/\\/g, "/")
    .replace(/\/+/g, "/")
    .replace(/\/$/, "")
    .toLowerCase();

const providerMbid = (item) => {
  const providerIds = item?.ProviderIds || item?.providerIds || {};
  const key = Object.keys(providerIds).find((candidate) => {
    const normalized = candidate.toLowerCase();
    return normalized.includes("musicbrainz")
      && (normalized.includes("recording") || normalized.includes("track"));
  });
  return key ? String(providerIds[key] || "").trim().toLowerCase() : "";
};

const itemId = (item) => item?.Id ?? item?.id ?? null;
const isWithinAny = (folders, candidate) => folders.some((folder) => isPathWithin(folder, candidate));
const isServerPathWithinAny = (folders, candidate) =>
  folders.some((folder) => candidate === folder || candidate.startsWith(`${folder}/`));
const isNotFound = (error) => Number(error?.response?.status) === 404;

export class JellyfinPlaybackDestination {
  constructor(_downloadRoot = resolveDownloadRoot(), { client = null } = {}) {
    this.key = "jellyfin";
    this.name = "Jellyfin";
    this.client = client;
    this._configKey = "";
    this._indexes = new Map();
    this._fullReadAt = new Map();
    this._readErrors = new Map();
    this._recentScans = [];
    this._syncHashes = new Map();
    this._publishInFlight = new Map();
    this._warnedUnmatchedRoots = new Set();
  }

  updateConfig(config = {}) {
    const key = JSON.stringify({
      url: config.url || "",
      apiKey: config.apiKey || "",
      userId: config.userId || "",
      pathMappings: getPathMappings("jellyfin"),
    });
    if (key === this._configKey) return;
    this._configKey = key;
    this.client = config.url && config.apiKey && config.userId
      ? new JellyfinClient(config.url, config.apiKey, config.userId)
      : null;
    this._indexes = new Map();
    this._fullReadAt = new Map();
    this._readErrors = new Map();
    this._recentScans = [];
    this._syncHashes.clear();
    this._warnedUnmatchedRoots.clear();
  }

  isConfigured() {
    return Boolean(this.client?.isConfigured());
  }

  async getReferencedPaths({ excludeEntityIds = [] } = {}) {
    const excluded = new Set(excludeEntityIds.flatMap((id) =>
      jellyfinPlaylistPointerStore.getPointersForEntity(id)
        .filter((pointer) => !pointer.serverUrl || pointer.serverUrl === this.client.url)
        .map((pointer) => pointer.playlistId)));
    const paths = await this.client.getPlaylistTrackPaths(excluded);
    return { ok: true, paths: paths.map((file) => resolveLocalPath(file, getPathMappings("jellyfin"))) };
  }

  async _resolveOwnerJellyfinUser(ownerUserId) {
    if (ownerUserId == null) return { Id: this.client.userId };

    const owner = userOps.getUserById(ownerUserId);
    if (!owner?.username) return null;

    return this.client.findUserByUsername(owner.username);
  }

  _targetKey(ownerUserId) {
    return String(ownerUserId ?? this.client?.userId ?? "global");
  }

  _cacheKey(snapshot) {
    return `${snapshot.entityId}:${this._targetKey(snapshot.ownerUserId)}`;
  }

  async testConnection() {
    if (!this.isConfigured()) {
      return playbackOperationFailure({
        code: "DESTINATION_NOT_CONFIGURED",
        message: "Jellyfin is not configured",
      });
    }
    try {
      await this.client.ping();
      await this.client.getUser();
      await this.client.getUsers();
      return playbackOperationSuccess();
    } catch (error) {
      return playbackOperationFailure({
        code: "DESTINATION_UNAVAILABLE",
        message: error?.message || "Jellyfin did not respond",
        retryable: isRetryablePlaybackError(error),
      });
    }
  }

  async ensureLibrary() {
    if (!this.isConfigured()) return playbackOperationSuccess();
    return this._loadLibrary(this.client.userId);
  }

  async _loadLibrary(userId) {
    const libraryKey = String(userId || "").trim();
    if (!libraryKey) {
      return playbackOperationFailure({
        code: "JELLYFIN_USER_NOT_FOUND",
        message: "No Jellyfin user was provided for the library lookup",
      });
    }

    if (this._indexes.has(libraryKey)) {
      return playbackOperationSuccess();
    }

    try {
      await this._readIndex(libraryKey);
      return playbackOperationSuccess();
    } catch (error) {
      return playbackOperationFailure({
        code: "LIBRARY_SETUP_FAILED",
        message: error?.message || "Could not read the Jellyfin music library",
        retryable: isRetryablePlaybackError(error),
      });
    }
  }

  async _readIndex(libraryKey) {
    this._fullReadAt.set(libraryKey, Date.now());
    try {
      const [items, locations] = await Promise.all([
        this.client.getAudioItems(libraryKey),
        this.client.getMusicLibraryLocations().catch(() => null),
      ]);
      const now = Date.now();
      const dropped = new Map([...(this._indexes.get(libraryKey)?.dropped ?? [])]
        .filter(([, mark]) => mark.until > now));
      const byPath = new Map();
      const byMbid = new Map();
      const paths = new Map();
      for (const item of items) {
        const id = itemId(item);
        if (!id) continue;
        const rawPath = String(item.Path || item.path || "");
        const itemPath = normalizePath(rawPath);
        if (dropped.get(itemPath)?.id === String(id)) continue;
        paths.set(String(id), { key: itemPath, raw: rawPath });
        if (itemPath && !byPath.has(itemPath)) byPath.set(itemPath, String(id));
        const mbid = providerMbid(item);
        if (mbid) {
          const values = byMbid.get(mbid) || [];
          values.push(String(id));
          byMbid.set(mbid, values);
        }
      }
      this._indexes.set(libraryKey, {
        byPath,
        byMbid,
        paths,
        dropped,
        locations: locations?.map(normalizePath) ?? null,
      });
      this._readErrors.delete(libraryKey);
    } catch (error) {
      this._readErrors.set(libraryKey, error);
      throw error;
    }
  }

  _recentlyScannedFolders() {
    const now = Date.now();
    this._recentScans = this._recentScans.filter((scan) => scan.until > now);
    return this._recentScans.map((scan) => scan.folder);
  }

  _forgetScannedFolders(folders) {
    const until = Date.now() + SCAN_SETTLE_MS;
    this._recentScans = [
      ...this._recentScans.filter((scan) => scan.until > Date.now()),
      ...folders.map((folder) => ({ folder, until })),
    ];
    const mappings = getPathMappings("jellyfin");
    const serverFolders = folders.map((folder) => normalizePath(resolveRemotePath(folder, mappings)));
    for (const index of this._indexes.values()) {
      for (const [id, itemPath] of index.paths) {
        if (!isServerPathWithinAny(serverFolders, itemPath.key)) continue;
        if (fs.existsSync(resolveLocalPath(itemPath.raw, mappings))) continue;
        index.paths.delete(id);
        if (index.byPath.get(itemPath.key) === id) index.byPath.delete(itemPath.key);
        index.dropped.set(itemPath.key, { id, until });
      }
      for (const [mbid, ids] of index.byMbid) {
        const kept = ids.filter((id) => index.paths.has(id));
        if (kept.length) index.byMbid.set(mbid, kept);
        else index.byMbid.delete(mbid);
      }
    }
  }

  _resolveItemIds(snapshot, libraryKey, untrustedFolders) {
    const { byPath, byMbid, paths } = this._indexes.get(libraryKey);
    const mappings = getPathMappings("jellyfin");
    const untrustedServerFolders = untrustedFolders.map((folder) => normalizePath(resolveRemotePath(folder, mappings)));
    const settling = [...untrustedFolders, ...this._recentlyScannedFolders()];
    const itemIds = [];
    const missing = [];
    for (const track of snapshot.tracks) {
      const localPath = path.resolve(track.path);
      const remotePath = normalizePath(resolveRemotePath(track.path, mappings));
      const mbidMatches = byMbid.get(String(track.mbid || "").trim().toLowerCase()) || [];
      const mbidMatch = mbidMatches.length === 1
        && !isWithinAny(untrustedFolders, localPath)
        && !isServerPathWithinAny(untrustedServerFolders, paths.get(mbidMatches[0]).key)
        ? mbidMatches[0]
        : null;
      const match = byPath.get(remotePath) || mbidMatch;
      if (match) itemIds.push(match);
      else missing.push({ remotePath, mbid: track.mbid, settling: isWithinAny(settling, localPath) });
    }
    return { itemIds, missing };
  }

  _canHold(libraryKey, { remotePath, mbid }) {
    const { locations } = this._indexes.get(libraryKey);
    return Boolean(mbid) || locations == null || locations.some((location) => pathMatchesPrefix(remotePath, location));
  }

  async _resolveWithReread(snapshot, libraryKey, untrustedFolders) {
    const resolved = this._resolveItemIds(snapshot, libraryKey, untrustedFolders);
    const needsRead = resolved.missing.some((track) => !track.settling && this._canHold(libraryKey, track));
    let result = resolved;
    if (needsRead && Date.now() - (this._fullReadAt.get(libraryKey) ?? 0) >= FULL_READ_INTERVAL_MS) {
      try {
        await this._readIndex(libraryKey);
      } catch (error) {
        logger.warn("jellyfin", "Could not re-read the Jellyfin music library", { error: error?.message });
      }
      result = this._resolveItemIds(snapshot, libraryKey, untrustedFolders);
    }
    const error = this._readErrors.get(libraryKey);
    if (error && result.missing.some((track) => this._canHold(libraryKey, track))) throw error;
    return result;
  }

  _hash(snapshot, itemIds) {
    return JSON.stringify({
      title: snapshot.displayName,
      itemIds,
    });
  }

  async _runPlaylistOperation(key, operation) {
    const previous = this._publishInFlight.get(key) || Promise.resolve();
    const queued = previous.catch(() => {}).then(operation);
    this._publishInFlight.set(key, queued);
    try {
      return await queued;
    } finally {
      if (this._publishInFlight.get(key) === queued) this._publishInFlight.delete(key);
    }
  }

  async _deleteTarget(entityId, targetKey) {
    const pointer = jellyfinPlaylistPointerStore.getPointer(entityId, targetKey);
    if (!pointer) return;
    if (!pointer.serverUrl || pointer.serverUrl === this.client?.url) {
      try {
        await this.client.deletePlaylist(
          pointer.playlistId,
          pointer.jellyfinUserId || this.client.userId,
        );
      } catch (error) {
        if (!isNotFound(error)) throw error;
      }
    }
    jellyfinPlaylistPointerStore.deletePointer(entityId, targetKey);
    this._syncHashes.delete(`${entityId}:${targetKey}`);
  }

  async _deleteLegacyPointer(entityId, currentTargetKey) {
    const legacyTargetKey = String(this.client?.userId || "global");
    if (legacyTargetKey !== currentTargetKey) await this._deleteTarget(entityId, legacyTargetKey);
  }

  async _deleteCurrent(identity) {
    const targetKey = this._targetKey(identity.ownerUserId);
    await this._deleteLegacyPointer(identity.entityId, targetKey);
    await this._deleteTarget(identity.entityId, targetKey);
  }

  async _publishPlaylist(snapshot, untrustedFolders) {
    if (!this.isConfigured()) return playbackOperationSuccess();
    const jellyfinUser = await this._resolveOwnerJellyfinUser(
      snapshot.ownerUserId,
    );
    const jellyfinUserId = itemId(jellyfinUser);

    if (!jellyfinUserId) {
      const owner = userOps.getUserById(snapshot.ownerUserId);
      return playbackOperationFailure({
        code: "JELLYFIN_USER_NOT_FOUND",
        message: `No Jellyfin user matches Aurral username "${owner?.username || "unknown"}"`,
      });
    }
    const ensured = await this._loadLibrary(jellyfinUserId);
    if (!ensured.ok) return ensured;
    const { itemIds, missing } = await this._resolveWithReread(
      snapshot,
      String(jellyfinUserId).trim(),
      untrustedFolders,
    );
    const targetKey = this._targetKey(snapshot.ownerUserId);
    await this._deleteLegacyPointer(snapshot.entityId, targetKey);
    const cacheKey = this._cacheKey(snapshot);
    const pointer = jellyfinPlaylistPointerStore.getPointer(snapshot.entityId, targetKey);
    let reusable = pointer?.serverUrl === this.client.url ? pointer : null;

    if (reusable && reusable.jellyfinUserId !== jellyfinUserId) {
      try {
        await this.client.deletePlaylist(
          reusable.playlistId,
          reusable.jellyfinUserId || this.client.userId,
        );
      } catch (error) {
        if (!isNotFound(error)) throw error;
      }

      jellyfinPlaylistPointerStore.deletePointer(snapshot.entityId, targetKey);
      reusable = null;
    }
    if (!snapshot.tracks.length && !reusable) return playbackOperationSuccess();

    const unresolved = missing.length > 0;

    const hash = this._hash(snapshot, itemIds);
    if (!unresolved && this._syncHashes.get(cacheKey) === hash) return playbackOperationSuccess();

    let playlistId = reusable?.playlistId || null;
    let managedItemIds = reusable?.managedItemIds || [];
    const saveManagedItems = (ids) => {
      managedItemIds = ids;
      jellyfinPlaylistPointerStore.setPointer(snapshot.entityId, targetKey, {
        playlistId,
        title: snapshot.displayName,
        serverUrl: this.client.url,
        jellyfinUserId,
        managedItemIds,
      });
    };
    if (playlistId) {
      try {
        const updated = await this.client.updatePlaylist(playlistId, {
          name: snapshot.displayName,
          itemIds,
          userId: jellyfinUserId,
          managedItemIds,
          onManagedItemsChange: saveManagedItems,
        });
        playlistId = itemId(updated) || playlistId;
        managedItemIds = updated.managedItemIds;
      } catch (error) {
        if (!isNotFound(error)) throw error;
        playlistId = null;
        jellyfinPlaylistPointerStore.deletePointer(snapshot.entityId, targetKey);
      }
    }
    if (!playlistId) {
      if (!snapshot.tracks.length) {
        this._syncHashes.delete(cacheKey);
        return playbackOperationSuccess();
      }
      const created = await this.client.createPlaylist({
        name: snapshot.displayName,
        itemIds,
        userId: jellyfinUserId,
      });
      playlistId = itemId(created);
      managedItemIds = itemIds;
    }
    if (!playlistId) throw new Error("Jellyfin did not return a playlist ID");
    jellyfinPlaylistPointerStore.setPointer(snapshot.entityId, targetKey, {
      playlistId,
      title: snapshot.displayName,
      serverUrl: this.client.url,
      jellyfinUserId,
      managedItemIds,
    });
    if (unresolved) {
      this._syncHashes.delete(cacheKey);
      return playbackOperationSuccess({ pending: true });
    }
    this._syncHashes.set(cacheKey, hash);
    return playbackOperationSuccess();
  }

  async publishPlaylist(value, { pendingScanFolders = new Map() } = {}) {
    try {
      const snapshot = createPlaybackPlaylistSnapshot(value);
      return await this._runPlaylistOperation(this._cacheKey(snapshot), () =>
        this._publishPlaylist(snapshot, pendingScanFolders.get(this.key) ?? []));
    } catch (error) {
      return playbackOperationFailure({
        code: "PLAYLIST_PUBLISH_FAILED",
        message: error?.message || "Could not publish the Jellyfin playlist",
        retryable: isRetryablePlaybackError(error),
      });
    }
  }

  async deletePlaylist(value) {
    try {
      const identity = createPlaybackPlaylistIdentity(value);
      const key = this._cacheKey(identity);
      if (!this.isConfigured()) return playbackOperationSuccess();
      await this._runPlaylistOperation(key, () => this._deleteCurrent(identity));
      this._syncHashes.delete(key);
      return playbackOperationSuccess();
    } catch (error) {
      return playbackOperationFailure({
        code: "PLAYLIST_DELETE_FAILED",
        message: error?.message || "Could not delete the Jellyfin playlist",
        retryable: isRetryablePlaybackError(error),
      });
    }
  }

  getPointerEntityIds() {
    return jellyfinPlaylistPointerStore.getEntityIds();
  }

  async deleteEntityPlaylists(entityId) {
    try {
      if (!this.isConfigured()) return playbackOperationSuccess();
      for (const { targetKey } of jellyfinPlaylistPointerStore.getPointersForEntity(entityId)) {
        await this._runPlaylistOperation(`${entityId}:${targetKey}`, () =>
          this._deleteTarget(entityId, targetKey));
      }
      return playbackOperationSuccess();
    } catch (error) {
      return playbackOperationFailure({
        code: "PLAYLIST_DELETE_FAILED",
        message: error?.message || "Could not delete the Jellyfin playlist",
        retryable: isRetryablePlaybackError(error),
      });
    }
  }

  async _updatedFolders(folders, aurralRoots) {
    const mappings = getPathMappings("jellyfin");
    const locations = await this.client.getMusicLibraryLocations();
    const { targets, unmatched } = serverScanTargets(
      folders,
      locations.map((location) => ({ path: location })),
      mappings,
    );
    if (targets) {
      return [...new Set(targets.map((target) =>
        targets.length > MAX_JELLYFIN_FOLDER_UPDATES ? target.root.path : target.path))];
    }
    if (claimUnmatchedRootWarning(this._warnedUnmatchedRoots, unmatched.folder, aurralRoots, mappings)) {
      logger.warn("jellyfin", "Changed folder is outside every Jellyfin music library; reporting all music libraries. Add a path mapping if Jellyfin sees it at another path.", unmatched);
    }
    return locations;
  }

  async requestScan({ folders, roots: aurralRoots = [] }) {
    if (!this.isConfigured() || !folders.length) return playbackOperationSuccess();
    this._forgetScannedFolders(folders);
    try {
      const updated = await this._updatedFolders(folders, aurralRoots);
      if (updated.length) await this.client.reportUpdatedFolders(updated);
      return playbackOperationSuccess();
    } catch (error) {
      return playbackOperationFailure({
        code: "SCAN_FAILED",
        message: error?.message || "Could not scan the Jellyfin library",
        retryable: isRetryablePlaybackError(error),
      });
    }
  }
}
