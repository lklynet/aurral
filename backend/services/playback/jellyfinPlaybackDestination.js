import { setTimeout as wait } from "node:timers/promises";
import { JellyfinClient } from "../jellyfin.js";
import { jellyfinPlaylistPointerStore } from "../jellyfin/jellyfinPlaylistPointerStore.js";
import { getPathMappings, resolveRemotePath } from "../pathMappings.js";
import { resolvePlaylistRoot } from "../playlistPaths.js";
import {
  createPlaybackPlaylistIdentity,
  createPlaybackPlaylistSnapshot,
  playbackOperationFailure,
  playbackOperationSuccess,
} from "./playbackDestination.js";

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
const isNotFound = (error) => Number(error?.response?.status) === 404;

export class JellyfinPlaybackDestination {
  constructor(_weeklyFlowRoot = resolvePlaylistRoot(), { client = null } = {}) {
    this.key = "jellyfin";
    this.name = "Jellyfin";
    this.client = client;
    this._configKey = "";
    this._libraryTracks = null;
    this._syncHashes = new Map();
    this._pendingSnapshots = new Map();
    this._catchupRunning = false;
    this._publishInFlight = new Map();
  }

  updateConfig(config = {}) {
    const key = JSON.stringify({
      url: config.url || "",
      apiKey: config.apiKey || "",
      userId: config.userId || "",
    });
    if (key === this._configKey) return;
    this._configKey = key;
    this.client = config.url && config.apiKey && config.userId
      ? new JellyfinClient(config.url, config.apiKey, config.userId)
      : null;
    this._libraryTracks = null;
    this._syncHashes.clear();
    this._pendingSnapshots.clear();
  }

  isConfigured() {
    return Boolean(this.client?.isConfigured());
  }

  _targetKey() {
    return String(this.client?.userId || "global");
  }

