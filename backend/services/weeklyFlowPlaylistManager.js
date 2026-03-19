import path from "path";
import fs from "fs/promises";
import { dbOps } from "../config/db-helpers.js";
import { NavidromeClient } from "./navidrome.js";
import { flowPlaylistConfig } from "./weeklyFlowPlaylistConfig.js";
import { downloadTracker } from "./weeklyFlowDownloadTracker.js";

export class WeeklyFlowPlaylistManager {
  constructor(
    weeklyFlowRoot = process.env.WEEKLY_FLOW_FOLDER || "/app/downloads"
  ) {
    this.weeklyFlowRoot = path.isAbsolute(weeklyFlowRoot)
      ? weeklyFlowRoot
      : path.resolve(process.cwd(), weeklyFlowRoot);
    this.libraryRoot = path.join(this.weeklyFlowRoot, "aurral-weekly-flow");
    this.navidromeClient = null;
    this._navidromeConfigKey = "";
    this._ensureInFlight = null;
    this.updateConfig();
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
          navidromeConfig.password
        );
      }
    } else {
      this.navidromeClient = null;
    }

    if (triggerEnsurePlaylists) {
      this.ensureSmartPlaylists().catch((err) =>
        console.warn(
          "[WeeklyFlowPlaylistManager] ensureSmartPlaylists on config:",
          err?.message
        )
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
    let libraryId = null;
    let playlists = null;
    if (this.navidromeClient?.isConfigured()) {
      try {
        const hostPath = this._getWeeklyFlowLibraryHostPath();
        const library =
          await this.navidromeClient.ensureWeeklyFlowLibrary(hostPath);
        if (library != null && (library.id !== undefined && library.id !== null)) {
          libraryId = library.id;
        } else if (library != null) {
          console.warn(
            "[WeeklyFlowPlaylistManager] Aurral library has no id; smart playlists will not be scoped by library."
          );
        }
      } catch (err) {
        console.warn(
          "[WeeklyFlowPlaylistManager] ensureWeeklyFlowLibrary failed:",
          err?.message
        );
      }
      try {
        const raw = await this.navidromeClient.getPlaylists();
        playlists = Array.isArray(raw) ? raw : raw ? [raw] : [];
      } catch (err) {
        console.warn(
          "[WeeklyFlowPlaylistManager] getPlaylists failed:",
          err?.message
        );
      }
    }

    try {
      await fs.mkdir(this.libraryRoot, { recursive: true });
      const existingFiles = await fs.readdir(this.libraryRoot).catch(() => []);
      const expectedFiles = new Set();
      for (const flow of flows) {
        const playlistName = `Aurral ${flow.name}`;
        const fileName = `${this._sanitize(playlistName)}.nsp`;
        const nspPath = path.join(this.libraryRoot, fileName);
        expectedFiles.add(fileName);
        if (flow.enabled) {
          const pathCondition = { contains: { filepath: flow.id } };
          const all =
            libraryId != null
              ? [{ is: { library_id: libraryId } }, pathCondition]
              : [pathCondition];
          const payload = {
            all,
            sort: "random",
            limit: 1000,
          };
          await fs.writeFile(nspPath, JSON.stringify(payload), "utf8");
        } else {
          if (playlists?.length) {
            const existing = playlists.find((p) => p.name === playlistName);
            if (existing) {
              try {
                await this.navidromeClient.deletePlaylist(existing.id);
              } catch (err) {
                console.warn(
                  `[WeeklyFlowPlaylistManager] Failed to delete playlist "${playlistName}" from Navidrome:`,
                  err?.message
                );
              }
            }
          }
          try {
            await fs.unlink(nspPath);
          } catch {}
        }
      }
      const toRemove = existingFiles.filter(
        (file) => file.endsWith(".nsp") && !expectedFiles.has(file),
      );
      for (const file of toRemove) {
        try {
          await fs.unlink(path.join(this.libraryRoot, file));
        } catch {}
      }
    } catch (err) {
      console.warn(
        "[WeeklyFlowPlaylistManager] Failed to write smart playlists:",
        err?.message
      );
    }
  }

  async scanLibrary() {
    if (!this.navidromeClient?.isConfigured()) return null;
    return this.navidromeClient.scanLibrary();
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
          `[WeeklyFlowPlaylistManager] Deleted files for ${playlistType}`
        );
      } catch (error) {
        console.warn(
          `[WeeklyFlowPlaylistManager] Failed to delete files for ${playlistType}:`,
          error.message
        );
      }
      downloadTracker.clearByPlaylistType(playlistType);
    }
  }

  getPlaylistName(playlistType) {
    const flow = flowPlaylistConfig.getFlow(playlistType);
    if (flow) return `Aurral ${flow.name}`;
    return `Aurral ${playlistType}`;
  }
}

export const playlistManager = new WeeklyFlowPlaylistManager();
