import path from "path";
import fs from "fs/promises";
import { dbOps } from "../config/db-helpers.js";
import { NavidromeClient } from "./navidrome.js";
import { PlexClient } from "./plex.js";
import { flowPlaylistConfig } from "./weeklyFlowPlaylistConfig.js";
import { downloadTracker } from "./weeklyFlowDownloadTracker.js";
import { writePlaylistArtworkSidecar } from "./playlistArtwork.js";

export class WeeklyFlowPlaylistManager {
  constructor(
    weeklyFlowRoot = process.env.WEEKLY_FLOW_FOLDER || "/app/downloads",
    { triggerEnsureOnInit = process.env.NODE_ENV !== "test" } = {},
  ) {
    this.weeklyFlowRoot = path.isAbsolute(weeklyFlowRoot)
      ? weeklyFlowRoot
      : path.resolve(process.cwd(), weeklyFlowRoot);
    this.libraryRoot = path.join(this.weeklyFlowRoot, "aurral-weekly-flow");
    this.navidromeClient = null;
    this._navidromeConfigKey = "";
    this.plexClient = null;
    this._plexConfigKey = "";
    this._plexSectionId = null;
    this._ensureInFlight = null;
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
    });
    const plexChanged = this._plexConfigKey !== nextPlexKey;
    this._plexConfigKey = nextPlexKey;
    if (plexConfig.url && plexConfig.token) {
      if (!this.plexClient || plexChanged) {
        this.plexClient = new PlexClient(
          plexConfig.url,
          plexConfig.token,
          plexConfig.clientId,
        );
        this._plexSectionId = null;
      }
    } else {
      this.plexClient = null;
      this._plexSectionId = null;
    }

    if (triggerEnsurePlaylists) {
      this.ensureSmartPlaylists().catch((err) =>
        console.warn(
          "[WeeklyFlowPlaylistManager] ensureSmartPlaylists on config:",
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

  _getWeeklyFlowLibraryHostPath() {
    const base = process.env.DOWNLOAD_FOLDER || "/data/downloads/tmp";
    return `${base.replace(/\\/g, "/").replace(/\/+$/, "")}/aurral-weekly-flow`;
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

  async ensureSmartPlaylists() {
    if (this._ensureInFlight) {
      return this._ensureInFlight;
    }
    this._ensureInFlight = this._ensureSmartPlaylistsInternal();
    try {
      return await this._ensureInFlight;
    } finally {
      this._ensureInFlight = null;
    }
  }

  async _ensureSmartPlaylistsInternal() {
    const flows = flowPlaylistConfig.getFlows();
    const sharedPlaylists = flowPlaylistConfig.getSharedPlaylists();
    let libraryId = null;
    let playlists = null;
    if (this.navidromeClient?.isConfigured()) {
      try {
        const hostPath = this._getWeeklyFlowLibraryHostPath();
        const library =
          await this.navidromeClient.ensureWeeklyFlowLibrary(hostPath);
        if (
          library != null &&
          library.id !== undefined &&
          library.id !== null
        ) {
          libraryId = library.id;
        } else if (library != null) {
          console.warn(
            "[WeeklyFlowPlaylistManager] Aurral library has no id; smart playlists will not be scoped by library.",
          );
        }
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
      const trackExpectedFiles = (baseName) => {
        expectedFiles.add(`${baseName}.nsp`);
        expectedFiles.add(`${baseName}.png`);
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
      const deletePlaylistAssetsByNames = async (playlistNames) => {
        const uniqueNames = [...new Set((playlistNames || []).filter(Boolean))];
        for (const playlistName of uniqueNames) {
          const baseName = this._getPlaylistBaseName(playlistName);
          for (const extension of [".nsp", ".png"]) {
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
        const baseName = this._getPlaylistBaseName(playlistName);
        const nspPath = path.join(this.libraryRoot, `${baseName}.nsp`);
        const artworkPath = path.join(this.libraryRoot, `${baseName}.png`);
        trackExpectedFiles(baseName);
        const pathCondition = { contains: { filepath: playlistType } };
        const all =
          libraryId != null
            ? [{ is: { library_id: libraryId } }, pathCondition]
            : [pathCondition];
        const payload = {
          all,
          // Keep playlist order stable as tracks are added over time.
          sort: "filepath",
          limit: 1000,
        };
        await fs.writeFile(nspPath, JSON.stringify(payload), "utf8");
        await writePlaylistArtworkSidecar({
          playlistName,
          kind: artworkKind,
          outputPath: artworkPath,
        });
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
          await deletePlaylistAssetsByNames([playlistName, ...legacy]);
        }
      }
      for (const playlist of sharedPlaylists) {
        const { current, legacy } = this._getSharedPlaylistNames(playlist.name);
        await writePlaylistFile(current, playlist.id, "Playlist");
        await deleteNavidromePlaylistsByNames(legacy);
        await deletePlaylistAssetsByNames(legacy);
      }
      const toRemove = existingFiles.filter(
        (file) =>
          (file.endsWith(".nsp") || file.endsWith(".png")) &&
          !expectedFiles.has(file),
      );
      for (const file of toRemove) {
        if (file.endsWith(".nsp")) {
          await deleteNavidromePlaylistByName(path.basename(file, ".nsp"));
        }
        try {
          await fs.unlink(path.join(this.libraryRoot, file));
        } catch {}
      }
    } catch (err) {
      console.warn(
        "[WeeklyFlowPlaylistManager] Failed to write smart playlists:",
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

  async _ensurePlexSectionId() {
    if (this._plexSectionId != null) return this._plexSectionId;
    const hostPath = this._getWeeklyFlowLibraryHostPath();
    const library = await this.plexClient.ensureWeeklyFlowLibrary(hostPath);
    // Plex section objects expose the section id as `key`.
    const id = library?.key ?? null;
    this._plexSectionId = id;
    return id;
  }

  /**
   * Plex has no equivalent of Navidrome's .nsp smart playlists, so we build
   * regular audio playlists from the tracks Plex has indexed: group indexed
   * tracks by their weekly-flow subfolder and create/replace one playlist per
   * enabled flow / shared playlist. New downloads are picked up on the next
   * sync once Plex has scanned them.
   */
  async _syncPlexPlaylists(flows, sharedPlaylists) {
    const sectionId = await this._ensurePlexSectionId();
    if (sectionId == null) return;

    const tracks = await this.plexClient.getTracks(sectionId);
    const ratingKeysFor = (playlistType) => {
      const needle = `/${playlistType}/`;
      return tracks
        .filter((t) => t.file && t.file.replace(/\\/g, "/").includes(needle))
        .map((t) => t.ratingKey)
        .filter(Boolean);
    };

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

    for (const flow of flows) {
      const { current, legacy } = this._getFlowPlaylistNames(flow.name);
      if (flow.enabled) {
        const ratingKeys = ratingKeysFor(flow.id);
        if (ratingKeys.length) {
          await this.plexClient.createPlaylist(current, ratingKeys, true);
        } else {
          await deletePlexPlaylistsByNames([current]);
        }
        await deletePlexPlaylistsByNames(legacy);
      } else {
        await deletePlexPlaylistsByNames([current, ...legacy]);
      }
    }

    for (const playlist of sharedPlaylists) {
      const { current, legacy } = this._getSharedPlaylistNames(playlist.name);
      const ratingKeys = ratingKeysFor(playlist.id);
      if (ratingKeys.length) {
        await this.plexClient.createPlaylist(current, ratingKeys, true);
      } else {
        await deletePlexPlaylistsByNames([current]);
      }
      await deletePlexPlaylistsByNames(legacy);
    }
  }

  /**
   * Manual Plex sync for an existing flow. Returns quickly: ensures the
   * library, triggers a scan, builds playlists from whatever Plex has already
   * indexed, and reports status. Because Plex's music scan (with online
   * metadata matching) can take minutes, we don't block on it here — instead a
   * background catch-up rebuilds the playlists as tracks get indexed.
   */
  async syncPlexNow() {
    if (!this.plexClient?.isConfigured()) {
      return { configured: false };
    }
    const sectionId = await this._ensurePlexSectionId();
    if (sectionId == null) {
      throw new Error("Could not create or find the Aurral Plex library");
    }
    await this.plexClient.scanLibrary(sectionId);

    const flows = flowPlaylistConfig.getFlows();
    const sharedPlaylists = flowPlaylistConfig.getSharedPlaylists();
    await this._syncPlexPlaylists(flows, sharedPlaylists);

    const tracks = await this.plexClient.getTracks(sectionId);
    const playlists = await this.plexClient.getPlaylists();

    // Kick off a non-blocking catch-up so playlists fill in once Plex finishes
    // indexing, without the user needing to click sync again.
    this._schedulePlexCatchup(sectionId);

    return {
      configured: true,
      sectionId,
      indexedTracks: tracks.length,
      scanInProgress: tracks.length === 0,
      playlists: playlists
        .filter(
          (p) => p.title?.startsWith("[A] ") || p.title?.startsWith("[AS] "),
        )
        .map((p) => ({ title: p.title, count: p.leafCount ?? null })),
    };
  }

  /**
   * Rebuild Plex playlists a few times over the next several minutes so they
   * populate as a freshly-triggered scan indexes tracks. Only one catch-up
   * runs at a time.
   */
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
      const playlistDir = path.join(this.libraryRoot, playlistType);
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
}

export const playlistManager = new WeeklyFlowPlaylistManager();