  _cacheKey(snapshot) {
    return `${snapshot.entityId}:${this._targetKey()}`;
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
      return playbackOperationSuccess();
    } catch (error) {
      return playbackOperationFailure({
        code: "DESTINATION_UNAVAILABLE",
        message: error?.message || "Jellyfin did not respond",
        retryable: true,
      });
    }
  }

  async ensureLibrary() {
    if (!this.isConfigured()) return playbackOperationSuccess();
    try {
      // Keep one full audio index in memory per scan; add a persistent index only if nightly libraries make this measurable.
      this._libraryTracks = await this.client.getAudioItems();
      return playbackOperationSuccess();
    } catch (error) {
      return playbackOperationFailure({
        code: "LIBRARY_SETUP_FAILED",
        message: error?.message || "Could not read the Jellyfin music library",
        retryable: true,
      });
    }
  }

  _resolveItemIds(snapshot) {
    const byPath = new Map();
    const byMbid = new Map();
    for (const item of this._libraryTracks || []) {
      const id = itemId(item);
      if (!id) continue;
      const path = normalizePath(item.Path || item.path);
      if (path && !byPath.has(path)) byPath.set(path, String(id));
      const mbid = providerMbid(item);
      if (mbid) {
        const values = byMbid.get(mbid) || [];
        values.push(String(id));
        byMbid.set(mbid, values);
      }
    }
    const mappings = getPathMappings("jellyfin");
    const ids = [];
    for (const track of snapshot.tracks) {
      const remotePath = normalizePath(resolveRemotePath(track.path, mappings));
      const pathMatch = byPath.get(remotePath);
      const mbid = String(track.mbid || "").trim().toLowerCase();
      const mbidMatches = byMbid.get(mbid) || [];
      const match = pathMatch || (mbidMatches.length === 1 ? mbidMatches[0] : null);
      if (match) ids.push(match);
    }
    return [...new Set(ids)];
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

  async _deleteCurrent(identity) {
    const targetKey = this._targetKey();
    const pointer = jellyfinPlaylistPointerStore.getPointer(identity.entityId, targetKey);
    if (!pointer) return;
    if (pointer.serverUrl && pointer.serverUrl !== this.client?.url) {
      jellyfinPlaylistPointerStore.deletePointer(identity.entityId, targetKey);
      return;
    }
    try {
      await this.client.deletePlaylist(pointer.playlistId);
    } catch (error) {
      if (!isNotFound(error)) throw error;
    }
    jellyfinPlaylistPointerStore.deletePointer(identity.entityId, targetKey);
    this._syncHashes.delete(this._cacheKey(identity));
  }

  async _publishPlaylist(snapshot) {
    if (!this.isConfigured()) return playbackOperationSuccess();
    if (this._libraryTracks == null) {
      const ensured = await this.ensureLibrary();
      if (!ensured.ok) return ensured;
    }
    const targetKey = this._targetKey();
    const cacheKey = this._cacheKey(snapshot);
    const pointer = jellyfinPlaylistPointerStore.getPointer(snapshot.entityId, targetKey);
    const reusable = pointer?.serverUrl === this.client.url ? pointer : null;
    const itemIds = this._resolveItemIds(snapshot);
    if (!snapshot.tracks.length) {
      await this._deleteCurrent(snapshot);
      this._pendingSnapshots.delete(cacheKey);
      return playbackOperationSuccess();
    }
    if (!itemIds.length) {
      this._pendingSnapshots.set(cacheKey, snapshot);
      this._scheduleCatchup();
      return playbackOperationSuccess();
    }
    const unresolved = itemIds.length < snapshot.tracks.length;
    if (unresolved && reusable) {
      this._pendingSnapshots.set(cacheKey, snapshot);
      this._scheduleCatchup();
      return playbackOperationSuccess();
    }
    const hash = this._hash(snapshot, itemIds);
    if (!unresolved && this._syncHashes.get(cacheKey) === hash) return playbackOperationSuccess();

    let playlistId = reusable?.playlistId || null;
    if (playlistId) {
      try {
        await this.client.updatePlaylist(playlistId, {
          name: snapshot.displayName,
          itemIds,
        });
      } catch (error) {
        if (!isNotFound(error)) throw error;
        playlistId = null;
        jellyfinPlaylistPointerStore.deletePointer(snapshot.entityId, targetKey);
      }
    }
    if (!playlistId) {
      const created = await this.client.createPlaylist({
        name: snapshot.displayName,
        itemIds,
      });
      playlistId = itemId(created);
    }
    if (!playlistId) throw new Error("Jellyfin did not return a playlist ID");
    jellyfinPlaylistPointerStore.setPointer(snapshot.entityId, targetKey, {
      playlistId,
      title: snapshot.displayName,
      serverUrl: this.client.url,
    });
    if (unresolved) {
      this._pendingSnapshots.set(cacheKey, snapshot);
      this._scheduleCatchup();
    } else {
      this._pendingSnapshots.delete(cacheKey);
      this._syncHashes.set(cacheKey, hash);
    }
    return playbackOperationSuccess();
  }

  async publishPlaylist(value) {
    let snapshot;
    try {
      snapshot = createPlaybackPlaylistSnapshot(value);
      return await this._runPlaylistOperation(this._cacheKey(snapshot), () =>
        this._publishPlaylist(snapshot));
    } catch (error) {
      if (snapshot && this.isConfigured()) {
        this._pendingSnapshots.set(this._cacheKey(snapshot), snapshot);
        this._scheduleCatchup();
      }
      return playbackOperationFailure({
        code: "PLAYLIST_PUBLISH_FAILED",
        message: error?.message || "Could not publish the Jellyfin playlist",
        retryable: true,
      });
    }
  }

  async deletePlaylist(value) {
    try {
      const identity = createPlaybackPlaylistIdentity(value);
      const key = this._cacheKey(identity);
      if (!this.isConfigured()) return playbackOperationSuccess();
      await this._runPlaylistOperation(key, () => this._deleteCurrent(identity));
      this._pendingSnapshots.delete(key);
      this._syncHashes.delete(key);
      return playbackOperationSuccess();
    } catch (error) {
      return playbackOperationFailure({
        code: "PLAYLIST_DELETE_FAILED",
        message: error?.message || "Could not delete the Jellyfin playlist",
        retryable: true,
      });
    }
  }

  async requestScan() {
    if (!this.isConfigured()) return playbackOperationSuccess();
    try {
      await this.client.scanLibrary();
      this._libraryTracks = null;
      this._scheduleCatchup();
      return playbackOperationSuccess();
    } catch (error) {
      return playbackOperationFailure({
        code: "SCAN_FAILED",
        message: error?.message || "Could not scan the Jellyfin library",
        retryable: true,
      });
    }
  }

  _scheduleCatchup(delaysMs = [30_000, 90_000, 180_000]) {
    if (this._catchupRunning || !this._pendingSnapshots.size) return;
    this._catchupRunning = true;
    const run = async () => {
      try {
        for (const delayMs of delaysMs) {
          await wait(delayMs, undefined, { ref: false });
          if (!this.isConfigured() || !this._pendingSnapshots.size) break;
          for (const snapshot of [...this._pendingSnapshots.values()]) {
            const key = this._cacheKey(snapshot);
            if (this._pendingSnapshots.get(key) !== snapshot) continue;
            await this.publishPlaylist(snapshot);
          }
        }
      } catch (error) {
        console.warn("[JellyfinPlaybackDestination] Jellyfin catch-up failed:", error?.message);
      } finally {
        this._catchupRunning = false;
      }
    };
    run();
  }
}
