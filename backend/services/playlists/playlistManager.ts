import path from "path";
import fs from "fs/promises";
import { constants as fsConstants } from "fs";
import { dbOps } from "../../db/helpers/index.ts";
import { asAppError } from "../../../lib/errors.ts";
import { flowPlaylistConfig, type FlowConfig, type StaticPlaylist } from "./flowPlaylistConfig.ts";
import { downloadTracker } from "../downloadJobs/downloadTracker.ts";
import { writePlaylistArtworkWebpFromBuffer } from "../playlistArtwork.ts";
import {
  playlistArtistSignature,
  readPlaylistImageBuffer,
  writeGeneratedPlaylistArtwork,
} from "../playlistArtworkGenerator.ts";
import {
  getPlaylistArtworkState,
  setPlaylistArtworkState,
  type PlaylistArtworkStyle,
  type PlaylistArtworkState,
} from "../playlistArtworkState.ts";
import { AURRAL_FLOWS_DIR, PLAYLIST_FILES_DIR, resolveDownloadRoot } from "../downloadPaths.ts";
import { scheduleLibraryScan } from "../libraryScanWorker.ts";
import {
  withHonkerLock,
  enqueueSystemTaskJob,
  getSystemTaskQueueName,
  listHonkerJobs,
  mergeIntoPendingHonkerJob,
  type HonkerPayload,
  type SystemTaskPayload,
} from "../honkerDb.ts";
import { activeLidarrRoots } from "../libraryFolders.ts";
import { lidarrClient } from "../lidarrClient.ts";
import { getDownloadClient } from "../download/downloadClientSettings.ts";
import {
  createPlaybackPlaylistIdentity,
  createPlaybackPlaylistSnapshot,
  createPlaybackScanRequest,
} from "../playback/playbackDestination.ts";
import { scanFoldersForPaths } from "../playback/playbackScanFolders.ts";
import { PlaybackDestinationRegistry } from "../playback/playbackDestinationRegistry.ts";
import { collectPlaybackPlaylistTracks } from "../playback/playbackPlaylistTracks.ts";
import { NavidromePlaybackDestination } from "../playback/navidromePlaybackDestination.ts";
import { PlexPlaybackDestination } from "../playback/plexPlaybackDestination.ts";
import { JellyfinPlaybackDestination } from "../playback/jellyfinPlaybackDestination.ts";
import {
  createPlaybackDeletionGuard,
  removeUnusedPlaybackFiles,
} from "../playback/playbackFileRetention.ts";

const ARTWORK_FILE_EXTENSIONS = [".webp", ".jpg", ".png"];
const ARTWORK_SUPPRESS_SUFFIX = ".no-artwork";
const PLAYBACK_SCAN_BATCH_SECONDS = 15;
const PLAYLIST_SYNC_KIND = "playback-playlist-sync";
const PLAYBACK_SCAN_KIND = "playback-library-scan";
const PLAYLIST_SYNC_RETRY_DELAYS_SECONDS = [30, 90, 180, 600];
const LIBRARY_DOWNLOADS_ID = "library";

function batchSystemTask(
  payload: SystemTaskPayload,
  {
    delaySeconds,
    matches,
    merge,
  }: {
    delaySeconds: number;
    matches: (payload: HonkerPayload) => boolean;
    merge: (payload: HonkerPayload) => HonkerPayload;
  },
) {
  return (
    mergeIntoPendingHonkerJob(getSystemTaskQueueName(payload.kind), {
      payloadKind: payload.kind,
      matches,
      merge,
    }) ?? enqueueSystemTaskJob(payload, { delaySeconds })
  );
}

const stringList = (value: unknown) =>
  Array.isArray(value) ? value.filter((entry): entry is string => typeof entry === "string") : null;

function mergeEntityIds(left: string[] | null | undefined, right: string[] | null | undefined) {
  if (left == null || right == null) return null;
  return [...new Set([...left, ...right])];
}

function playlistSyncStage(attempt: number) {
  return Math.min(attempt, PLAYLIST_SYNC_RETRY_DELAYS_SECONDS.length);
}

function playlistSyncDelaySeconds(attempt: number) {
  return attempt ? PLAYLIST_SYNC_RETRY_DELAYS_SECONDS[playlistSyncStage(attempt) - 1] : 2;
}

