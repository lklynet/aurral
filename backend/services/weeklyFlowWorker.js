import path from "path";
import fs from "fs/promises";
import { downloadTracker } from "./weeklyFlowDownloadTracker.js";
import { soulseekClient } from "./simpleSoulseekClient.js";
import { playlistManager } from "./weeklyFlowPlaylistManager.js";
import { flowPlaylistConfig } from "./weeklyFlowPlaylistConfig.js";

const CONCURRENCY = 1;
const JOB_COOLDOWN_MS = 2000;
const SEARCH_ROUNDS = 1;
const MAX_MATCH_CANDIDATES = 3;
const FALLBACK_MP3_REGEX = /^[^/\\]+-[a-f0-9]{8}\.mp3$/i;
const ENABLE_METADATA_ALBUM_PARSE = false;
const FALLBACK_SWEEP_INTERVAL_MS = 60000;
const MAX_RETRIES_PER_JOB = 1;

export class WeeklyFlowWorker {
  constructor(
    weeklyFlowRoot = process.env.WEEKLY_FLOW_FOLDER || "/app/downloads",
  ) {
    this.weeklyFlowRoot = path.isAbsolute(weeklyFlowRoot)
      ? weeklyFlowRoot
      : path.resolve(process.cwd(), weeklyFlowRoot);
    this.running = false;
    this.activeCount = 0;
    this.lastFallbackSweepAt = 0;
    this.processLoop = null;
    this.processTimer = null;
    this.retryAttempts = new Map();
    this.currentJob = null;
  }

  async moveFallbackMp3sToDir(force = false) {
    const now = Date.now();
    if (!force && now - this.lastFallbackSweepAt < FALLBACK_SWEEP_INTERVAL_MS) {
      return;
    }
    this.lastFallbackSweepAt = now;
    const cwd = process.cwd();
    if (path.resolve(cwd) === path.resolve(this.weeklyFlowRoot)) return;
    const fallbackDir = path.join(this.weeklyFlowRoot, "_fallback");
    try {
      const entries = await fs.readdir(cwd, { withFileTypes: true });
      const toMove = entries.filter(
        (e) =>
          e.isFile() &&
          e.name.endsWith(".mp3") &&
          FALLBACK_MP3_REGEX.test(e.name),
      );
      if (toMove.length === 0) return;
      await fs.mkdir(fallbackDir, { recursive: true });
      for (const e of toMove) {
        const src = path.join(cwd, e.name);
        const dest = path.join(fallbackDir, e.name);
        try {
          await fs.rename(src, dest);
        } catch {}
      }
    } catch {}
  }

  async start() {
    if (this.running) {
      return;
    }

    this.running = true;
    console.log("[WeeklyFlowWorker] Starting worker...");
    await this.moveFallbackMp3sToDir(true);

    this.processLoop = () => {
      if (!this.running) return;

      while (this.activeCount < CONCURRENCY) {
        const job = downloadTracker.getNextPending();
        if (!job) break;

        this.activeCount++;
        this.currentJob = {
          id: job.id,
          playlistType: job.playlistType,
          artistName: job.artistName,
          trackName: job.trackName,
          progressPct: 0,
          startedAt: Date.now(),
        };
        this.processJob(job)
          .catch(async (error) => {
            const attempts = Number(this.retryAttempts.get(job.id) || 0);
            if (attempts < MAX_RETRIES_PER_JOB) {
              this.retryAttempts.set(job.id, attempts + 1);
              downloadTracker.setPending(job.id, error.message);
              return;
            }
            this.retryAttempts.delete(job.id);
            console.error(
              `[WeeklyFlowWorker] Error processing job ${job.id}:`,
              error.message,
            );
            downloadTracker.setFailed(job.id, error.message);
            await this.checkPlaylistComplete(job.playlistType);
          })
          .finally(() => {
            this.activeCount--;
            if (this.activeCount <= 0) {
              this.currentJob = null;
            }
            this.moveFallbackMp3sToDir(false).catch(() => {});
            if (this.running && !this.processTimer) {
              this.processTimer = setTimeout(() => {
                this.processTimer = null;
                if (this.processLoop) this.processLoop();
              }, JOB_COOLDOWN_MS);
            }
          });
      }
    };

    this.processLoop();
  }

