import path from "path";
import fs from "fs/promises";
import crypto from "crypto";
import { dbOps } from "../config/db-helpers.js";
import { NavidromeClient } from "./navidrome.js";
import { PlexClient } from "./plex.js";
import { flowPlaylistConfig } from "./weeklyFlowPlaylistConfig.js";
import { downloadTracker } from "./weeklyFlowDownloadTracker.js";
import { writePlaylistArtworkWebpFromBuffer } from "./playlistArtwork.js";
import {
  getArtworkExtensionForStyle,
  getPlaylistArtworkStyle,
  writeGeneratedPlaylistArtwork,
} from "./playlistArtworkGenerator.js";
import {
  PLAYLIST_LIBRARY_DIR,
  resolvePlaylistRoot,
} from "./playlistPaths.js";
import { buildM3uContent, collectPlaylistM3uEntries } from "./playlistM3u.js";
import { scheduleLibraryScan } from "./libraryScanWorker.js";

const ARTWORK_FILE_EXTENSIONS = [".webp", ".jpg", ".png"];
const ARTWORK_SUPPRESS_SUFFIX = ".no-artwork";
const PLAYLIST_FILE_EXTENSIONS = [".m3u", ".nsp"];

export class WeeklyFlowPlaylistManager {
  constructor(
    weeklyFlowRoot = resolvePlaylistRoot(),
    { triggerEnsureOnInit = process.env.NODE_ENV !== "test" } = {},
  ) {
    this.weeklyFlowRoot = resolvePlaylistRoot(weeklyFlowRoot);
    this.playlistLibraryRoot = path.join(
      this.weeklyFlowRoot,
      PLAYLIST_LIBRARY_DIR,
    );
    this.libraryRoot = path.join(this.playlistLibraryRoot, "_playlists");
    this.navidromeClient = null;
    this._navidromeConfigKey = "";
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
    const nextConfigKey = JSON.stringify({
      url: navidromeConfig.url || "",
      username: navidromeConfig.username || "",
      password: navidromeConfig.password || "",
    });
    const configChanged = this._navidromeConfigKey !== nextConfigKey;
    this._navidromeConfigKey = nextConfigKey;

    if (
      navidromeConfig.url &&
      navidromeConfig.username &&
      navidromeConfig.password
    ) {
      if (!this.navidromeClient || configChanged) {
        this.navidromeClient = new NavidromeClient(
          navidromeConfig.url,
          navidromeConfig.username,
          navidromeConfig.password,
        );
      }
    } else {
      this.navidromeClient = null;
    }

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
    if (plexConfig.url && plexConfig.token) {
      if (!this.plexClient || plexChanged) {
        this.plexClient = new PlexClient(
          plexConfig.url,
          plexConfig.token,
          plexConfig.clientId,
        );
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
        console.warn(
          "[WeeklyFlowPlaylistManager] ensurePlaylists on config:",
          err?.message,
        ),
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

  _getFlowPlaylistNames(flowName) {
    const name = String(flowName || "").trim();
    return {
      current: `[A] ${name}`,
      legacy: [`Aurral ${name}`],
    };
  }

  _getSharedPlaylistNames(playlistName) {
    const name = String(playlistName || "").trim();
    return {
      current: `[AS] ${name}`,
      legacy: [`Aurral Shared ${name}`],
    };
  }

  _getPlaylistNameSet(playlistType) {
    const flow = flowPlaylistConfig.getFlow(playlistType);
    if (flow) {
      const names = this._getFlowPlaylistNames(flow.name);
      return [names.current, ...names.legacy];
    }
    const sharedPlaylist = flowPlaylistConfig.getSharedPlaylist(playlistType);
    if (sharedPlaylist) {
      const names = this._getSharedPlaylistNames(sharedPlaylist.name);
      return [names.current, ...names.legacy];
    }
    return [`[A] ${playlistType}`, `Aurral ${playlistType}`];
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
      const { current } = this._getFlowPlaylistNames(flow.name);
      return this._writePlaylistFile(current, playlistType, "Flow");
    }
    const sharedPlaylist = flowPlaylistConfig.getSharedPlaylist(playlistType);
    if (!sharedPlaylist) return null;
    const { current } = this._getSharedPlaylistNames(sharedPlaylist.name);
    return this._writePlaylistFile(current, playlistType, "Playlist");
  }

  scheduleScanLibrary(force = false) {
    return scheduleLibraryScan(force);
  }

  async _ensureFlowArtwork(playlistType, playlistName, artworkKind) {
    await fs.mkdir(this.libraryRoot, { recursive: true });
    const baseName = this._getPlaylistBaseName(playlistName);
    const artworkExtension = getArtworkExtensionForStyle(getPlaylistArtworkStyle());
    const artworkPath = path.join(
      this.libraryRoot,
      `${baseName}${artworkExtension}`,
    );
    const safeRoot = path.resolve(this.libraryRoot);
    const suppressed = await this._isArtworkGenerationSuppressed(
      safeRoot,
      baseName,
    );
    if (!(await this._playlistArtworkExists(baseName)) && !suppressed) {
      const artworkContext = this.getArtworkContextForPlaylistId(playlistType);
      await writeGeneratedPlaylistArtwork({
        outputPath: artworkPath,
        title: artworkContext?.title || playlistName,
        kind: artworkContext?.kind || artworkKind,
        signature: artworkContext?.signature || playlistType,
        relatedArtists: artworkContext?.relatedArtists || [],
      });
    }
  }

  async _writePlaylistFile(playlistName, playlistType, artworkKind) {
    await fs.mkdir(this.libraryRoot, { recursive: true });
    const baseName = this._getPlaylistBaseName(playlistName);
    const m3uPath = path.join(this.libraryRoot, `${baseName}.m3u`);
    const entries = await collectPlaylistM3uEntries(playlistType, {
      weeklyFlowRoot: this.weeklyFlowRoot,
    });
    await fs.writeFile(m3uPath, buildM3uContent(entries), "utf8");
    await this._ensureFlowArtwork(playlistType, playlistName, artworkKind);
    return m3uPath;
  }

  async _ensurePlaylistsInternal() {
    const flows = flowPlaylistConfig.getFlows();
    const sharedPlaylists = flowPlaylistConfig.getSharedPlaylists();
    let playlists = null;
    if (this.navidromeClient?.isConfigured()) {
      try {
        const hostPath = this._getPlaylistLibraryHostPath();
        await this.navidromeClient.ensureWeeklyFlowLibrary(hostPath);
      } catch (err) {
        console.warn(
          "[WeeklyFlowPlaylistManager] ensureWeeklyFlowLibrary failed:",
          err?.message,
        );
      }
      try {
        const raw = await this.navidromeClient.getPlaylists();
        playlists = Array.isArray(raw) ? raw : raw ? [raw] : [];
      } catch (err) {
        console.warn(
          "[WeeklyFlowPlaylistManager] getPlaylists failed:",
          err?.message,
        );
      }
    }

    try {
      await fs.mkdir(this.libraryRoot, { recursive: true });
      const existingFiles = await fs.readdir(this.libraryRoot).catch(() => []);
      const expectedFiles = new Set();
      const trackExpectedArtworkFiles = (baseName) => {
        for (const extension of ARTWORK_FILE_EXTENSIONS) {
          expectedFiles.add(`${baseName}${extension}`);
        }
      };
      const trackExpectedPlaylistFiles = (baseName) => {
        expectedFiles.add(`${baseName}.m3u`);
        trackExpectedArtworkFiles(baseName);
      };
      const deleteNavidromePlaylistByName = async (playlistName) => {
        if (!playlists?.length) return;
        const existing = playlists.find(
          (playlist) => playlist.name === playlistName,
        );
        if (!existing) return;
        try {
          await this.navidromeClient.deletePlaylist(existing.id);
        } catch (err) {
          console.warn(
            `[WeeklyFlowPlaylistManager] Failed to delete playlist "${playlistName}" from Navidrome:`,
            err?.message,
          );
        }
      };
      const deleteNavidromePlaylistsByNames = async (playlistNames) => {
        const uniqueNames = [...new Set((playlistNames || []).filter(Boolean))];
        for (const playlistName of uniqueNames) {
          await deleteNavidromePlaylistByName(playlistName);
        }
      };
      const deletePlaylistM3uByNames = async (playlistNames) => {
        const uniqueNames = [...new Set((playlistNames || []).filter(Boolean))];
        for (const playlistName of uniqueNames) {
          const baseName = this._getPlaylistBaseName(playlistName);
          for (const extension of PLAYLIST_FILE_EXTENSIONS) {
            try {
              await fs.unlink(
                path.join(this.libraryRoot, `${baseName}${extension}`),
              );
            } catch {}
          }
        }
      };
      const deletePlaylistAssetsByNames = async (playlistNames) => {
        const uniqueNames = [...new Set((playlistNames || []).filter(Boolean))];
        for (const playlistName of uniqueNames) {
          const baseName = this._getPlaylistBaseName(playlistName);
          for (const extension of [
            ...PLAYLIST_FILE_EXTENSIONS,
            ...ARTWORK_FILE_EXTENSIONS,
            ARTWORK_SUPPRESS_SUFFIX,
          ]) {
            try {
              await fs.unlink(
                path.join(this.libraryRoot, `${baseName}${extension}`),
              );
            } catch {}
          }
        }
      };
      const writePlaylistFile = async (
        playlistName,
        playlistType,
        artworkKind,
      ) => {
        trackExpectedPlaylistFiles(this._getPlaylistBaseName(playlistName));
        await this._writePlaylistFile(playlistName, playlistType, artworkKind);
      };
      for (const flow of flows) {
        const { current, legacy } = this._getFlowPlaylistNames(flow.name);
        const playlistName = current;
        if (flow.enabled) {
          await writePlaylistFile(playlistName, flow.id, "Flow");
          await deleteNavidromePlaylistsByNames(legacy);
          await deletePlaylistAssetsByNames(legacy);
        } else {
          await deleteNavidromePlaylistsByNames([playlistName, ...legacy]);
          await deletePlaylistM3uByNames([playlistName]);
          await deletePlaylistAssetsByNames(legacy);
          trackExpectedArtworkFiles(this._getPlaylistBaseName(playlistName));
          await this._ensureFlowArtwork(flow.id, playlistName, "Flow");
        }
      }
      for (const playlist of sharedPlaylists) {
        const { current, legacy } = this._getSharedPlaylistNames(playlist.name);
        await writePlaylistFile(current, playlist.id, "Playlist");
        await deleteNavidromePlaylistsByNames(legacy);
        await deletePlaylistAssetsByNames(legacy);
      }
      const toRemove = existingFiles.filter((file) => {
        const extension = path.extname(file).toLowerCase();
        if (
          ARTWORK_FILE_EXTENSIONS.includes(extension) ||
          PLAYLIST_FILE_EXTENSIONS.includes(extension)
        ) {
          return !expectedFiles.has(file);
        }
        return false;
      });
      for (const file of toRemove) {
        const extension = path.extname(file).toLowerCase();
        if (PLAYLIST_FILE_EXTENSIONS.includes(extension)) {
          await deleteNavidromePlaylistByName(path.basename(file, extension));
        }
        try {
          await fs.unlink(path.join(this.libraryRoot, file));
        } catch {}
      }
    } catch (err) {
      console.warn(
        "[WeeklyFlowPlaylistManager] Failed to write playlists:",
        err?.message,
      );
    }

    if (this.plexClient?.isConfigured()) {
      try {
        await this._syncPlexPlaylists(flows, sharedPlaylists);
      } catch (err) {
        console.warn(
          "[WeeklyFlowPlaylistManager] Plex playlist sync failed:",
          err?.message,
        );
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

  // Plex has no equivalent of Navidrome's .nsp smart playlists, so we build
  // regular playlists from indexed tracks, grouped by their weekly-flow subfolder.
  async _syncPlexPlaylists(flows, sharedPlaylists) {
    const sectionId = await this._ensurePlexSectionId();
    if (sectionId == null) return;

    const tracks = await this.plexClient.getTracks(sectionId);
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
      ...new Set([
        ...flows.map((f) => f.id),
        ...sharedPlaylists.map((p) => p.id),
      ]),
    ];
    const membership = new Map(playlistIds.map((id) => [id, []]));
    for (const id of playlistIds) {
      for (const [rel, group] of byRelative) {
        const ownsPath = (t) =>
          t.files.some((f) => f.replace(/\\/g, "/").includes(`/${id}/`));
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
    const ratingKeysFor = (playlistType) => membership.get(playlistType) || [];

    const deletePlexPlaylistsByNames = async (names) => {
      const playlists = await this.plexClient.getPlaylists();
      for (const name of [...new Set((names || []).filter(Boolean))]) {
        const existing = playlists.find((p) => p.title === name);
        if (existing) {
          try {
            await this.plexClient.deletePlaylist(existing.ratingKey);
          } catch (err) {
            console.warn(
              `[WeeklyFlowPlaylistManager] Failed to delete Plex playlist "${name}":`,
              err?.message,
            );
          }
        }
      }
    };

    const buildIfChanged = async (desired, ratingKeys) => {
      const hash = this._hashKeys(ratingKeys);
      if (this._plexSyncHashes.get(desired) === hash) return;
      await this.plexClient.createPlaylist(desired, ratingKeys, true);
      this._plexSyncHashes.set(desired, hash);
    };

    // Plex uses the bare flow name; remove any old "[A]"/"[AS]" prefixed names.
    for (const flow of flows) {
      const desired = String(flow.name || "").trim();
      const { current, legacy } = this._getFlowPlaylistNames(flow.name);
      const stale = [current, ...legacy].filter((name) => name !== desired);
      if (flow.enabled) {
        const ratingKeys = ratingKeysFor(flow.id);
        if (ratingKeys.length) {
          await buildIfChanged(desired, ratingKeys);
        } else {
          await deletePlexPlaylistsByNames([desired]);
          this._plexSyncHashes.delete(desired);
        }
        await deletePlexPlaylistsByNames(stale);
      } else {
        await deletePlexPlaylistsByNames([desired, ...stale]);
        this._plexSyncHashes.delete(desired);
      }
    }

    for (const playlist of sharedPlaylists) {
      const desired = String(playlist.name || "").trim();
      const { current, legacy } = this._getSharedPlaylistNames(playlist.name);
      const stale = [current, ...legacy].filter((name) => name !== desired);
      const ratingKeys = ratingKeysFor(playlist.id);
      if (ratingKeys.length) {
        await buildIfChanged(desired, ratingKeys);
      } else {
        await deletePlexPlaylistsByNames([desired]);
        this._plexSyncHashes.delete(desired);
      }
      await deletePlexPlaylistsByNames(stale);
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

    const managedNames = new Set(
      [
        ...flows.map((f) => String(f.name || "").trim()),
        ...sharedPlaylists.map((p) => String(p.name || "").trim()),
      ].filter(Boolean),
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
        console.warn(
          "[WeeklyFlowPlaylistManager] Plex catch-up failed:",
          err?.message,
        );
      } finally {
        this._plexCatchupRunning = false;
      }
    };
    run();
  }

  async _playlistArtworkExists(baseName) {
    for (const extension of ARTWORK_FILE_EXTENSIONS) {
      try {
        await fs.access(
          path.join(this.libraryRoot, `${baseName}${extension}`),
        );
        return true;
      } catch {}
    }
    return false;
  }

  async scanLibrary() {
    const results = [];
    if (this.navidromeClient?.isConfigured()) {
      results.push(await this.navidromeClient.scanLibrary());
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
        const stagingDir = path.join(this.weeklyFlowRoot, "_staging", job.id);
        try {
          await fs.rm(stagingDir, { recursive: true, force: true });
        } catch {}
      }
      const playlistDir = path.join(this.playlistLibraryRoot, playlistType);
      try {
        await fs.rm(playlistDir, { recursive: true, force: true });
        console.log(
          `[WeeklyFlowPlaylistManager] Deleted files for ${playlistType}`,
        );
      } catch (error) {
        console.warn(
          `[WeeklyFlowPlaylistManager] Failed to delete files for ${playlistType}:`,
          error.message,
        );
      }
      downloadTracker.clearByPlaylistType(playlistType);
    }
  }

  getPlaylistName(playlistType) {
    return this._getPlaylistNameSet(playlistType)[0];
  }

  getArtworkKindForPlaylistId(playlistId) {
    if (flowPlaylistConfig.getFlow(playlistId)) return "Flow";
    return "Playlist";
  }

  getArtworkContextForPlaylistId(playlistId) {
    const flow = flowPlaylistConfig.getFlow(playlistId);
    if (flow) {
      return {
        kind: "Flow",
        title: flow.name,
        signature: flow.discoverPresetId || flow.id || flow.name,
        relatedArtists: Array.isArray(flow.relatedArtists)
          ? flow.relatedArtists
          : [],
      };
    }
    const playlist = flowPlaylistConfig.getSharedPlaylist(playlistId);
    if (playlist) {
      return {
        kind: "Playlist",
        title: playlist.name,
        signature: playlist.id || playlist.name,
        relatedArtists: [],
      };
    }
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
      const safePath = path.resolve(
        resolved.safeRoot,
        `${resolved.baseName}${extension}`,
      );
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
    await this._setArtworkGenerationSuppressed(
      resolved.safeRoot,
      resolved.baseName,
      false,
    );
    return webpPath;
  }

  async removeArtwork(playlistId) {
    const resolved = this._resolveArtworkBase(playlistId);
    if (!resolved) {
      throw new Error("Playlist not found");
    }
    let removed = false;
    for (const extension of ARTWORK_FILE_EXTENSIONS) {
      const safePath = path.join(
        resolved.safeRoot,
        `${resolved.baseName}${extension}`,
      );
      if (path.dirname(safePath) !== resolved.safeRoot) continue;
      try {
        await fs.unlink(safePath);
        removed = true;
      } catch {}
    }
    await this._setArtworkGenerationSuppressed(
      resolved.safeRoot,
      resolved.baseName,
      true,
    );
    return removed;
  }

  async generateArtwork(playlistId) {
    const resolved = this._resolveArtworkBase(playlistId);
    if (!resolved) {
      throw new Error("Playlist not found");
    }
    await fs.mkdir(resolved.safeRoot, { recursive: true });
    const artworkExtension = getArtworkExtensionForStyle(getPlaylistArtworkStyle());
    const artworkPath = path.join(
      resolved.safeRoot,
      `${resolved.baseName}${artworkExtension}`,
    );
    if (path.dirname(artworkPath) !== resolved.safeRoot) {
      throw new Error("Invalid artwork path");
    }
    const artworkContext = this.getArtworkContextForPlaylistId(playlistId);
    const outputPath = await writeGeneratedPlaylistArtwork({
      outputPath: artworkPath,
      title: artworkContext?.title || resolved.playlistName,
      kind: artworkContext?.kind || this.getArtworkKindForPlaylistId(playlistId),
      signature: artworkContext?.signature || playlistId,
      relatedArtists: artworkContext?.relatedArtists || [],
      rotateSourceImage: true,
    });
    await this._setArtworkGenerationSuppressed(
      resolved.safeRoot,
      resolved.baseName,
      false,
    );
    return outputPath;
  }
}

export const playlistManager = new WeeklyFlowPlaylistManager();
