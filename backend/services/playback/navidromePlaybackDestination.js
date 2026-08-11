import fs from "node:fs/promises";
import path from "node:path";
import { setTimeout as wait } from "node:timers/promises";
import { userOps } from "../../db/helpers/index.js";
import { NavidromeClient } from "../navidrome.js";
import { navidromePlaylistPointerStore } from "../navidrome/navidromePlaylistPointerStore.js";
import {
  PLAYLIST_LIBRARY_DIR,
  resolvePlaylistRoot,
} from "../playlistPaths.js";
import { flowPlaylistConfig } from "../weeklyFlow/weeklyFlowPlaylistConfig.js";
import {
  createPlaybackPlaylistIdentity,
  createPlaybackPlaylistSnapshot,
  playbackOperationFailure,
  playbackOperationSuccess,
} from "./playbackDestination.js";

const ARTWORK_FILE_EXTENSIONS = [".webp", ".jpg", ".png"];
const ARTWORK_SUPPRESS_SUFFIX = ".no-artwork";
const PLAYLIST_FILE_EXTENSIONS = [".m3u", ".nsp"];
const SONG_LOOKUP_BATCH_SIZE = 5;

export class NavidromePlaybackDestination {
  constructor(weeklyFlowRoot = resolvePlaylistRoot(), { client = null } = {}) {
    this.key = "navidrome";
    this.name = "Navidrome";
    this.weeklyFlowRoot = resolvePlaylistRoot(weeklyFlowRoot);
    this.playlistLibraryRoot = path.join(this.weeklyFlowRoot, PLAYLIST_LIBRARY_DIR);
    this.libraryRoot = path.join(this.playlistLibraryRoot, "_playlists");
    this.client = client;
    this._configKey = "";
    this._playlists = null;
    this._pendingSnapshots = new Map();
    this._catchupRunning = false;
    this._publishInFlight = new Map();
    this._syncHashes = new Map();
  }

  updateConfig(config = {}) {
    const key = JSON.stringify({
      url: config.url || "",
      username: config.username || "",
      password: config.password || "",
    });
    if (key === this._configKey) return;
    this._configKey = key;
    this._playlists = null;
    this._pendingSnapshots.clear();
    this._syncHashes.clear();
    this.client = config.url && config.username && config.password
      ? new NavidromeClient(config.url, config.username, config.password)
      : null;
  }

  isConfigured() {
    return Boolean(this.client?.isConfigured());
  }