export class PlaylistManager {
  declare downloadRoot: string;
  declare playlistFilesRoot: string;
  declare libraryRoot: string;
  declare navidromeDestination: NavidromePlaybackDestination;
  declare plexDestination: PlexPlaybackDestination;
  declare jellyfinDestination: JellyfinPlaybackDestination;
  declare destinationRegistry: PlaybackDestinationRegistry;

  constructor(downloadRoot = resolveDownloadRoot()) {
    this.downloadRoot = resolveDownloadRoot(downloadRoot);
    this.playlistFilesRoot = path.join(this.downloadRoot, PLAYLIST_FILES_DIR);
    this.libraryRoot = path.join(this.playlistFilesRoot, "_playlists");
    this.navidromeDestination = new NavidromePlaybackDestination(this.downloadRoot);
    this.plexDestination = new PlexPlaybackDestination(this.downloadRoot);
    this.jellyfinDestination = new JellyfinPlaybackDestination(this.downloadRoot);
    this.destinationRegistry = new PlaybackDestinationRegistry([
      this.navidromeDestination,
      this.plexDestination,
      this.jellyfinDestination,
    ]);
    this.updateConfig();
  }

  updateConfig() {
    this.destinationRegistry.updateConfig(dbOps.getSettings().integrations);
  }

