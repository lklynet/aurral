import path from "path";
import fs from "fs/promises";
import { dbOps } from "../../db/helpers/index.js";
import { flowPlaylistConfig } from "./weeklyFlowPlaylistConfig.js";
import { downloadTracker } from "./weeklyFlowDownloadTracker.js";
import { writePlaylistArtworkWebpFromBuffer } from "../playlistArtwork.js";
import {
  getArtworkExtensionForStyle,
  getPlaylistArtworkStyle,
  writeGeneratedPlaylistArtwork,
} from "../playlistArtworkGenerator.js";
import {
  AURRAL_FLOWS_DIR,
  PLAYLIST_LIBRARY_DIR,
  resolvePlaylistRoot,
} from "../playlistPaths.js";
import { scheduleLibraryScan } from "../libraryScanWorker.js";
import { getDownloadClient } from "../download/downloadClientSettings.js";
import {
  assertPlaybackDestination,
  createPlaybackPlaylistIdentity,
  createPlaybackPlaylistSnapshot,
} from "../playback/playbackDestination.js";
import { PlaybackDestinationRegistry } from "../playback/playbackDestinationRegistry.js";
import { collectPlaybackPlaylistTracks } from "../playback/playbackPlaylistTracks.js";
import { NavidromePlaybackDestination } from "../playback/navidromePlaybackDestination.js";
import { PlexPlaybackDestination } from "../playback/plexPlaybackDestination.js";
import { JellyfinPlaybackDestination } from "../playback/jellyfinPlaybackDestination.js";

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
    this.plexDestination = assertPlaybackDestination(
      new PlexPlaybackDestination(this.weeklyFlowRoot),
    );
    this.jellyfinDestination = assertPlaybackDestination(
      new JellyfinPlaybackDestination(this.weeklyFlowRoot),
    );
    this.destinationRegistry = new PlaybackDestinationRegistry([
      this.navidromeDestination,
      this.plexDestination,
      this.jellyfinDestination,
    ]);
    this._ensureInFlight = null;
    this._refreshInFlight = new Map();
    this.updateConfig(triggerEnsureOnInit);
  }

  updateConfig(triggerEnsurePlaylists = true) {
    const settings = dbOps.getSettings();
    this.destinationRegistry.updateConfig(settings.integrations);

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
      return this._publishPlaylist(flow, "Flow");
    }
    const sharedPlaylist = flowPlaylistConfig.getSharedPlaylist(playlistType);
    if (!sharedPlaylist) return null;
    return this._publishPlaylist(sharedPlaylist, "Playlist");
  }

  scheduleScanLibrary(force = false) {
    return scheduleLibraryScan({ force, includeLidarr: false });
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

  async _syncNavidromeArtwork(playlistId, clear = false) {
    const entity = flowPlaylistConfig.getFlow(playlistId)
      || flowPlaylistConfig.getSharedPlaylist(playlistId);
    if (!entity) return;
    const operation = clear ? "clearPlaylistArtwork" : "syncPlaylistArtwork";
    if (typeof this.navidromeDestination[operation] !== "function") return;
    const result = await this.navidromeDestination[operation]({
      entityId: entity.id,
      ownerUserId: entity.ownerUserId ?? null,
    });
    if (!result.ok) {
      console.warn(
        `[WeeklyFlowPlaylistManager] Navidrome artwork ${clear ? "clear" : "sync"} failed:`,
        result.error?.message,
      );
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

  async _publishPlaylist(entity, artworkKind) {
    const snapshot = await this._createPlaybackSnapshot(entity);
    const playlistName = this.navidromeDestination.getPlaylistName(snapshot);
    await this._ensureFlowArtwork(entity.id, playlistName, artworkKind);
    return this.destinationRegistry.run("publishPlaylist", snapshot);
  }

  async _ensurePlaylistsInternal() {
    const flows = flowPlaylistConfig.getFlows();
    const sharedPlaylists = flowPlaylistConfig.getSharedPlaylists();
    const libraryResults = await this.destinationRegistry.run("ensureLibrary");
    const libraryFailures = libraryResults.filter((result) => !result.ok);
    if (libraryFailures.length) {
      throw new Error(
        libraryFailures
          .map((result) => `${result.destination}: ${result.error?.message || "library setup failed"}`)
          .join("; "),
      );
    }
    for (const flow of flows) {
      if (flow.enabled) {
        await this._publishPlaylist(flow, "Flow");
      } else {
        const results = await this.destinationRegistry.run(
          "deletePlaylist",
          createPlaybackPlaylistIdentity({
            entityId: flow.id,
            ownerUserId: flow.ownerUserId ?? null,
          }),
        );
        if (
          results.some(
            (result) => result.destination === this.navidromeDestination.name && result.ok,
          )
        ) {
          const playlistName = this.navidromeDestination.getPlaylistName({
            entityId: flow.id,
            ownerUserId: flow.ownerUserId ?? null,
            displayName: flow.name,
          });
          await this._ensureFlowArtwork(flow.id, playlistName, "Flow");
        }
      }
    }
    for (const playlist of sharedPlaylists) {
      await this._publishPlaylist(playlist, "Playlist");
    }
  }

  async _activePlaybackSnapshots() {
    const entities = [
      ...flowPlaylistConfig.getFlows().filter((flow) => flow.enabled),
      ...flowPlaylistConfig.getSharedPlaylists(),
    ];
    const snapshots = [];
    for (const entity of entities) snapshots.push(await this._createPlaybackSnapshot(entity));
    return snapshots;
  }

  async cleanupUserPlexPlaylists(userId) {
    return this.plexDestination.deleteOwnerPlaylists(userId);
  }

  async cleanupEntityPlexPlaylists(entityId) {
    return this.plexDestination.deleteEntityPlaylists(entityId);
  }

  async deletePlaybackPlaylist(entity) {
    return this.destinationRegistry.run(
      "deletePlaylist",
      createPlaybackPlaylistIdentity({
        entityId: entity.id,
        ownerUserId: entity.ownerUserId ?? null,
      }),
    );
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
    return this.plexDestination.syncNow(
      await this._activePlaybackSnapshots(),
      () => this._activePlaybackSnapshots(),
    );
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
    const results = await this.destinationRegistry.run("requestScan");
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
          await getDownloadClient("ytdlp").cleanupStaging(job.id);
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
        await fs.rm(path.join(this.weeklyFlowRoot, AURRAL_FLOWS_DIR, playlistType), {
          recursive: true,
          force: true,
        });
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
    await this._syncNavidromeArtwork(playlistId);
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
    await this._syncNavidromeArtwork(playlistId, true);
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
    await this._syncNavidromeArtwork(playlistId);
    return outputPath;
  }
}

export const playlistManager = new WeeklyFlowPlaylistManager();