  stop() {
    if (!this.running) {
      return;
    }

    this.running = false;
    if (this.processTimer) {
      clearTimeout(this.processTimer);
      this.processTimer = null;
    }
    this.processLoop = null;
    this.retryAttempts.clear();
    this.currentJob = null;
    downloadTracker.resetDownloadingToPending();
    soulseekClient.disconnect().catch(() => {});
    console.log("[WeeklyFlowWorker] Worker stopped");
  }

  _normalizeAlbumName(value) {
    const text = String(value || "")
      .replace(/\u0000/g, "")
      .trim();
    return text || null;
  }

  _parseAlbumFromPath(filePath) {
    if (!filePath || typeof filePath !== "string") return null;
    const normalized = filePath.replace(/\\/g, "/").trim();
    const parts = normalized.split("/").filter(Boolean);
    if (parts.length < 2) return null;
    return this._normalizeAlbumName(parts[parts.length - 2]);
  }

  _decodeSynchsafeInt(bytes) {
    if (!bytes || bytes.length < 4) return 0;
    return (
      ((bytes[0] & 0x7f) << 21) |
      ((bytes[1] & 0x7f) << 14) |
      ((bytes[2] & 0x7f) << 7) |
      (bytes[3] & 0x7f)
    );
  }

  _decodeUtf16be(buffer) {
    if (!buffer || buffer.length === 0) return "";
    const evenLength = buffer.length - (buffer.length % 2);
    if (evenLength <= 0) return "";
    const source = buffer.subarray(0, evenLength);
    const swapped = Buffer.allocUnsafe(evenLength);
    for (let i = 0; i < evenLength; i += 2) {
      swapped[i] = source[i + 1];
      swapped[i + 1] = source[i];
    }
    return swapped.toString("utf16le");
  }

  _decodeId3TextFrame(framePayload) {
    if (!Buffer.isBuffer(framePayload) || framePayload.length === 0) {
      return null;
    }
    const encoding = framePayload[0];
    const content = framePayload.subarray(1);
    let text = "";
    if (encoding === 0) {
      text = content.toString("latin1");
    } else if (encoding === 1) {
      if (content.length >= 2 && content[0] === 0xfe && content[1] === 0xff) {
        text = this._decodeUtf16be(content.subarray(2));
      } else if (
        content.length >= 2 &&
        content[0] === 0xff &&
        content[1] === 0xfe
      ) {
        text = content.subarray(2).toString("utf16le");
      } else {
        text = content.toString("utf16le");
      }
    } else if (encoding === 2) {
      text = this._decodeUtf16be(content);
    } else if (encoding === 3) {
      text = content.toString("utf8");
    } else {
      text = content.toString("utf8");
    }
    return this._normalizeAlbumName(text);
  }

  _extractAlbumFromId3v2(buffer) {
    if (!Buffer.isBuffer(buffer) || buffer.length < 10) return null;
    if (buffer.subarray(0, 3).toString("ascii") !== "ID3") return null;
    const major = buffer[3];
    const tagSize = this._decodeSynchsafeInt(buffer.subarray(6, 10));
    const end = Math.min(buffer.length, 10 + tagSize);
    let offset = 10;
    while (offset < end) {
      if (major === 2) {
        if (offset + 6 > end) break;
        const id = buffer.subarray(offset, offset + 3).toString("ascii");
        if (!id || id === "\u0000\u0000\u0000") break;
        const size =
          (buffer[offset + 3] << 16) |
          (buffer[offset + 4] << 8) |
          buffer[offset + 5];
        if (size <= 0) break;
        const payloadStart = offset + 6;
        const payloadEnd = payloadStart + size;
        if (payloadEnd > end) break;
        if (id === "TAL") {
          const album = this._decodeId3TextFrame(
            buffer.subarray(payloadStart, payloadEnd),
          );
          if (album) return album;
        }
        offset = payloadEnd;
        continue;
      }
      if (offset + 10 > end) break;
      const id = buffer.subarray(offset, offset + 4).toString("ascii");
      if (!id || id === "\u0000\u0000\u0000\u0000") break;
      const sizeBytes = buffer.subarray(offset + 4, offset + 8);
      const size =
        major === 4
          ? this._decodeSynchsafeInt(sizeBytes)
          : sizeBytes.readUInt32BE(0);
      if (size <= 0) break;
      const payloadStart = offset + 10;
      const payloadEnd = payloadStart + size;
      if (payloadEnd > end) break;
      if (id === "TALB") {
        const album = this._decodeId3TextFrame(
          buffer.subarray(payloadStart, payloadEnd),
        );
        if (album) return album;
      }
      offset = payloadEnd;
    }
    return null;
  }

