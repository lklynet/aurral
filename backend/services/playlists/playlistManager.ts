import path from "path";
import fs from "fs/promises";
import { constants as fsConstants } from "fs";
import { asAppError } from "../../../lib/errors.ts";
import { flowPlaylistConfig } from "./flowPlaylistConfig.ts";
import { downloadTracker } from "../downloadJobs/downloadTracker.ts";
import { writePlaylistArtworkWebpFromBuffer } from "../playlistArtwork.ts";
import {
  playlistArtistSignature,
  readPlaylistImageBuffer,
  renderPickedPlaylistCover,
  shufflePlaylistCover,
  writeGeneratedPlaylistArtwork,
  type PlaylistCoverPick,
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
  mergeIntoPendingHonkerJob,
} from "../honkerDb.ts";
import { getDownloadClient } from "../download/downloadClientSettings.ts";
import { collectPlaylistFileTracks } from "./playlistFileTracks.ts";
import {
  buildPlaylistFile,
  PLAYLIST_FILE_EXTENSION,
  playlistDisplayNames,
  readWrittenPlaylistFiles,
  sanitizePlaylistFileName,
  saveWrittenPlaylistFiles,
  writePlaylistFile,
} from "./playlistFiles.ts";

const ARTWORK_FILE_EXTENSIONS = [".webp", ".jpg", ".png"];
const ARTWORK_SUPPRESS_SUFFIX = ".no-artwork";
const PLAYLIST_SYNC_KIND = "playback-playlist-sync";
const PLAYLIST_SYNC_DELAY_SECONDS = 2;
// Jellyfin misses tracks that it indexes in the same pass as the playlist
// file, so each changed file is written once more after servers catch up.
const PLAYLIST_REWRITE_DELAY_SECONDS = 180;
const LIBRARY_DOWNLOADS_ID = "library";

const stringList = (value: unknown) =>
  Array.isArray(value) ? value.filter((entry): entry is string => typeof entry === "string") : null;

function mergeEntityIds(left: string[] | null | undefined, right: string[] | null | undefined) {
  if (left == null || right == null) return null;
  return [...new Set([...left, ...right])];
}

export class PlaylistManager {
  declare downloadRoot: string;
  declare playlistFilesRoot: string;
  declare libraryRoot: string;

  constructor(downloadRoot = resolveDownloadRoot()) {
    this.downloadRoot = resolveDownloadRoot(downloadRoot);
    this.playlistFilesRoot = path.join(this.downloadRoot, PLAYLIST_FILES_DIR);
    this.libraryRoot = path.join(this.playlistFilesRoot, "_playlists");
  }

  _getPlaylistBaseName(playlistName: string) {
    return sanitizePlaylistFileName(playlistName);
  }

  requestPlaylistSync(
    entityIds: readonly unknown[] | null = null,
    { rewrite = false }: { rewrite?: boolean } = {},
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
    const delaySeconds = rewrite ? PLAYLIST_REWRITE_DELAY_SECONDS : PLAYLIST_SYNC_DELAY_SECONDS;
    return (
      mergeIntoPendingHonkerJob(getSystemTaskQueueName(PLAYLIST_SYNC_KIND), {
        payloadKind: PLAYLIST_SYNC_KIND,
        matches: (payload) => (payload.rewrite === true) === rewrite,
        merge: (payload) => ({
          ...payload,
          entityIds: mergeEntityIds(stringList(payload.entityIds), ids),
        }),
        delaySeconds: rewrite ? delaySeconds : 0,
      }) ??
      enqueueSystemTaskJob({ kind: PLAYLIST_SYNC_KIND, entityIds: ids, rewrite }, { delaySeconds })
    );
  }

  _playlistEntities() {
    return [...flowPlaylistConfig.getFlows(), ...flowPlaylistConfig.getStaticPlaylists()];
  }