  _sanitize(str: unknown) {
    return String(str || "")
      .replace(/[<>:"/\\|?*]/g, "_")
      .trim();
  }

  _getPlaylistLibraryHostPath() {
    return this.playlistFilesRoot.replace(/\\/g, "/").replace(/\/+$/, "");
  }

  _getPlaylistBaseName(playlistName: string) {
    return this._sanitize(playlistName);
  }

  requestPlaylistSync(
    entityIds: readonly unknown[] | null = null,
    {
      destinations = null,
      chain = null,
      attempt = 0,
      delaySeconds = playlistSyncDelaySeconds(attempt),
    }: {
      destinations?: string[] | null;
      chain?: string | null;
      attempt?: number;
      delaySeconds?: number;
    } = {},
  ) {
    const ids =
      entityIds == null
        ? null
        : [
            ...new Set(
              entityIds
                .map((id) => String(id ?? "").trim())
                .filter((id) => id && id !== LIBRARY_DOWNLOADS_ID),
            ),
          ];
    if (ids?.length === 0) return null;
    const keys = destinations ? [...destinations].sort() : null;
    return batchSystemTask(
      {
        kind: PLAYLIST_SYNC_KIND,
        entityIds: ids,
        attempt,
        ...(keys ? { destinations: keys, chain } : {}),
      },
      {
        delaySeconds,
        matches: (payload) =>
          playlistSyncStage(Number(payload.attempt)) === playlistSyncStage(attempt) &&
          (payload.chain ?? null) === (keys ? chain : null) &&
          JSON.stringify(payload.destinations ?? null) === JSON.stringify(keys),
        merge: (payload) => ({
          ...payload,
          entityIds: mergeEntityIds(stringList(payload.entityIds), ids),
        }),
      },
    );
  }

  async syncPlaylists({
    entityIds = null,
    destinations = null,
    chain = null,
    attempt = 0,
  }: {
    entityIds?: string[] | null;
    destinations?: string[] | null;
    chain?: string | null;
    attempt?: number;
  } = {}) {
    const scope = this.destinationRegistry.destinations.filter(
      (destination) => !destinations || destinations.includes(destination.key),
    );
    const pointerIds = new Set(scope.flatMap((destination) => destination.getPointerEntityIds()));
    const ids = entityIds
      ? entityIds.filter(
          (id) =>
            pointerIds.has(id) ||
            flowPlaylistConfig.getFlow(id) ||
            flowPlaylistConfig.getStaticPlaylist(id),
        )
      : [
          ...new Set([
            ...flowPlaylistConfig.getFlows().map((flow) => flow.id),
            ...flowPlaylistConfig.getStaticPlaylists().map((playlist) => playlist.id),
            ...pointerIds,
          ]),
        ];
    if (entityIds && !ids.length) return;
    for (const id of ids) await this._relocateArtwork(id);
    const setupFailures = (
      await this.destinationRegistry.runOn(
        scope.map((destination) => destination.key),
        "ensureLibrary",
      )
    ).filter((result) => !result.ok);
    const failedKeys = new Set(setupFailures.map((result) => result.key));
    const keys = scope.map((destination) => destination.key).filter((key) => !failedKeys.has(key));
    const missed = { outage: new Map(), indexing: new Map() };
    const context = { pendingScanFolders: this._pendingScanFolders() };
    for (const result of setupFailures) {
      if (result.error?.retryable) missed.outage.set(result.key, entityIds ? ids : null);
    }
    for (const id of ids) {
      for (const result of await this._syncEntity(id, keys, context)) {
        const resultChain = result.ok
          ? result.pending && "indexing"
          : result.error?.retryable && "outage";
        if (resultChain)
          missed[resultChain].set(result.key, [...(missed[resultChain].get(result.key) ?? []), id]);
      }
    }
    for (const [nextChain, idsByKey] of Object.entries(missed)) {
      const nextAttempt = nextChain === chain ? attempt + 1 : 1;
      if (nextChain === "indexing" && nextAttempt > PLAYLIST_SYNC_RETRY_DELAYS_SECONDS.length)
        continue;
      const followUps = new Map();
      for (const [key, missedIds] of idsByKey) {
        const groupKey = JSON.stringify(missedIds);
        const followUp = followUps.get(groupKey) ?? { ids: missedIds, keys: [] };
        followUp.keys.push(key);
        followUps.set(groupKey, followUp);
      }
      for (const followUp of followUps.values()) {
        this.requestPlaylistSync(followUp.ids, {
          destinations: followUp.keys,
          chain: nextChain,
          attempt: nextAttempt,
        });
      }
    }
  }

  _pendingScanFolders() {
    const foldersByKey = new Map();
    for (const { state, payload } of listHonkerJobs(getSystemTaskQueueName(PLAYBACK_SCAN_KIND))) {
      if (state !== "pending" || payload?.kind !== PLAYBACK_SCAN_KIND) continue;
      const keys =
        stringList(payload.destinations) ??
        this.destinationRegistry.destinations.map((destination) => destination.key);
      for (const key of keys) {
        foldersByKey.set(key, [
          ...(foldersByKey.get(key) ?? []),
          ...(stringList(payload.folders) ?? this.libraryRoots()),
        ]);
      }
    }
    return foldersByKey;
  }

  async _syncEntity(id: string, keys: string[], context: unknown) {
    const flow = flowPlaylistConfig.getFlow(id);
    if (flow?.enabled) return this._publishPlaylist(flow, "Flow", keys, context);
    if (flow) return this._unpublishDisabledFlow(flow, keys);
    const playlist = flowPlaylistConfig.getStaticPlaylist(id);
    if (playlist) return this._publishPlaylist(playlist, "Playlist", keys, context);
    return this.destinationRegistry.runOn(keys, "deleteEntityPlaylists", id);
  }

  async _unpublishDisabledFlow(flow: FlowConfig, keys: string[]) {
    const results = await this.destinationRegistry.runOn(
      keys,
      "deletePlaylist",
      createPlaybackPlaylistIdentity({ entityId: flow.id, ownerUserId: flow.ownerUserId ?? null }),
    );
    if (
      results.some((result) => result.destination === this.navidromeDestination.name && result.ok)
    ) {
      const playlistName = this.navidromeDestination.getPlaylistName({
        entityId: flow.id,
        ownerUserId: flow.ownerUserId ?? null,
        displayName: flow.name,
      });
      await this._ensureFlowArtwork(flow.id, playlistName, "Flow");
    }
    return results;
  }

  scheduleScanLibrary(force = false) {
    return scheduleLibraryScan({ force, includeLidarr: false });
  }

  _rememberArtwork(playlistId: string, state: PlaylistArtworkState) {
    setPlaylistArtworkState(playlistId, {
      ...state,
      baseName: this._resolveArtworkBase(playlistId)?.baseName || null,
    });
  }

  async _relocateArtwork(playlistId: string) {
    const previous = getPlaylistArtworkState(playlistId);
    const resolved = this._resolveArtworkBase(playlistId);
    if (
      !resolved ||
      !previous?.baseName ||
      previous.baseName === resolved.baseName ||
      (previous.mode !== "original" && previous.mode !== "upload")
    )
      return;
    await withHonkerLock(`playlist-artwork:${playlistId}`, async () => {
      const state = getPlaylistArtworkState(playlistId);
      if (
        !state?.baseName ||
        state.baseName === resolved.baseName ||
        (state.mode !== "original" && state.mode !== "upload")
      )
        return;
      const oldPath = path.resolve(resolved.safeRoot, `${state.baseName}.webp`);
      if (path.dirname(oldPath) !== resolved.safeRoot) throw new Error("Invalid artwork path");
      try {
        await fs.copyFile(
          oldPath,
          path.join(resolved.safeRoot, `${resolved.baseName}.webp`),
          fsConstants.COPYFILE_EXCL,
        );
        await fs.unlink(oldPath);
      } catch (error) {
        const code = asAppError(error)?.code;
        if (code === "EEXIST") return;
        if (code !== "ENOENT") throw error;
      }
      this._rememberArtwork(playlistId, state);
    });
  }

  _artworkArtists(playlistId: string) {
    return [
      ...(flowPlaylistConfig.getStaticPlaylist(playlistId)?.tracks || []),
      ...downloadTracker.getByPlaylistId(playlistId),
    ];
  }

  async _ensureFlowArtwork(playlistId: string, playlistName: string, artworkKind: string) {
    return withHonkerLock(`playlist-artwork:${playlistId}`, async () => {
      await fs.mkdir(this.libraryRoot, { recursive: true });
      const baseName = this._getPlaylistBaseName(playlistName);
      if (await this._isArtworkGenerationSuppressed(path.resolve(this.libraryRoot), baseName))
        return;
      const existing = await this.resolveArtworkFile(playlistId);
      const state = getPlaylistArtworkState(playlistId);
      const flowRunAt = flowPlaylistConfig.getFlow(playlistId)?.lastRunAt ?? null;
      const refreshFlow = state?.mode === "artist" && flowRunAt !== (state.flowRunAt ?? null);
      if (state?.mode === "removed") return;
      if (existing && (!state || state.mode === "upload" || state.mode === "simple")) return;
      const sourceUrl = flowPlaylistConfig.getStaticPlaylist(playlistId)?.importSource?.artworkUrl;
      if (sourceUrl && (!state || state.mode === "original")) {
        if (existing && state?.sourceUrl === sourceUrl) return;
        try {
          await this._saveOriginalArtwork(playlistId, sourceUrl);
          await this._syncNavidromeArtwork(playlistId);
          return;
        } catch (error) {
          console.warn(
            `[PlaylistManager] Original artwork unavailable: ${asAppError(error)?.message}`,
          );
          if (existing) return;
        }
      }
      if (existing && !refreshFlow && !state?.fallbackSignature) return;
      const artists = this._artworkArtists(playlistId);
      if (
        existing &&
        !refreshFlow &&
        (!state?.fallbackSignature || state.fallbackSignature === playlistArtistSignature(artists))
      )
        return;
      const context = this.getArtworkContextForPlaylistId(playlistId);
      try {
        const generated = await writeGeneratedPlaylistArtwork({
          outputPath: path.join(this.libraryRoot, `${baseName}.webp`),
          title: context?.title || playlistName,
          artists,
          previous: state,
          style: state?.mode === "simple" ? "simple" : "artist",
        });
        this._rememberArtwork(
          playlistId,
          sourceUrl && (!state || state.mode === "original")
            ? { ...generated.state, mode: "original", flowRunAt }
            : { ...generated.state, flowRunAt },
        );
        await this._syncNavidromeArtwork(playlistId);
      } catch (error) {
        console.warn(
          `[PlaylistManager] ${artworkKind} artwork generation failed: ${asAppError(error)?.message}`,
        );
      }
    });
  }

  async ensurePlaylistArtwork(entityId: string) {
    const context = this.getArtworkContextForPlaylistId(entityId);
    if (!context) return;
    await this._ensureFlowArtwork(entityId, this.getPlaylistName(entityId), context.kind).catch(
      (error) => {
        console.warn(`[PlaylistManager] Artwork generation failed: ${error.message}`);
      },
    );
  }

  async _syncNavidromeArtwork(playlistId: string, clear = false) {
    const entity =
      flowPlaylistConfig.getFlow(playlistId) || flowPlaylistConfig.getStaticPlaylist(playlistId);
    if (!entity) return;
    const operation = clear ? "clearPlaylistArtwork" : "syncPlaylistArtwork";
    if (typeof this.navidromeDestination[operation] !== "function") return;
    const result = await this.navidromeDestination[operation]({
      entityId: entity.id,
      ownerUserId: entity.ownerUserId ?? null,
    });
    if (!result.ok) {
      console.warn(
        `[PlaylistManager] Navidrome artwork ${clear ? "clear" : "sync"} failed:`,
        result.error?.message,
      );
    }
  }

  async _createPlaybackSnapshot(entity: FlowConfig | StaticPlaylist) {
    const tracks = await collectPlaybackPlaylistTracks(entity.id, {
      downloadRoot: this.downloadRoot,
    });
    return createPlaybackPlaylistSnapshot({
      entityId: entity.id,
      ownerUserId: entity.ownerUserId ?? null,
      displayName: entity.name,
      description: entity.description || null,
      tracks,
    });
  }

  async _publishPlaylist(
    entity: FlowConfig | StaticPlaylist,
    artworkKind: string,
    keys: string[],
    context: unknown,
  ) {
    const snapshot = await this._createPlaybackSnapshot(entity);
    const playlistName = this.navidromeDestination.getPlaylistName(snapshot);
    await this._ensureFlowArtwork(entity.id, playlistName, artworkKind);
    return this.destinationRegistry.runOn(keys, "publishPlaylist", snapshot, context);
  }

  async _activePlaybackSnapshots() {
    const entities = [
      ...flowPlaylistConfig.getFlows().filter((flow) => flow.enabled),
      ...flowPlaylistConfig.getStaticPlaylists(),
    ];
    const snapshots = [];
    for (const entity of entities) snapshots.push(await this._createPlaybackSnapshot(entity));
    return snapshots;
  }

  async cleanupUserPlexPlaylists(
    userId: number,
    connection: Parameters<PlexPlaybackDestination["deleteOwnerPlaylists"]>[1] = null,
  ) {
    return this.plexDestination.deleteOwnerPlaylists(userId, connection);
  }

  async syncPlexNow() {
    for (const flow of flowPlaylistConfig.getFlows()) {
      if (flow.enabled) continue;
      const result = await this.plexDestination.deletePlaylist(
        createPlaybackPlaylistIdentity({
          entityId: flow.id,
          ownerUserId: flow.ownerUserId ?? null,
        }),
      );
      if (!result.ok) throw new Error(result.error.message);
    }
    const { pendingEntityIds, ...summary } = await this.plexDestination.syncNow(
      await this._activePlaybackSnapshots(),
    );
    this.requestPlaylistSync(pendingEntityIds ?? [], {
      destinations: [this.plexDestination.key],
      chain: "indexing",
      attempt: 1,
    });
    return summary;
  }

  schedulePlaybackScan(
    paths: readonly (string | null | undefined)[],
    { destinations = null }: { destinations?: string[] | null } = {},
  ) {
    this.updateConfig();
    if (!this.destinationRegistry.destinations.some((destination) => destination.isConfigured()))
      return null;
    const roots = this.libraryRoots();
    const folders = scanFoldersForPaths(paths, roots);
    if (!folders.length) return null;
    return batchSystemTask(
      { kind: PLAYBACK_SCAN_KIND, folders, ...(destinations ? { destinations } : {}) },
      {
        delaySeconds: PLAYBACK_SCAN_BATCH_SECONDS,
        matches: (payload) =>
          Array.isArray(payload.folders) &&
          JSON.stringify(payload.destinations ?? null) === JSON.stringify(destinations),
        merge: (payload) => ({
          ...payload,
          folders: scanFoldersForPaths([...(stringList(payload.folders) ?? []), ...folders], roots),
        }),
      },
    );
  }

  libraryRoots() {
    return [this.downloadRoot, ...activeLidarrRoots(lidarrClient)];
  }

  async scanLibrary(folders: string[], destinations: string[] | null = null) {
    const request = createPlaybackScanRequest({ folders, roots: this.libraryRoots() });
    const results = await this.destinationRegistry.runOn(destinations, "requestScan", request);
    const deferred = results
      .filter((result) => result.deferred)
      .map((result) => result.key)
      .sort();
    if (deferred.length) this.schedulePlaybackScan(request.folders, { destinations: deferred });
    return results.length ? results : null;
  }

  async weeklyReset(
    playlistTypes: string[] | null = null,
    { protectPlayback = true }: { protectPlayback?: boolean } = {},
  ) {
    const targets =
      playlistTypes && playlistTypes.length
        ? playlistTypes
        : flowPlaylistConfig.getFlows().map((flow) => flow.id);
    const fallbackDir = path.join(this.downloadRoot, "_fallback");
    const deletionGuard = protectPlayback
      ? createPlaybackDeletionGuard({ excludeEntityIds: targets, playlistRoot: this.downloadRoot })
      : { canDelete: async () => true };
    try {
      await removeUnusedPlaybackFiles(fallbackDir, deletionGuard, { protectPlayback });
    } catch {}

    const flowsRoot = path.join(this.downloadRoot, AURRAL_FLOWS_DIR);
    let flowFolderTouched = false;
    for (const playlistType of targets) {
      const flowDir = path.join(flowsRoot, playlistType);
      flowFolderTouched ||= await fs.stat(flowDir).then(
        () => true,
        () => false,
      );
      const jobs = downloadTracker.getByPlaylistId(playlistType);
      for (const job of jobs) {
        if (job.downloadClient === "ytdlp") {
          await getDownloadClient("ytdlp").cleanupStaging(job.id);
        }
      }
      const playlistDir = path.join(this.playlistFilesRoot, playlistType);
      try {
        const { relocateSharedFilesBeforePlaylistRemoval } =
          await import("../downloadJobs/fileReuse.ts");
        await relocateSharedFilesBeforePlaylistRemoval(playlistType, {
          downloadRoot: this.downloadRoot,
          deletionGuard,
          protectPlayback,
        });
        await removeUnusedPlaybackFiles(playlistDir, deletionGuard, { protectPlayback });
        await removeUnusedPlaybackFiles(flowDir, deletionGuard, { protectPlayback });
        console.log(`[PlaylistManager] Cleaned unused files for ${playlistType}`);
      } catch (error) {
        console.warn(
          `[PlaylistManager] Failed to delete files for ${playlistType}:`,
          asAppError(error)?.message,
        );
      }
      downloadTracker.clearByPlaylistId(playlistType);
      const { repairJobsUnderRemovedPlaylistDir } = await import("../downloadJobs/fileReuse.ts");
      const { downloadWorker } = await import("../downloadJobs/downloadWorker.ts");
      const { existingFileMode } = downloadWorker.getWorkerSettings();
      await repairJobsUnderRemovedPlaylistDir(playlistType, {
        existingFileMode,
        downloadRoot: this.downloadRoot,
      });
    }
    if (flowFolderTouched) this.schedulePlaybackScan([flowsRoot]);
  }

  getPlaylistName(playlistType: string) {
    const entity =
      flowPlaylistConfig.getFlow(playlistType) ||
      flowPlaylistConfig.getStaticPlaylist(playlistType);
    if (!entity) return playlistType;
    return this.navidromeDestination.getPlaylistName({
      entityId: entity.id,
      ownerUserId: entity.ownerUserId ?? null,
      displayName: entity.name,
    });
  }

  getArtworkContextForPlaylistId(playlistId: string) {
    const flow = flowPlaylistConfig.getFlow(playlistId);
    if (flow) return { kind: "Flow", title: flow.name };
    const playlist = flowPlaylistConfig.getStaticPlaylist(playlistId);
    if (playlist) return { kind: "Playlist", title: playlist.name };
    return null;
  }

  _resolveArtworkBase(playlistId: string) {
    const playlistName = this.getPlaylistName(playlistId);
    if (!playlistName) return null;
    const baseName = this._getPlaylistBaseName(playlistName);
    const safeRoot = path.resolve(this.libraryRoot);
    return { safeRoot, baseName, playlistName };
  }

  _artworkSuppressPath(safeRoot: string, baseName: string) {
    const safePath = path.resolve(safeRoot, `${baseName}${ARTWORK_SUPPRESS_SUFFIX}`);
    if (path.dirname(safePath) !== safeRoot) return null;
    return safePath;
  }

  async _isArtworkGenerationSuppressed(safeRoot: string, baseName: string) {
    const suppressPath = this._artworkSuppressPath(safeRoot, baseName);
    if (!suppressPath) return false;
    try {
      const stat = await fs.stat(suppressPath);
      return stat.isFile();
    } catch {
      return false;
    }
  }

  async _setArtworkGenerationSuppressed(safeRoot: string, baseName: string, suppressed: boolean) {
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

  async resolveArtworkFile(playlistId: string) {
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

  async _saveArtworkBuffer(playlistId: string, buffer: Buffer) {
    const resolved = this._resolveArtworkBase(playlistId);
    if (!resolved) throw new Error("Playlist not found");
    await fs.mkdir(resolved.safeRoot, { recursive: true });
    const webpPath = path.join(resolved.safeRoot, `${resolved.baseName}.webp`);
    await writePlaylistArtworkWebpFromBuffer(buffer, webpPath);
    for (const extension of [".jpg", ".png"]) {
      await fs
        .unlink(path.join(resolved.safeRoot, `${resolved.baseName}${extension}`))
        .catch(() => {});
    }
    await this._setArtworkGenerationSuppressed(resolved.safeRoot, resolved.baseName, false);
    return webpPath;
  }

  async _saveOriginalArtwork(playlistId: string, sourceUrl: string) {
    const buffer = await readPlaylistImageBuffer(sourceUrl);
    const outputPath = await this._saveArtworkBuffer(playlistId, buffer);
    this._rememberArtwork(playlistId, {
      mode: "original",
      sourceUrl,
      artistKey: null,
      template: null,
      fallbackSignature: null,
    });
    return outputPath;
  }

  async restoreOriginalArtwork(playlistId: string) {
    return withHonkerLock(`playlist-artwork:${playlistId}`, async () => {
      const sourceUrl = flowPlaylistConfig.getStaticPlaylist(playlistId)?.importSource?.artworkUrl;
      if (!sourceUrl)
        throw new Error("No original cover is available. Sync the playlist and try again.");
      const outputPath = await this._saveOriginalArtwork(playlistId, sourceUrl);
      await this._syncNavidromeArtwork(playlistId);
      return outputPath;
    });
  }

  async saveArtworkUpload(playlistId: string, buffer: Buffer) {
    return withHonkerLock(`playlist-artwork:${playlistId}`, async () => {
      const outputPath = await this._saveArtworkBuffer(playlistId, buffer);
      this._rememberArtwork(playlistId, {
        mode: "upload",
        sourceUrl: null,
        artistKey: null,
        template: null,
        fallbackSignature: null,
      });
      await this._syncNavidromeArtwork(playlistId);
      return outputPath;
    });
  }

  async removeArtwork(playlistId: string) {
    return withHonkerLock(`playlist-artwork:${playlistId}`, async () => {
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
      await this._syncNavidromeArtwork(playlistId, true);
      this._rememberArtwork(playlistId, {
        mode: "removed",
        sourceUrl: null,
        artistKey: null,
        template: null,
        fallbackSignature: null,
      });
      return removed;
    });
  }

  async generateArtwork(playlistId: string, style: PlaylistArtworkStyle = "artist") {
    return withHonkerLock(`playlist-artwork:${playlistId}`, async () => {
      const resolved = this._resolveArtworkBase(playlistId);
      const context = this.getArtworkContextForPlaylistId(playlistId);
      if (!resolved || !context) throw new Error("Playlist not found");
      await fs.mkdir(resolved.safeRoot, { recursive: true });
      const flowRunAt = flowPlaylistConfig.getFlow(playlistId)?.lastRunAt ?? null;
      const generated = await writeGeneratedPlaylistArtwork({
        outputPath: path.join(resolved.safeRoot, `${resolved.baseName}.webp`),
        title: context.title,
        artists: this._artworkArtists(playlistId),
        style,
        previous: getPlaylistArtworkState(playlistId),
      });
      this._rememberArtwork(playlistId, { ...generated.state, flowRunAt });
      await this._setArtworkGenerationSuppressed(resolved.safeRoot, resolved.baseName, false);
      await this._syncNavidromeArtwork(playlistId);
      return generated.outputPath;
    });
  }
}

export const playlistManager = new PlaylistManager();