  _extractAlbumFromId3v1(buffer) {
    if (!Buffer.isBuffer(buffer) || buffer.length < 128) return null;
    const tag = buffer.subarray(buffer.length - 128, buffer.length);
    if (tag.subarray(0, 3).toString("ascii") !== "TAG") return null;
    const album = tag.subarray(63, 93).toString("latin1");
    return this._normalizeAlbumName(album);
  }

  async _readAlbumFromMetadata(filePath) {
    if (!filePath) return null;
    const ext = path.extname(filePath).toLowerCase();
    if (ext !== ".mp3") return null;
    let handle;
    try {
      handle = await fs.open(filePath, "r");
      const stat = await handle.stat();
      if (!stat?.size) return null;
      const headSize = Math.min(stat.size, 256 * 1024);
      const headBuffer = Buffer.allocUnsafe(headSize);
      await handle.read(headBuffer, 0, headSize, 0);
      const id3v2Album = this._extractAlbumFromId3v2(headBuffer);
      if (id3v2Album) return id3v2Album;
      if (stat.size >= 128) {
        const tailBuffer = Buffer.allocUnsafe(128);
        await handle.read(tailBuffer, 0, 128, stat.size - 128);
        return this._extractAlbumFromId3v1(tailBuffer);
      }
      return null;
    } catch {
      return null;
    } finally {
      if (handle) {
        await handle.close().catch(() => {});
      }
    }
  }