  async syncPlaylists({
    entityIds = null,
    rewrite = false,
  }: { entityIds?: string[] | null; rewrite?: boolean } = {}) {
    const written = readWrittenPlaylistFiles();
    const entities = this._playlistEntities();
    const names = playlistDisplayNames(entities);
    const fileNameOf = (id: string) => {
      const flow = flowPlaylistConfig.getFlow(id);
      const entity = flow?.enabled ? flow : flowPlaylistConfig.getStaticPlaylist(id);
      return entity
        ? `${sanitizePlaylistFileName(names.get(id) ?? entity.name)}${PLAYLIST_FILE_EXTENSION}`
        : null;
    };
    const renamed = Object.keys(written).filter((id) => written[id] !== fileNameOf(id));
    const ids = [...new Set([...(entityIds ?? entities.map((entity) => entity.id)), ...renamed])];
    for (const id of ids) {
      await this._relocateArtwork(id);
      const file = written[id];
      if (!renamed.includes(id) || file === undefined) continue;
      await fs.rm(path.join(this.libraryRoot, file), { force: true });
      delete written[id];
    }
    const changed: string[] = [];
    for (const id of ids) {
      const flow = flowPlaylistConfig.getFlow(id);
      const entity = flow?.enabled ? flow : flowPlaylistConfig.getStaticPlaylist(id);
      const fileName = fileNameOf(id);
      if (flow && !flow.enabled)
        await this._ensureFlowArtwork(flow.id, names.get(id) ?? flow.name, "Flow");
      if (!entity || !fileName) continue;
      await this._ensureFlowArtwork(id, names.get(id) ?? entity.name, flow ? "Flow" : "Playlist");
      const tracks = await collectPlaylistFileTracks(id, { downloadRoot: this.downloadRoot });
      const content = buildPlaylistFile(tracks, this.libraryRoot);
      if (
        await writePlaylistFile(path.join(this.libraryRoot, fileName), content, { force: rewrite })
      )
        changed.push(id);
      written[id] = fileName;
    }
    saveWrittenPlaylistFiles(written);
    if (changed.length && !rewrite) this.requestPlaylistSync(changed, { rewrite: true });
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

  _artworkNeedsRelocation(playlistId: string, state: PlaylistArtworkState | null) {
    const resolved = this._resolveArtworkBase(playlistId);
    if (!resolved || !state?.baseName) return null;
    const moved = state.baseName !== resolved.baseName;
    if (state.mode === "original" || state.mode === "upload") return moved ? resolved : null;
    if (state.mode !== "artist" && state.mode !== "simple") return null;
    const title = this.getArtworkContextForPlaylistId(playlistId)?.title;
    return moved || (state.title != null && state.title !== title) ? resolved : null;
  }

  async _relocateArtwork(playlistId: string) {
    if (!this._artworkNeedsRelocation(playlistId, getPlaylistArtworkState(playlistId))) return;
    await withHonkerLock(`playlist-artwork:${playlistId}`, async () => {
      const state = getPlaylistArtworkState(playlistId);
      const resolved = this._artworkNeedsRelocation(playlistId, state);
      if (!state?.baseName || !resolved) return;
      const oldPath = path.resolve(resolved.safeRoot, `${state.baseName}.webp`);
      const newPath = path.join(resolved.safeRoot, `${resolved.baseName}.webp`);
      if (path.dirname(oldPath) !== resolved.safeRoot) throw new Error("Invalid artwork path");
      if (state.mode === "artist" || state.mode === "simple") {
        const title = this.getArtworkContextForPlaylistId(playlistId)?.title;
        const moved = oldPath !== newPath;
        if (!title || !state.template) return;
        if (
          moved &&
          (await fs.access(newPath).then(
            () => true,
            () => false,
          ))
        )
          return;
        try {
          const generated = await writeGeneratedPlaylistArtwork({
            outputPath: newPath,
            title,
            artists: this._artworkArtists(playlistId),
            pick: { style: state.mode, artistKey: state.artistKey, template: state.template },
            keepPhoto: true,
          });
          if (moved) await fs.unlink(oldPath).catch(() => {});
          this._rememberArtwork(playlistId, { ...generated.state, flowRunAt: state.flowRunAt });
        } catch (error) {
          console.warn(
            `[PlaylistManager] Cover redraw after rename failed: ${asAppError(error)?.message}`,
          );
        }
        return;
      }
      try {
        await fs.copyFile(oldPath, newPath, fsConstants.COPYFILE_EXCL);
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

  async weeklyReset(playlistTypes: string[] | null = null) {
    const targets =
      playlistTypes && playlistTypes.length
        ? playlistTypes
        : flowPlaylistConfig.getFlows().map((flow) => flow.id);
    await fs
      .rm(path.join(this.downloadRoot, "_fallback"), { recursive: true, force: true })
      .catch(() => {});

    const flowsRoot = path.join(this.downloadRoot, AURRAL_FLOWS_DIR);
    for (const playlistType of targets) {
      const flowDir = path.join(flowsRoot, playlistType);
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
        });
        await fs.rm(playlistDir, { recursive: true, force: true });
        await fs.rm(flowDir, { recursive: true, force: true });
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
  }

  getPlaylistName(playlistType: string) {
    const entities = this._playlistEntities();
    if (!entities.some((entity) => entity.id === playlistType)) return playlistType;
    return playlistDisplayNames(entities).get(playlistType) ?? playlistType;
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

  getArtworkPick(playlistId: string): PlaylistCoverPick | null {
    const state = getPlaylistArtworkState(playlistId);
    if (state?.mode !== "artist" && state?.mode !== "simple") return null;
    return state.template
      ? { style: state.mode, artistKey: state.artistKey, template: state.template }
      : null;
  }

  async shuffleArtwork(
    playlistId: string,
    style: PlaylistArtworkStyle,
    previous: PlaylistCoverPick | null,
  ) {
    if (!this.getArtworkContextForPlaylistId(playlistId)) throw new Error("Playlist not found");
    const { pick } = await shufflePlaylistCover({
      artists: this._artworkArtists(playlistId),
      style,
      previous: previous ?? getPlaylistArtworkState(playlistId),
    });
    return pick;
  }

  async previewArtwork(playlistId: string, title: string, pick: PlaylistCoverPick) {
    if (!this.getArtworkContextForPlaylistId(playlistId)) throw new Error("Playlist not found");
    return renderPickedPlaylistCover({ title, artists: this._artworkArtists(playlistId), pick });
  }

  async generateArtwork(
    playlistId: string,
    style: PlaylistArtworkStyle = "artist",
    pick: PlaylistCoverPick | null = null,
  ) {
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
        pick,
        previous: getPlaylistArtworkState(playlistId),
      });
      this._rememberArtwork(playlistId, { ...generated.state, flowRunAt });
      await this._setArtworkGenerationSuppressed(resolved.safeRoot, resolved.baseName, false);
      return generated.outputPath;
    });
  }
}

export const playlistManager = new PlaylistManager();