  _sanitize(value) {
    return String(value || "").replace(/[<>:"/\\|?*]/g, "_").trim();
  }

  getPlaylistNames({ entityId, ownerUserId = null, displayName } = {}) {
    const name = String(displayName || "").trim();
    const owner = ownerUserId == null ? null : userOps.getUserById(ownerUserId);
    const current = owner?.username ? `${owner.username} - ${name}` : name;
    const shared = Boolean(flowPlaylistConfig.getSharedPlaylist(entityId));
    const legacy = shared
      ? [name, `[AS] ${name}`, `Aurral Shared ${name}`]
      : [name, `[A] ${name}`, `Aurral ${name}`];
    return { current, legacy: legacy.filter((candidate) => candidate !== current) };
  }

  getPlaylistName(playlist) {
    return this.getPlaylistNames(playlist).current;
  }

  _targetKey(ownerUserId) {
    return String(ownerUserId ?? "global");
  }

  _getEntity(entityId) {
    return flowPlaylistConfig.getFlow(entityId) || flowPlaylistConfig.getSharedPlaylist(entityId);
  }

  _getNamesForIdentity(identity) {
    const entity = this._getEntity(identity.entityId);
    if (!entity) return null;
    return this.getPlaylistNames({
      entityId: identity.entityId,
      ownerUserId: identity.ownerUserId,
      displayName: entity.name,
    });
  }

  async _loadPlaylists(force = false) {
    if (!this.isConfigured()) return [];
    if (!force && this._playlists) return this._playlists;
    try {
      await this._fetchPlaylists();
    } catch (error) {
      console.warn("[NavidromePlaybackDestination] getPlaylists failed:", error?.message);
      this._playlists = [];
    }
    return this._playlists;
  }

  async _fetchPlaylists() {
    const playlists = await this.client.getPlaylists();
    this._playlists = Array.isArray(playlists) ? playlists : playlists ? [playlists] : [];
    return this._playlists;
  }

  async _deleteNativePlaylists(names) {
    const playlists = await this._loadPlaylists();
    for (const name of [...new Set((names || []).filter(Boolean))]) {
      const playlist = playlists.find((candidate) => candidate.name === name);
      if (!playlist || navidromePlaylistPointerStore.hasPlaylistId(playlist.id)) continue;
      try {
        await this.client.deletePlaylist(playlist.id);
        this._playlists = this._playlists.filter((candidate) => candidate.id !== playlist.id);
      } catch (error) {
        console.warn(
          `[NavidromePlaybackDestination] Failed to delete playlist "${name}":`,
          error?.message,
        );
      }
    }
  }

  async _deleteFiles(names, extensions) {
    for (const name of [...new Set((names || []).filter(Boolean))]) {
      const baseName = this._sanitize(name);
      for (const extension of extensions) {
        try {
          await fs.unlink(path.join(this.libraryRoot, `${baseName}${extension}`));
        } catch {}
      }
    }
  }

  _expectedFiles() {
    const expected = new Set();
    const addArtwork = (name) => {
      const baseName = this._sanitize(name);
      for (const extension of ARTWORK_FILE_EXTENSIONS) expected.add(`${baseName}${extension}`);
    };
    const addPlaylist = (entity) => {
      const names = this.getPlaylistNames({
        entityId: entity.id,
        ownerUserId: entity.ownerUserId,
        displayName: entity.name,
      });
      for (const name of [names.current, ...names.legacy]) {
        expected.add(`${this._sanitize(name)}.m3u`);
      }
      addArtwork(names.current);
    };
    for (const flow of flowPlaylistConfig.getFlows()) {
      if (flow.enabled) addPlaylist(flow);
      else addArtwork(this.getPlaylistName({
        entityId: flow.id,
        ownerUserId: flow.ownerUserId,
        displayName: flow.name,
      }));
    }
    for (const playlist of flowPlaylistConfig.getSharedPlaylists()) addPlaylist(playlist);
    return expected;
  }

  async _cleanupStaleFiles() {
    const expected = this._expectedFiles();
    const files = await fs.readdir(this.libraryRoot).catch(() => []);
    for (const file of files) {
      const extension = path.extname(file).toLowerCase();
      if (
        !ARTWORK_FILE_EXTENSIONS.includes(extension)
        && !PLAYLIST_FILE_EXTENSIONS.includes(extension)
      ) continue;
      if (expected.has(file)) continue;
      if (PLAYLIST_FILE_EXTENSIONS.includes(extension)) {
        const name = path.basename(file, extension);
        const playlists = await this._loadPlaylists();
        if (playlists.some((playlist) => this._sanitize(playlist.name) === name)) continue;
      }
      try {
        await fs.unlink(path.join(this.libraryRoot, file));
      } catch {}
    }
  }

  async testConnection() {
    if (!this.isConfigured()) {
      return playbackOperationFailure({
        code: "DESTINATION_NOT_CONFIGURED",
        message: "Navidrome is not configured",
      });
    }
    try {
      await this.client.ping();
      return playbackOperationSuccess();
    } catch (error) {
      return playbackOperationFailure({
        code: "DESTINATION_UNAVAILABLE",
        message: error?.message || "Navidrome did not respond",
        retryable: true,
      });
    }
  }

  async ensureLibrary() {
    try {
      await fs.mkdir(this.libraryRoot, { recursive: true });
      if (this.isConfigured()) {
        await this.client.ensureWeeklyFlowLibrary(
          this.playlistLibraryRoot.replace(/\\/g, "/").replace(/\/+$/, ""),
        );
        await this._loadPlaylists(true);
      }
      await this._cleanupStaleFiles();
      return playbackOperationSuccess();
    } catch (error) {
      return playbackOperationFailure({
        code: "LIBRARY_SETUP_FAILED",
        message: error?.message || "Could not prepare the Navidrome playlist library",
        retryable: true,
      });
    }
  }

  async _publishPlaylist(snapshot) {
    await fs.mkdir(this.libraryRoot, { recursive: true });
    const { current, legacy } = this.getPlaylistNames(snapshot);
    const targetKey = this._targetKey(snapshot.ownerUserId);
    const syncKey = `${snapshot.entityId}:${targetKey}`;
    const syncHash = JSON.stringify(snapshot);
    let pointer = navidromePlaylistPointerStore.getPointer(snapshot.entityId, targetKey);
    if (pointer && this._syncHashes.get(syncKey) === syncHash) {
      return playbackOperationSuccess();
    }
    const files = await fs.readdir(this.libraryRoot).catch(() => []);
    const normalizeTrackPath = (value) => path
      .normalize(String(value || "").replace(/\\/g, "/"))
      .toLowerCase();
    const trackPaths = new Set(
      snapshot.tracks.map((track) => normalizeTrackPath(track.path)),
    );
    const importedPlaylistNames = [];
    for (const file of files) {
      if (!PLAYLIST_FILE_EXTENSIONS.includes(path.extname(file).toLowerCase())) continue;
      const name = path.basename(file, path.extname(file));
      if ([current, ...legacy].includes(name)) {
        importedPlaylistNames.push(name);
        continue;
      }
      const content = await fs.readFile(path.join(this.libraryRoot, file), "utf8").catch(() => "");
      const matchesTrack = content
        .split(/\r?\n/)
        .filter((line) => line && !line.startsWith("#"))
        .some((line) => trackPaths.has(normalizeTrackPath(line)));
      if (matchesTrack) importedPlaylistNames.push(name);
    }
    let importedPlaylistName = null;
    if (!pointer && importedPlaylistNames.length) {
      const playlists = await this._loadPlaylists();
      const importedPlaylist = playlists.find(
        (playlist) => importedPlaylistNames.includes(playlist.name)
          && !navidromePlaylistPointerStore.hasPlaylistId(playlist.id),
      );
      if (importedPlaylist) {
        importedPlaylistName = importedPlaylist.name;
        pointer = { playlistId: importedPlaylist.id, title: importedPlaylist.name };
        navidromePlaylistPointerStore.setPointer(snapshot.entityId, targetKey, pointer);
      }
    }
    if (
      pointer?.title
      && pointer.title !== current
      && typeof this.client.renamePlaylist === "function"
    ) {
      await this.client.renamePlaylist(pointer.playlistId, current);
      pointer = { ...pointer, title: current };
      navidromePlaylistPointerStore.setPointer(snapshot.entityId, targetKey, pointer);
    }
    const songs = [];
    for (let index = 0; index < snapshot.tracks.length; index += SONG_LOOKUP_BATCH_SIZE) {
      const batch = snapshot.tracks.slice(index, index + SONG_LOOKUP_BATCH_SIZE);
      songs.push(...await Promise.all(
        batch.map((track) => this.client.findSong(track.title, track.artist, track)),
      ));
    }
    if (songs.some((song) => !song?.id)) {
      this._pendingSnapshots.set(`${snapshot.entityId}:${targetKey}`, snapshot);
      return playbackOperationSuccess();
    }

    let playlist = null;
    if (pointer) {
      for (const delayMs of [0, 250, 1000, 2000]) {
        if (delayMs) await wait(delayMs);
        try {
          await this.client.updatePlaylist(pointer.playlistId, {
            name: current,
            songIds: songs.map((song) => song.id),
          });
          playlist = { id: pointer.playlistId };
          break;
        } catch (error) {
          if (Number(error?.code) !== 70) throw error;
        }
      }
      if (!playlist) {
        navidromePlaylistPointerStore.deletePointer(snapshot.entityId, targetKey);
      }
    }
    if (!playlist) {
      const playlists = await this._fetchPlaylists();
      if (importedPlaylistNames.length) playlist = playlists.find((candidate) =>
        importedPlaylistNames.includes(candidate.name)
        && !navidromePlaylistPointerStore.hasPlaylistId(candidate.id),
      );
      const songIds = songs.map((song) => song.id);
      if (playlist) {
        await this.client.updatePlaylist(playlist.id, { name: current, songIds });
      } else {
        playlist = await this.client.createPlaylist(current, songIds);
      }
    }
    if (!playlist?.id) throw new Error("Navidrome did not return a playlist ID");
    navidromePlaylistPointerStore.setPointer(snapshot.entityId, targetKey, {
      playlistId: playlist.id,
      title: current,
    });
    this._pendingSnapshots.delete(`${snapshot.entityId}:${targetKey}`);
    this._playlists = null;
    const cleanupNames = [current, ...legacy, importedPlaylistName, pointer?.title];
    await this._deleteNativePlaylists([...legacy, importedPlaylistName, pointer?.title]);
    await this._deleteFiles(cleanupNames, PLAYLIST_FILE_EXTENSIONS);
    await this._deleteFiles(legacy, [
      ...PLAYLIST_FILE_EXTENSIONS,
      ...ARTWORK_FILE_EXTENSIONS,
      ARTWORK_SUPPRESS_SUFFIX,
    ]);
    this._syncHashes.set(syncKey, syncHash);
    return playbackOperationSuccess();
  }

  async publishPlaylist(value) {
    try {
      const snapshot = createPlaybackPlaylistSnapshot(value);
      const key = `${snapshot.entityId}:${this._targetKey(snapshot.ownerUserId)}`;
      const previous = this._publishInFlight.get(key) || Promise.resolve();
      const operation = previous.catch(() => {}).then(() => this._publishPlaylist(snapshot));
      this._publishInFlight.set(key, operation);
      try {
        return await operation;
      } finally {
        if (this._publishInFlight.get(key) === operation) this._publishInFlight.delete(key);
      }
    } catch (error) {
      return playbackOperationFailure({
        code: "PLAYLIST_PUBLISH_FAILED",
        message: error?.message || "Could not publish the Navidrome playlist",
        retryable: true,
      });
    }
  }

  async deletePlaylist(value) {
    try {
      const identity = createPlaybackPlaylistIdentity(value);
      const names = this._getNamesForIdentity(identity);
      if (!names) return playbackOperationSuccess();
      const targetKey = this._targetKey(identity.ownerUserId);
      const pointer = navidromePlaylistPointerStore.getPointer(identity.entityId, targetKey);
      let pointerError = null;
      let pointerResolved = !pointer;
      if (pointer && this.isConfigured()) {
        try {
          await this.client.deletePlaylist(pointer.playlistId);
          pointerResolved = true;
        } catch (error) {
          pointerError = error;
        }
      }
      if (pointerResolved) {
        navidromePlaylistPointerStore.deletePointer(identity.entityId, targetKey);
      }
      this._pendingSnapshots.delete(`${identity.entityId}:${targetKey}`);
      this._syncHashes.delete(`${identity.entityId}:${targetKey}`);
      this._playlists = null;
      await this._deleteNativePlaylists([names.current, ...names.legacy]);
      await this._deleteFiles([names.current], PLAYLIST_FILE_EXTENSIONS);
      await this._deleteFiles(names.legacy, [
        ...PLAYLIST_FILE_EXTENSIONS,
        ...ARTWORK_FILE_EXTENSIONS,
        ARTWORK_SUPPRESS_SUFFIX,
      ]);
      if (pointerError) throw pointerError;
      return playbackOperationSuccess();
    } catch (error) {
      return playbackOperationFailure({
        code: "PLAYLIST_DELETE_FAILED",
        message: error?.message || "Could not delete the Navidrome playlist",
        retryable: true,
      });
    }
  }

  async requestScan() {
    if (!this.isConfigured()) return playbackOperationSuccess();
    try {
      await this.client.scanLibrary();
      this._scheduleCatchup();
      return playbackOperationSuccess();
    } catch (error) {
      return playbackOperationFailure({
        code: "SCAN_FAILED",
        message: error?.message || "Could not scan the Navidrome library",
        retryable: true,
      });
    }
  }

  _scheduleCatchup(delaysMs = [30000, 90000, 180000]) {
    if (this._catchupRunning || !this._pendingSnapshots.size) return;
    this._catchupRunning = true;
    const run = async () => {
      try {
        for (const delayMs of delaysMs) {
          await wait(delayMs, undefined, { ref: false });
          if (!this.isConfigured() || !this._pendingSnapshots.size) break;
          for (const snapshot of [...this._pendingSnapshots.values()]) {
            await this.publishPlaylist(snapshot);
          }
        }
      } catch (error) {
        console.warn("[NavidromePlaybackDestination] Navidrome catch-up failed:", error?.message);
      } finally {
        this._catchupRunning = false;
      }
    };
    run();
  }
}