  async processJob(job) {
    console.log(
      `[WeeklyFlowWorker] Processing job ${job.id}: ${job.artistName} - ${job.trackName} (${job.playlistType})`,
    );

    const stagingDir = path.join(this.weeklyFlowRoot, "_staging", job.id);
    const stagingPath = path.join(
      stagingDir,
      `${job.artistName} - ${job.trackName}.tmp`,
    );

    downloadTracker.setDownloading(job.id, stagingPath);

    try {
      const initialResults = await soulseekClient.search(
        job.artistName,
        job.trackName,
      );
      if (!initialResults || initialResults.length === 0) {
        throw new Error("No search results found");
      }

      let selectedMatch = null;
      let selectedExt = ".mp3";
      let downloadedSourcePath = null;
      let lastError = null;

      await new Promise((r) => setImmediate(r));
      await fs.mkdir(stagingDir, { recursive: true });
      const stagingFile = `${job.artistName} - ${job.trackName}`;
      const stagingFilePath = path.join(stagingDir, stagingFile);

      for (let searchRound = 0; searchRound < SEARCH_ROUNDS; searchRound += 1) {
        const sourceResults =
          searchRound === 0
            ? initialResults
            : await soulseekClient.search(job.artistName, job.trackName);
        const candidates = soulseekClient.pickBestMatches(
          sourceResults,
          job.trackName,
          MAX_MATCH_CANDIDATES,
        );
        for (const candidate of candidates) {
          const extFromSoulseek = path.extname(candidate.file || "");
          const ext =
            extFromSoulseek &&
            /^\.(flac|mp3|m4a|ogg|wav)$/i.test(extFromSoulseek)
              ? extFromSoulseek
              : ".mp3";
          try {
            downloadedSourcePath = await soulseekClient.download(
              candidate,
              stagingFilePath,
              (progressPct) => {
                if (!this.currentJob || this.currentJob.id !== job.id) return;
                this.currentJob.progressPct = progressPct;
              },
            );
            selectedMatch = candidate;
            selectedExt = ext;
            lastError = null;
            break;
          } catch (err) {
            lastError = err;
          }
        }
        if (selectedMatch) {
          break;
        }
      }
      if (!selectedMatch) {
        throw lastError || new Error("No suitable match found");
      }

      const sourcePath =
        typeof downloadedSourcePath === "string" && downloadedSourcePath
          ? downloadedSourcePath
          : null;
      if (!sourcePath) {
        throw new Error("Download completed but no file found");
      }
      const downloadedExt = path.extname(sourcePath).toLowerCase();
      const finalExt =
        downloadedExt && /^\.(flac|mp3|m4a|ogg|wav)$/i.test(downloadedExt)
          ? downloadedExt
          : selectedExt;

      const sanitize = (str) => {
        return str.replace(/[<>:"/\\|?*]/g, "_").trim();
      };

      const artistDir = sanitize(job.artistName);
      const albumFromApi = this._normalizeAlbumName(job.albumName);
      const albumFromPath = this._parseAlbumFromPath(selectedMatch.file);
      const albumFromMetadata =
        !ENABLE_METADATA_ALBUM_PARSE || albumFromApi || albumFromPath
          ? null
          : await this._readAlbumFromMetadata(sourcePath);
      const resolvedAlbum =
        albumFromApi || albumFromPath || albumFromMetadata || "Unknown Album";
      const albumDir = sanitize(resolvedAlbum);
      const finalDir = path.join(
        this.weeklyFlowRoot,
        "aurral-weekly-flow",
        job.playlistType,
        artistDir,
        albumDir,
      );
      const finalFileName = `${sanitize(job.trackName)}${finalExt}`;
      const finalPath = path.join(finalDir, finalFileName);

      await fs.mkdir(finalDir, { recursive: true });
      await fs.rename(sourcePath, finalPath);

      await fs.rm(stagingDir, { recursive: true, force: true });

      downloadTracker.setDone(job.id, finalPath, resolvedAlbum);
      this.retryAttempts.delete(job.id);
      console.log(`[WeeklyFlowWorker] Job ${job.id} completed: ${finalPath}`);

      await this.checkPlaylistComplete(job.playlistType);
    } catch (error) {
      try {
        await fs.rm(stagingDir, { recursive: true, force: true });
      } catch (cleanupError) {
        console.warn(
          `[WeeklyFlowWorker] Failed to cleanup staging dir: ${cleanupError.message}`,
        );
      }
      throw error;
    }
  }

  async checkPlaylistComplete(playlistType) {
    const stats = downloadTracker.getPlaylistTypeStats(playlistType);
    const allDone =
      stats.total > 0 && stats.pending === 0 && stats.downloading === 0;
    const hasDone = stats.done > 0;

    if (allDone && hasDone) {
      console.log(
        `[WeeklyFlowWorker] All jobs complete for ${playlistType}, ensuring smart playlists...`,
      );
      try {
        await fs.rm(path.join(this.weeklyFlowRoot, "_fallback"), {
          recursive: true,
          force: true,
        });
      } catch {}
      try {
        playlistManager.updateConfig(false);
        await playlistManager.ensureSmartPlaylists();
        await playlistManager.scanLibrary();
        if (flowPlaylistConfig.isEnabled(playlistType)) {
          flowPlaylistConfig.scheduleNextRun(playlistType);
        }
      } catch (error) {
        console.error(
          `[WeeklyFlowWorker] Failed to ensure smart playlists for ${playlistType}:`,
          error.message,
        );
      }
      const completed = stats.done;
      const failed = stats.failed;
      const { notifyWeeklyFlowDone } = await import("./notificationService.js");
      notifyWeeklyFlowDone(playlistType, { completed, failed }).catch((err) =>
        console.warn(
          "[WeeklyFlowWorker] Gotify notification failed:",
          err.message,
        ),
      );
      if (!downloadTracker.getNextPending()) {
        this.stop();
      }
    }
  }

  getStatus() {
    return {
      running: this.running,
      processing: this.activeCount > 0,
      activeCount: this.activeCount,
      stats: downloadTracker.getStats(),
      currentJob: this.currentJob,
    };
  }
}

export const weeklyFlowWorker = new WeeklyFlowWorker();
