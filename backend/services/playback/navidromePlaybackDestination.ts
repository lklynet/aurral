import fs from "node:fs/promises";
import path from "node:path";
import { setTimeout as wait } from "node:timers/promises";
import { userOps } from "../../db/helpers/index.ts";
import type { StoredIntegrations } from "../../db/helpers/settings.ts";
import { NavidromeClient } from "../navidrome.ts";
import { logger } from "../logger.ts";
import { getPathMappings, resolveLocalPath, resolveRemotePath } from "../pathMappings.ts";
import { navidromePlaylistPointerStore } from "../navidrome/navidromePlaylistPointerStore.ts";
import { claimUnmatchedRootWarning, serverScanTargets } from "./playbackScanFolders.ts";
import { AURRAL_FLOWS_DIR, PLAYLIST_FILES_DIR, resolveDownloadRoot } from "../downloadPaths.ts";
import { flowPlaylistConfig } from "../playlists/flowPlaylistConfig.ts";
import {
  createPlaybackPlaylistIdentity,
  createPlaybackPlaylistSnapshot,
  isRetryablePlaybackError,
  playbackOperationFailure,
  playbackOperationSuccess,
  playbackScanDeferred,
} from "./playbackDestination.ts";

const ARTWORK_FILE_EXTENSIONS = [".webp", ".jpg", ".png"];
const ARTWORK_SUPPRESS_SUFFIX = ".no-artwork";
const PLAYLIST_FILE_EXTENSIONS = [".m3u", ".nsp"];
const SONG_LOOKUP_BATCH_SIZE = 5;
const MAX_NAVIDROME_SCAN_TARGETS = 20;

type PlaybackSnapshot = ReturnType<typeof createPlaybackPlaylistSnapshot>;
type PlaybackIdentity = ReturnType<typeof createPlaybackPlaylistIdentity>;
type PlaybackSnapshotInput = Parameters<typeof createPlaybackPlaylistSnapshot>[0];
type PlaybackIdentityInput = Parameters<typeof createPlaybackPlaylistIdentity>[0];
type PlaylistRef = { entityId: string; ownerUserId?: number | null };
type PlaylistNamesInput = PlaylistRef & { displayName?: string | null };
type PlaylistEntity = { id: string; name: string; ownerUserId: number | null };
type PointerValue = Parameters<typeof navidromePlaylistPointerStore.setPointer>[2];
type NavidromePlaylist = Awaited<ReturnType<NavidromeClient["getPlaylists"]>>[number];
type ConfiguredNavidrome = NavidromePlaybackDestination & { client: NavidromeClient };

export const navidromeSettings = Object.freeze({
  key: "navidrome",
  label: "Navidrome",
  subtitle: "Subsonic",
  fields: Object.freeze([
    Object.freeze({ key: "url", label: "Server URL", type: "url", required: true }),
    Object.freeze({ key: "username", label: "Username", type: "text", required: true }),
    Object.freeze({
      key: "password",
      label: "Password",
      type: "password",
      required: true,
      secret: true,
    }),
    Object.freeze({
      key: "prefixOwnerUsername",
      label: "Prefix playlist names with the owner username",
      type: "toggle",
      section: "Behavior",
      hint: 'Publishes flow playlists as "username - playlist name".',
    }),
  ]),
  defaults: Object.freeze({
    url: "",
    username: "",
    password: "",
    prefixOwnerUsername: true,
  }),
  validation: Object.freeze({ required: ["url", "username", "password"], url: ["url"] }),
  testConnection: true,
});

function buildM3uContent(tracks: PlaybackSnapshot["tracks"]) {
  const lines = ["#EXTM3U"];
  for (const track of tracks) {
    const duration = Math.max(0, Math.round(Number(track.durationMs) / 1000 || 0));
    const label =
      track.artist && track.title
        ? `${track.artist} - ${track.title}`
        : track.title || track.artist || "";
    lines.push(`#EXTINF:${duration},${label}`);
    lines.push(String(track.path || "").replace(/\\/g, "/"));
  }
  return `${lines.join("\n")}\n`;
}

export class NavidromePlaybackDestination {
  declare key: string;
  declare name: string;
  declare downloadRoot: string;
  declare playlistFilesRoot: string;
  declare mediaLibraryRoot: string;
  declare libraryRoot: string;
  declare client: NavidromeClient | null;
  declare _prefixOwnerUsername: boolean;
  declare _connectionKey: string;
  declare _configGeneration: number;
  declare _playlists: NavidromePlaylist[] | null;
  declare _publishInFlight: Map<string, Promise<unknown>>;
  declare _syncHashes: Map<string, string>;
  declare _warnedUnmatchedRoots: Set<string>;

  constructor(
    downloadRoot = resolveDownloadRoot(),
    { client = null }: { client?: NavidromeClient | null } = {},
  ) {
    this.key = "navidrome";
    this.name = "Navidrome";
    this.downloadRoot = resolveDownloadRoot(downloadRoot);
    this.playlistFilesRoot = path.join(this.downloadRoot, PLAYLIST_FILES_DIR);
    this.mediaLibraryRoot = this.downloadRoot;
    this.libraryRoot = path.join(this.playlistFilesRoot, "_playlists");
    this.client = client;
    this._prefixOwnerUsername = true;
    this._connectionKey = JSON.stringify({ url: "", username: "", password: "" });
    this._configGeneration = 0;
    this._playlists = null;
    this._publishInFlight = new Map();
    this._syncHashes = new Map();
    this._warnedUnmatchedRoots = new Set();
  }

  updateConfig(config: NonNullable<StoredIntegrations["navidrome"]> = {}) {
    const connectionKey = JSON.stringify({
      url: config.url || "",
      username: config.username || "",
      password: config.password || "",
    });
    const prefixOwnerUsername = config.prefixOwnerUsername !== false;
    const connectionChanged = connectionKey !== this._connectionKey;
    const namingChanged = prefixOwnerUsername !== this._prefixOwnerUsername;
    if (!connectionChanged && !namingChanged) return;

    this._connectionKey = connectionKey;
    this._prefixOwnerUsername = prefixOwnerUsername;
    this._warnedUnmatchedRoots.clear();

    if (connectionChanged) {
      this._playlists = null;
      this._syncHashes.clear();
      this._configGeneration += 1;
      this.client =
        config.url && config.username && config.password
          ? new NavidromeClient(config.url, config.username, config.password)
          : null;
    } else {
      this._playlists = null;
      this._syncHashes.clear();
      this._configGeneration += 1;
    }
  }

  isConfigured(): this is ConfiguredNavidrome {
    return Boolean(this.client?.isConfigured());
  }

  async getReferencedPaths(
    this: ConfiguredNavidrome,
    { excludeEntityIds = [] }: { excludeEntityIds?: string[] } = {},
  ) {
    const excluded = new Set(
      excludeEntityIds.flatMap((id) =>
        navidromePlaylistPointerStore.getPointersForEntity(id).map((pointer) => pointer.playlistId),
      ),
    );
    const paths = await this.client.getPlaylistTrackPaths(excluded);
    return {
      ok: true,
      paths: paths.map((file) => resolveLocalPath(file, getPathMappings("navidrome"))),
    };
  }

  _sanitize(value: string | null | undefined) {
    return String(value || "")
      .replace(/[<>:"/\\|?*]/g, "_")
      .trim();
  }

  getPlaylistNames({ entityId, ownerUserId = null, displayName }: PlaylistNamesInput = {}) {
    const name = String(displayName || "").trim();
    const owner = ownerUserId == null ? null : userOps.getUserById(ownerUserId);
    const prefixed = owner?.username ? `${owner.username} - ${name}` : name;
    const current = this._prefixOwnerUsername ? prefixed : name;
    const shared = Boolean(flowPlaylistConfig.getStaticPlaylist(entityId));
    const legacy = shared
      ? [name, `[AS] ${name}`, `Aurral Shared ${name}`, prefixed]
      : [name, `[A] ${name}`, `Aurral ${name}`, prefixed];
    return {
      current,
      legacy: [...new Set(legacy)].filter((candidate) => candidate !== current),
    };
  }

  getPlaylistName(playlist: PlaylistNamesInput) {
    return this.getPlaylistNames(playlist).current;
  }

  _targetKey(ownerUserId: number | null) {
    return String(ownerUserId ?? "global");
  }

  _getEntity(entityId: string) {
    return flowPlaylistConfig.getFlow(entityId) || flowPlaylistConfig.getStaticPlaylist(entityId);
  }

  _getNamesForIdentity(identity: PlaybackIdentity) {
    const entity = this._getEntity(identity.entityId);
    if (!entity) return null;
    return this.getPlaylistNames({
      entityId: identity.entityId,
      ownerUserId: identity.ownerUserId,
      displayName: entity.name,
    });
  }

  _getImportedSourceName(comment: string | null | undefined) {
    const match = String(comment || "").match(/Auto-imported from ['"]([^'"]+)['"]/i);
    if (!match) return null;
    return this._sanitize(path.basename(match[1], path.extname(match[1])));
  }

  _isActiveNameForOtherEntity(entityId: string, name: string) {
    const expected = this._sanitize(name);
    const entities = [...flowPlaylistConfig.getFlows(), ...flowPlaylistConfig.getStaticPlaylists()];
    return entities.some((entity) => {
      if (entity.id === entityId) return false;
      const names = this.getPlaylistNames({
        entityId: entity.id,
        ownerUserId: entity.ownerUserId,
        displayName: entity.name,
      });
      return [names.current, ...names.legacy].some(
        (candidate) => this._sanitize(candidate) === expected,
      );
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

  async _fetchPlaylists(this: ConfiguredNavidrome) {
    const playlists = await this.client.getPlaylists();
    this._playlists = Array.isArray(playlists) ? playlists : playlists ? [playlists] : [];
    return this._playlists;
  }

  async _deleteNativePlaylists(names: (string | null | undefined)[]) {
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

  async _deleteImportedPlaylists(this: ConfiguredNavidrome, name: string) {
    for (const playlist of await this._fetchPlaylists()) {
      if (playlist.name !== name || navidromePlaylistPointerStore.hasPlaylistId(playlist.id))
        continue;
      await this.client.deletePlaylist(playlist.id);
    }
  }

  async _deleteFiles(names: (string | null | undefined)[], extensions: string[]) {
    for (const name of [...new Set((names || []).filter(Boolean))]) {
      const baseName = this._sanitize(name);
      for (const extension of extensions) {
        try {
          await fs.unlink(path.join(this.libraryRoot, `${baseName}${extension}`));
        } catch {}
      }
    }
  }

  async _uploadPlaylistArtwork(snapshot: PlaylistNamesInput, playlistId: string) {
    if (typeof this.client?.uploadPlaylistArtwork !== "function") return;
    const { current } = this.getPlaylistNames(snapshot);
    for (const extension of ARTWORK_FILE_EXTENSIONS) {
      const artworkPath = path.join(this.libraryRoot, `${this._sanitize(current)}${extension}`);
      const data = await fs.readFile(artworkPath).catch(() => null);
      if (!data) continue;
      const contentType =
        extension === ".png" ? "image/png" : extension === ".jpg" ? "image/jpeg" : "image/webp";
      try {
        await this.client.uploadPlaylistArtwork(
          playlistId,
          data,
          path.basename(artworkPath),
          contentType,
        );
      } catch (error) {
        logger.debug("playback", "Failed to upload optional Navidrome playlist artwork", {
          message: error?.message || String(error),
        });
      }
      return;
    }
  }

  async syncPlaylistArtwork({ entityId, ownerUserId = null }: PlaylistRef = {}) {
    try {
      if (!this.isConfigured()) return playbackOperationSuccess();
      const entity = this._getEntity(entityId);
      const targetKey = this._targetKey(ownerUserId);
      const pointer = navidromePlaylistPointerStore.getPointer(entityId, targetKey);
      if (!entity || !pointer?.playlistId) return playbackOperationSuccess();
      await this._uploadPlaylistArtwork(
        {
          entityId,
          ownerUserId,
          displayName: entity.name,
        },
        pointer.playlistId,
      );
      return playbackOperationSuccess();
    } catch (error) {
      return playbackOperationFailure({
        code: "PLAYLIST_ARTWORK_SYNC_FAILED",
        message: error?.message || "Could not sync Navidrome playlist artwork",
        retryable: isRetryablePlaybackError(error),
      });
    }
  }

  async clearPlaylistArtwork({ entityId, ownerUserId = null }: PlaylistRef = {}) {
    try {
      if (!this.isConfigured() || typeof this.client?.deletePlaylistArtwork !== "function") {
        return playbackOperationSuccess();
      }
      const pointer = navidromePlaylistPointerStore.getPointer(
        entityId,
        this._targetKey(ownerUserId),
      );
      if (pointer?.playlistId) await this.client.deletePlaylistArtwork(pointer.playlistId);
      return playbackOperationSuccess();
    } catch (error) {
      return playbackOperationFailure({
        code: "PLAYLIST_ARTWORK_CLEAR_FAILED",
        message: error?.message || "Could not clear Navidrome playlist artwork",
        retryable: isRetryablePlaybackError(error),
      });
    }
  }

  _expectedFiles() {
    const expected = new Set();
    const addArtwork = (name: string) => {
      const baseName = this._sanitize(name);
      for (const extension of ARTWORK_FILE_EXTENSIONS) expected.add(`${baseName}${extension}`);
    };
    const addPlaylist = (entity: PlaylistEntity) => {
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
      else
        addArtwork(
          this.getPlaylistName({
            entityId: flow.id,
            ownerUserId: flow.ownerUserId,
            displayName: flow.name,
          }),
        );
    }
    for (const playlist of flowPlaylistConfig.getStaticPlaylists()) addPlaylist(playlist);
    return expected;
  }

  _removedEntityPlaylistNames() {
    const entityIds = new Set(
      [...flowPlaylistConfig.getFlows(), ...flowPlaylistConfig.getStaticPlaylists()].map(
        (entity) => entity.id,
      ),
    );
    return new Set(
      navidromePlaylistPointerStore
        .getEntityIds()
        .filter((entityId) => !entityIds.has(entityId))
        .flatMap((entityId) => navidromePlaylistPointerStore.getPointersForEntity(entityId))
        .map((pointer) => this._sanitize(pointer.title)),
    );
  }

  async _cleanupStaleFiles() {
    const expected = this._expectedFiles();
    const removedNames = this._removedEntityPlaylistNames();
    const files = await fs.readdir(this.libraryRoot).catch(() => []);
    for (const file of files) {
      const extension = path.extname(file).toLowerCase();
      if (
        !ARTWORK_FILE_EXTENSIONS.includes(extension) &&
        !PLAYLIST_FILE_EXTENSIONS.includes(extension)
      )
        continue;
      if (expected.has(file)) continue;
      const name = path.basename(file, extension);
      if (PLAYLIST_FILE_EXTENSIONS.includes(extension) && !removedNames.has(name)) {
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
        retryable: isRetryablePlaybackError(error),
      });
    }
  }

  async ensureLibrary() {
    try {
      await fs.mkdir(this.libraryRoot, { recursive: true });
      await fs.mkdir(path.join(this.downloadRoot, AURRAL_FLOWS_DIR), { recursive: true });
      if (this.isConfigured()) {
        await this.client.ensureAurralLibrary(
          resolveRemotePath(this.mediaLibraryRoot, getPathMappings("navidrome")),
        );
        await this._loadPlaylists(true);
      }
      await this._cleanupStaleFiles();
      return playbackOperationSuccess();
    } catch (error) {
      return playbackOperationFailure({
        code: "LIBRARY_SETUP_FAILED",
        message: error?.message || "Could not prepare the Navidrome playlist library",
        retryable: isRetryablePlaybackError(error),
      });
    }
  }

  async _publishPlaylist(this: ConfiguredNavidrome, snapshot: PlaybackSnapshot) {
    const configGeneration = this._configGeneration;
    await fs.mkdir(this.libraryRoot, { recursive: true });
    const { current, legacy } = this.getPlaylistNames(snapshot);
    const targetKey = this._targetKey(snapshot.ownerUserId);
    const syncKey = `${snapshot.entityId}:${targetKey}`;
    const syncHash = JSON.stringify(snapshot);
    let pointer: PointerValue | null = navidromePlaylistPointerStore.getPointer(
      snapshot.entityId,
      targetKey,
    );
    const fileOnlyTitle = pointer && !pointer.playlistId ? pointer.title : null;
    if (fileOnlyTitle) pointer = null;
    let stalePointerTitle = null;
    let stalePointerDetected = false;
    if (pointer && typeof this.client.getPlaylist === "function") {
      let nativePlaylist;
      let pointerIsStale = false;
      try {
        nativePlaylist = await this.client.getPlaylist(pointer.playlistId!);
      } catch (error) {
        if (Number(error?.code) !== 70) throw error;
        pointerIsStale = true;
      }
      if (pointerIsStale) {
        stalePointerDetected = true;
        stalePointerTitle = pointer.title;
        await this._fetchPlaylists();
        navidromePlaylistPointerStore.deletePointer(snapshot.entityId, targetKey);
        pointer = null;
      } else {
        const importedSourceName = this._getImportedSourceName(nativePlaylist?.comment);
        if (
          importedSourceName &&
          this._isActiveNameForOtherEntity(snapshot.entityId, importedSourceName)
        ) {
          navidromePlaylistPointerStore.deletePointer(snapshot.entityId, targetKey);
          pointer = null;
        }
      }
    }
    if (pointer && this._syncHashes.get(syncKey) === syncHash) {
      return playbackOperationSuccess();
    }
    const files = await fs.readdir(this.libraryRoot).catch(() => []);
    const normalizeTrackPath = (value: string) =>
      path.normalize(String(value || "").replace(/\\/g, "/")).toLowerCase();
    const trackPaths = new Set(snapshot.tracks.map((track) => normalizeTrackPath(track.path)));
    const importedPlaylistNames: string[] = [];
    for (const file of files) {
      if (!PLAYLIST_FILE_EXTENSIONS.includes(path.extname(file).toLowerCase())) continue;
      const name = path.basename(file, path.extname(file));
      if ([current, ...legacy].includes(name)) {
        importedPlaylistNames.push(name);
        continue;
      }
      const content = await fs.readFile(path.join(this.libraryRoot, file), "utf8").catch(() => "");
      const importedTrackPaths = new Set(
        content
          .split(/\r?\n/)
          .filter((line) => line && !line.startsWith("#"))
          .map(normalizeTrackPath),
      );
      const matchesTrackSet =
        trackPaths.size > 0 &&
        importedTrackPaths.size === trackPaths.size &&
        [...importedTrackPaths].every((trackPath) => trackPaths.has(trackPath));
      if (matchesTrackSet) importedPlaylistNames.push(name);
    }
    let importedPlaylistName = null;
    if (!pointer) {
      const playlists = await this._loadPlaylists();
      const recoveryNames = [current, ...legacy, stalePointerTitle, fileOnlyTitle].filter(Boolean);
      const recoveryNameSet = new Set(recoveryNames);
      const recoverySourceNames: Set<string | null> = new Set(
        recoveryNames.map((name) => this._sanitize(name)),
      );
      const importedPlaylist = playlists.find((playlist) => {
        const importedSourceName = this._getImportedSourceName(playlist.comment);
        const sourceBelongsToOtherEntity =
          stalePointerDetected &&
          importedSourceName &&
          this._isActiveNameForOtherEntity(snapshot.entityId, importedSourceName);
        return (
          !sourceBelongsToOtherEntity &&
          (importedPlaylistNames.includes(playlist.name) ||
            (stalePointerDetected && recoveryNameSet.has(playlist.name)) ||
            recoverySourceNames.has(importedSourceName)) &&
          !navidromePlaylistPointerStore.hasPlaylistId(playlist.id)
        );
      });
      if (importedPlaylist) {
        importedPlaylistName = importedPlaylist.name;
        pointer = { playlistId: importedPlaylist.id, title: importedPlaylist.name };
        navidromePlaylistPointerStore.setPointer(snapshot.entityId, targetKey, pointer);
      }
    }
    if (
      pointer?.title &&
      pointer.title !== current &&
      typeof this.client.renamePlaylist === "function"
    ) {
      await this.client.renamePlaylist(pointer.playlistId!, current);
      pointer = { ...pointer, title: current };
      navidromePlaylistPointerStore.setPointer(snapshot.entityId, targetKey, pointer);
    }
    const mappings = getPathMappings("navidrome");
    const remoteTracks = snapshot.tracks.map((track) => ({
      ...track,
      path: resolveRemotePath(track.path, mappings),
    }));
    const songs = [];
    for (let index = 0; index < remoteTracks.length; index += SONG_LOOKUP_BATCH_SIZE) {
      const batch = remoteTracks.slice(index, index + SONG_LOOKUP_BATCH_SIZE);
      songs.push(
        ...(await Promise.all(
          batch.map((track) => this.client.findSong(track.title, track.artist, track)),
        )),
      );
    }
    const hasUnresolvedSongs = songs.some((song) => !song?.id);
    const songIds = songs.filter((song) => song?.id).map((song) => song.id);
    if (snapshot.tracks.length && !songIds.length && !pointer) {
      navidromePlaylistPointerStore.setPointer(snapshot.entityId, targetKey, {
        playlistId: null,
        title: current,
      });
      if (fileOnlyTitle && fileOnlyTitle !== current)
        await this._deleteFiles([fileOnlyTitle], PLAYLIST_FILE_EXTENSIONS);
      await fs.writeFile(
        path.join(this.libraryRoot, `${this._sanitize(current)}.m3u`),
        buildM3uContent(remoteTracks),
        "utf8",
      );
      return playbackOperationSuccess({ pending: true });
    }
    if (pointer && hasUnresolvedSongs && !songIds.length) {
      return playbackOperationSuccess({ pending: true });
    }

    let playlist = null;
    let artworkNeedsUpload = false;
    if (pointer) {
      for (const delayMs of [0, 250, 1000, 2000]) {
        if (delayMs) await wait(delayMs);
        try {
          await this.client.updatePlaylist(pointer.playlistId!, {
            name: current,
            songIds,
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
      if (importedPlaylistNames.length)
        playlist = playlists.find(
          (candidate) =>
            importedPlaylistNames.includes(candidate.name) &&
            !navidromePlaylistPointerStore.hasPlaylistId(candidate.id),
        );
      if (playlist) {
        await this.client.updatePlaylist(playlist.id, { name: current, songIds });
      } else {
        playlist = await this.client.createPlaylist(current, songIds);
        artworkNeedsUpload = true;
      }
    }
    if (!playlist?.id) throw new Error("Navidrome did not return a playlist ID");
    navidromePlaylistPointerStore.setPointer(snapshot.entityId, targetKey, {
      playlistId: playlist.id,
      title: current,
    });
    if (artworkNeedsUpload) await this._uploadPlaylistArtwork(snapshot, playlist.id);
    if (hasUnresolvedSongs) return playbackOperationSuccess({ pending: true });
    this._playlists = null;
    const cleanupNames = [current, ...legacy, importedPlaylistName, pointer?.title];
    await this._deleteNativePlaylists([...legacy, importedPlaylistName, pointer?.title]);
    await this._deleteFiles(cleanupNames, PLAYLIST_FILE_EXTENSIONS);
    await this._deleteFiles(legacy, [
      ...PLAYLIST_FILE_EXTENSIONS,
      ...ARTWORK_FILE_EXTENSIONS,
      ARTWORK_SUPPRESS_SUFFIX,
    ]);
    if (configGeneration === this._configGeneration) {
      this._syncHashes.set(syncKey, syncHash);
    }
    return playbackOperationSuccess();
  }

  async _runPlaylistOperation<T>(key: string, operation: () => Promise<T>) {
    const previous = this._publishInFlight.get(key) || Promise.resolve();
    const queued = previous.catch(() => {}).then(operation);
    this._publishInFlight.set(key, queued);
    try {
      return await queued;
    } finally {
      if (this._publishInFlight.get(key) === queued) this._publishInFlight.delete(key);
    }
  }

  async publishPlaylist(this: ConfiguredNavidrome, value: PlaybackSnapshotInput) {
    try {
      const snapshot = createPlaybackPlaylistSnapshot(value);
      const key = `${snapshot.entityId}:${this._targetKey(snapshot.ownerUserId)}`;
      return await this._runPlaylistOperation(key, () => this._publishPlaylist(snapshot));
    } catch (error) {
      return playbackOperationFailure({
        code: "PLAYLIST_PUBLISH_FAILED",
        message: error?.message || "Could not publish the Navidrome playlist",
        retryable: isRetryablePlaybackError(error),
      });
    }
  }

  async _deleteTarget(
    entityId: string,
    targetKey: string,
    names: { current: string | null; legacy: string[] },
  ) {
    const key = `${entityId}:${targetKey}`;
    return this._runPlaylistOperation(key, async () => {
      const pointer = navidromePlaylistPointerStore.getPointer(entityId, targetKey);
      const fileOnlyName =
        pointer && !pointer.playlistId && !this._isActiveNameForOtherEntity(entityId, pointer.title)
          ? pointer.title
          : null;
      let pointerError = null;
      let pointerResolved = !pointer;
      if (pointer && this.isConfigured()) {
        try {
          if (pointer.playlistId) await this.client.deletePlaylist(pointer.playlistId);
          else if (fileOnlyName) await this._deleteImportedPlaylists(fileOnlyName);
          pointerResolved = true;
        } catch (error) {
          if (Number(error?.code) === 70) pointerResolved = true;
          else pointerError = error;
        }
      }
      if (pointerResolved) {
        navidromePlaylistPointerStore.deletePointer(entityId, targetKey);
      }
      this._syncHashes.delete(key);
      this._playlists = null;
      await this._deleteNativePlaylists([names.current, ...names.legacy]);
      await this._deleteFiles([names.current, fileOnlyName], PLAYLIST_FILE_EXTENSIONS);
      await this._deleteFiles(names.legacy, [
        ...PLAYLIST_FILE_EXTENSIONS,
        ...ARTWORK_FILE_EXTENSIONS,
        ARTWORK_SUPPRESS_SUFFIX,
      ]);
      if (pointerError) throw pointerError;
      return playbackOperationSuccess();
    });
  }

  async deletePlaylist(value: PlaybackIdentityInput) {
    try {
      const identity = createPlaybackPlaylistIdentity(value);
      const names = this._getNamesForIdentity(identity);
      if (!names) return playbackOperationSuccess();
      return await this._deleteTarget(
        identity.entityId,
        this._targetKey(identity.ownerUserId),
        names,
      );
    } catch (error) {
      return playbackOperationFailure({
        code: "PLAYLIST_DELETE_FAILED",
        message: error?.message || "Could not delete the Navidrome playlist",
        retryable: isRetryablePlaybackError(error),
      });
    }
  }

  getPointerEntityIds() {
    return navidromePlaylistPointerStore.getEntityIds();
  }

  async deleteEntityPlaylists(entityId: string) {
    try {
      for (const pointer of navidromePlaylistPointerStore.getPointersForEntity(entityId)) {
        const current = this._isActiveNameForOtherEntity(entityId, pointer.title)
          ? null
          : pointer.title;
        await this._deleteTarget(entityId, pointer.targetKey, { current, legacy: [] });
      }
      return playbackOperationSuccess();
    } catch (error) {
      return playbackOperationFailure({
        code: "PLAYLIST_DELETE_FAILED",
        message: error?.message || "Could not delete the Navidrome playlist",
        retryable: isRetryablePlaybackError(error),
      });
    }
  }

  async _scanTargets(
    this: ConfiguredNavidrome,
    folders: readonly string[],
    aurralRoots: readonly string[],
  ) {
    let libraries;
    try {
      libraries = await this.client.getLibraries({ timeout: 30_000 });
    } catch (error) {
      logger.warn("navidrome", "Could not read Navidrome libraries for a targeted scan", {
        message: error?.message || String(error),
      });
      return null;
    }
    if (!Array.isArray(libraries)) return null;
    const roots = libraries.filter((library) => library?.id != null && library.path);
    const mappings = getPathMappings("navidrome");
    const { targets, unmatched } = serverScanTargets(folders, roots, mappings);
    if (!targets) {
      if (
        claimUnmatchedRootWarning(
          this._warnedUnmatchedRoots,
          unmatched.folder,
          aurralRoots,
          mappings,
        )
      ) {
        logger.warn(
          "navidrome",
          "Changed folder is outside every Navidrome library; scanning all libraries. Add a path mapping if Navidrome sees it at another path.",
          unmatched,
        );
      }
      return null;
    }
    const scanTargets =
      targets.length > MAX_NAVIDROME_SCAN_TARGETS
        ? targets.map(({ root }) => `${root.id}:`)
        : targets.map(({ root, relative }) => `${root.id}:${relative}`);
    return [...new Set(scanTargets)];
  }

  async requestScan({
    folders,
    roots: aurralRoots = [],
  }: {
    folders: readonly string[];
    roots?: readonly string[];
  }) {
    if (!this.isConfigured() || !folders.length) return playbackOperationSuccess();
    try {
      if (await this.client.isScanning()) return playbackScanDeferred();
      await this.client.scanLibrary(await this._scanTargets(folders, aurralRoots));
      return playbackOperationSuccess();
    } catch (error) {
      return playbackOperationFailure({
        code: "SCAN_FAILED",
        message: error?.message || "Could not scan the Navidrome library",
        retryable: isRetryablePlaybackError(error),
      });
    }
  }
}
