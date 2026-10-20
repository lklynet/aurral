import { spawn } from "child_process";
import fs from "fs";
import fsPromises from "fs/promises";
import path from "path";
import { dbOps } from "../db/helpers/index.js";
import { resolveYtdlpStagingRoot } from "./downloadFolderConfig.js";
import { logger } from "./logger.js";

const DEFAULT_BINARY = "yt-dlp";
const SEARCH_LIMIT = 5;
const SONG_SEARCH_LIMIT = 10;
const SONG_SEARCH_BUDGET_MS = 15000;
const SONG_READ_BATCH = 3;
const DOWNLOAD_TIMEOUT_MS = 10 * 60 * 1000;
const AUDIO_FORMAT = "m4a";
const activeDownloads = new Map();

export const ytdlpSettings = Object.freeze({
  key: "ytdlp",
  label: "yt-dlp",
  subtitle: "YouTube / web",
  enabledDefault: true,
  healthKey: "ytdlpConfigured",
  testRequiresEnabled: false,
  fields: Object.freeze([
    Object.freeze({ key: "enabled", label: "Enable yt-dlp", type: "toggle" }),
    Object.freeze({
      key: "priority",
      label: "Source priority",
      type: "number",
      min: 1,
      max: 1000,
      section: "Behavior",
    }),
    Object.freeze({
      key: "stagingPath",
      label: "Staging path",
      type: "path",
      section: "Downloads",
      hint: "Temporary downloads stay here until imported.",
    }),
  ]),
  defaults: Object.freeze({ enabled: true, priority: 50, stagingPath: "" }),
  validation: Object.freeze({ required: [], url: [] }),
  testConnection: true,
});

function getSettings(config = null) {
  return config || dbOps.getSettings()?.integrations?.ytdlp || {};
}

function getBinaryPath() {
  return DEFAULT_BINARY;
}

function isEnabledFor(config = null) {
  return getSettings(config).enabled !== false;
}

function resolveBinaryExists(binary) {
  const candidates = path.isAbsolute(binary)
    ? [binary]
    : String(process.env.PATH || "")
        .split(path.delimiter)
        .filter(Boolean)
        .map((dir) => path.join(dir, binary));
  return candidates.some((candidate) => {
    try {
      fs.accessSync(candidate, fs.constants.X_OK);
      return true;
    } catch {
      return false;
    }
  });
}

export function buildYtdlpInvocationArgs(
  args,
  { nodeAvailable = resolveBinaryExists("node") } = {},
) {
  return [
    ...(nodeAvailable ? ["--no-js-runtimes", "--js-runtimes", "node"] : []),
    ...args,
  ];
}

function isConfiguredFor(config = null) {
  return isEnabledFor(config) && resolveBinaryExists(getBinaryPath());
}

function runYtdlp(args, { timeoutMs = 120000, cwd, shouldCancel, signal } = {}) {
  return new Promise((resolve, reject) => {
    const isolatedProcessGroup = process.platform !== "win32";
    const child = spawn(getBinaryPath(), buildYtdlpInvocationArgs(args), {
      cwd,
      env: process.env,
      stdio: ["ignore", "pipe", "pipe"],
      detached: isolatedProcessGroup,
    });
    const signalProcess = (signal) => {
      if (isolatedProcessGroup && child.pid) {
        try {
          process.kill(-child.pid, signal);
          return;
        } catch {}
      }
      child.kill(signal);
    };
    let stdout = "";
    let stderr = "";
    let settled = false;
    let terminationError = null;
    let forcedKillTimer = null;
    const timer = setTimeout(() => {
      const error = new Error(`yt-dlp timed out after ${timeoutMs}ms`);
      error.code = "DOWNLOAD_TIMEOUT";
      terminationError = error;
      signalProcess("SIGKILL");
    }, timeoutMs);
    const cancellationTimer = typeof shouldCancel === "function"
      ? setInterval(() => {
          let cancelled = false;
          try {
            cancelled = shouldCancel() === true;
          } catch {}
          if (!cancelled || terminationError) return;
          const error = new Error("yt-dlp download cancelled");
          error.code = "DOWNLOAD_CANCELLED";
          terminationError = error;
          clearTimeout(timer);
          signalProcess("SIGTERM");
          forcedKillTimer = setTimeout(() => signalProcess("SIGKILL"), 1000);
        }, 250)
      : null;
    if (typeof cancellationTimer?.unref === "function") cancellationTimer.unref();
    const abort = () => {
      if (terminationError) return;
      terminationError = signal.reason instanceof Error ? signal.reason : new Error("yt-dlp stopped");
      clearTimeout(timer);
      signalProcess("SIGKILL");
    };
    signal?.addEventListener("abort", abort, { once: true });
    if (signal?.aborted) abort();
    function clearTimers() {
      clearTimeout(timer);
      if (forcedKillTimer) clearTimeout(forcedKillTimer);
      if (cancellationTimer) clearInterval(cancellationTimer);
      signal?.removeEventListener("abort", abort);
    }
    function settleReject(error) {
      if (settled) return;
      settled = true;
      clearTimers();
      reject(error);
    }
    child.stdout.on("data", (chunk) => {
      stdout += chunk.toString();
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk.toString();
    });
    child.on("error", (error) => {
      settleReject(error);
    });
    child.on("close", (code) => {
      if (settled) return;
      settled = true;
      clearTimers();
      if (terminationError && code !== 0) {
        signalProcess("SIGKILL");
        reject(terminationError);
        return;
      }
      if (code !== 0) {
        const detail = String(stderr || stdout || "").trim().slice(-500);
        reject(new Error(detail || `yt-dlp exited with code ${code}`));
        return;
      }
      resolve({ stdout, stderr });
    });
  });
}

async function testConnectionFor(config = null, { force: _force = false } = {}) {
  if (!isEnabledFor(config)) {
    return { configured: false, ok: false, message: "yt-dlp is disabled" };
  }
  const binary = getBinaryPath();
  if (!resolveBinaryExists(binary)) {
    return {
      configured: false,
      ok: false,
      message: `yt-dlp binary not found (${binary}). Install yt-dlp and ffmpeg.`,
    };
  }
  try {
    const { stdout } = await runYtdlp(["--version"], { timeoutMs: 15000 });
    const version = String(stdout || "").trim().split(/\s+/)[0] || "ok";
    return { configured: true, ok: true, version, message: `yt-dlp ${version}` };
  } catch (error) {
    return { configured: true, ok: false, message: error?.message || String(error) };
  }
}

function readJsonLines(stdout) {
  return String(stdout || "").split("\n").flatMap((line) => {
    try {
      return line.trim() ? [JSON.parse(line)] : [];
    } catch {
      return [];
    }
  });
}

function readDurationSec(value) {
  return Number.isFinite(Number(value)) && Number(value) > 0 ? Number(value) : null;
}

function songUrl(id) {
  return `https://music.youtube.com/watch?v=${encodeURIComponent(id)}`;
}

function isSongUrl(url) {
  return /^https:\/\/music\.youtube\.com\//u.test(String(url || ""));
}

function readSong(stdout, { id, title }) {
  const [entry] = readJsonLines(stdout);
  if (!entry) return null;
  const artists = Array.isArray(entry.artists) ? entry.artists : [entry.artist];
  return {
    id,
    title: String(entry.track || entry.title || title).trim(),
    url: songUrl(id),
    channel: String(entry.channel || entry.uploader || "").trim(),
    durationSec: readDurationSec(entry.duration),
    liveStatus: String(entry.live_status || "").trim().toLowerCase(),
    artists: [...new Set(artists.map((name) => String(name || "").trim()).filter(Boolean))],
    album: String(entry.album || "").trim() || null,
    song: true,
  };
}

// The song search lists only ids and titles, so the songs `wanted` keeps are
// read in full for YouTube Music's own artists, album, and length, a few at a
// time. `decided` is asked after each batch, so every read a batch starts
// counts and one search gives the same songs each time; the search stops once
// it agrees. At the search deadline, the reads still running are killed and
// the songs in hand are returned. A song that cannot be read (age-gated,
// removed) is left out.
async function searchSongs(query, { limit, wanted = () => true, decided = () => false }) {
  const stop = new AbortController();
  const deadline = setTimeout(() => stop.abort(
    new Error(`YouTube Music search took longer than ${SONG_SEARCH_BUDGET_MS}ms`)), SONG_SEARCH_BUDGET_MS);
  try {
    const { stdout } = await runYtdlp(
      [
        "--flat-playlist",
        "--dump-json",
        "--no-warnings",
        "--playlist-end",
        String(SONG_SEARCH_LIMIT),
        `https://music.youtube.com/search?q=${encodeURIComponent(query)}#songs`,
      ],
      { signal: stop.signal },
    );
    const listed = readJsonLines(stdout)
      .map((entry) => ({ id: String(entry.id || "").trim(), title: String(entry.title || "").trim() }))
      .filter((entry) => entry.id && wanted(entry))
      .slice(0, limit);
    const songs = [];
    for (let first = 0; first < listed.length && !stop.signal.aborted; first += SONG_READ_BATCH) {
      await Promise.all(listed.slice(first, first + SONG_READ_BATCH).map((entry, offset) => runYtdlp(
        ["--skip-download", "--dump-json", "--no-warnings", "--", songUrl(entry.id)],
        { signal: stop.signal },
      ).then(({ stdout: read }) => { songs[first + offset] = readSong(read, entry); }, (error) => {
        logger.warn("ytdlp", "Could not read YouTube Music song", {
          query,
          id: entry.id,
          error: error?.message || String(error),
        });
      })));
      if (stop.signal.aborted || await decided(songs.filter(Boolean))) break;
    }
    return songs.filter(Boolean);
  } finally {
    clearTimeout(deadline);
    stop.abort();
  }
}

async function searchFor(_config = null, query, { limit = SEARCH_LIMIT, songs = false, wanted, decided, timeoutMs = 60000 } = {}) {
  const trimmed = String(query || "").trim();
  if (!trimmed) return [];
  const capped = Math.min(Math.max(Number(limit) || SEARCH_LIMIT, 1), 10);
  if (songs) return searchSongs(trimmed, { limit: capped, wanted, decided });
  const { stdout } = await runYtdlp(
    [
      "--flat-playlist",
      "--dump-json",
      "--no-download",
      "--no-warnings",
      `ytsearch${capped}:${trimmed}`,
    ],
    { timeoutMs },
  );
  return readJsonLines(stdout).flatMap((entry) => {
    const id = String(entry.id || entry.url || "").trim();
    if (!id) return [];
    return [{
      id,
      title: String(entry.title || "").trim(),
      url:
        String(entry.webpage_url || entry.url || "").trim() ||
        `https://www.youtube.com/watch?v=${id}`,
      channel: String(entry.channel || entry.uploader || "").trim(),
      durationSec: readDurationSec(entry.duration),
      liveStatus: String(entry.live_status || "").trim().toLowerCase(),
    }];
  });
}

function resolveStagingDir(config, jobId) {
  return path.join(
    resolveYtdlpStagingRoot(getSettings(config).stagingPath),
    "ytdlp",
    String(jobId || "unknown"),
  );
}

async function findDownloadedAudio(dir) {
  const entries = await fsPromises.readdir(dir).catch(() => []);
  const audioExt = new Set([".m4a", ".mp3", ".opus", ".flac", ".ogg", ".webm", ".wav"]);
  for (const name of entries) {
    const full = path.join(dir, name);
    if (!audioExt.has(path.extname(name).toLowerCase())) continue;
    const stat = await fsPromises.stat(full).catch(() => null);
    if (stat?.isFile() && stat.size > 0) return full;
  }
  return null;
}

async function downloadAudioFor(config = null, videoUrl, { jobId, shouldCancel } = {}) {
  const url = String(videoUrl || "").trim();
  if (!url) throw new Error("Missing yt-dlp download URL");
  const stagingDir = resolveStagingDir(config, jobId);
  await fsPromises.rm(stagingDir, { recursive: true, force: true }).catch(() => {});
  await fsPromises.mkdir(stagingDir, { recursive: true });
  const outTemplate = path.join(stagingDir, "%(id)s.%(ext)s");
  // A YouTube Music song carries its own track and artist tags, and a dash in
  // "Hey Jude - Remastered 2015" is not an "Artist - Title" separator.
  const args = [
    "--no-playlist",
    "--no-warnings",
    "-x",
    "--embed-metadata",
    ...(isSongUrl(url) ? [] : ["--parse-metadata", "title:^(?P<artist>.+?)\\s+[-–—]\\s+(?P<title>.+)$"]),
    "--audio-format",
    AUDIO_FORMAT,
    "--audio-quality",
    "0",
    "-o",
    outTemplate,
    "--",
    url,
  ];
  try {
    try {
      await runYtdlp(args, { timeoutMs: DOWNLOAD_TIMEOUT_MS, cwd: stagingDir, shouldCancel });
    } catch (error) {
      // YouTube often refuses one signed media URL with 403; a new run
      // extracts fresh URLs and usually succeeds.
      if (!/HTTP Error 403/u.test(error?.message || "")) throw error;
      await runYtdlp(args, { timeoutMs: DOWNLOAD_TIMEOUT_MS, cwd: stagingDir, shouldCancel });
    }
  } catch (error) {
    await fsPromises.rm(stagingDir, { recursive: true, force: true }).catch(() => {});
    throw error;
  }
  const filePath = await findDownloadedAudio(stagingDir);
  if (!filePath) {
    await fsPromises.rm(stagingDir, { recursive: true, force: true }).catch(() => {});
    throw new Error("yt-dlp finished without an audio file");
  }
  return { filePath, stagingDir };
}

async function cleanupStagingFor(config = null, jobId) {
  await activeDownloads.get(String(jobId || ""))?.catch(() => {});
  await fsPromises.rm(resolveStagingDir(config, jobId), { recursive: true, force: true }).catch(() => {});
}

export class YtdlpClient {
  constructor(config = null) {
    this.key = "ytdlp";
    this.name = "yt-dlp";
    this._config = config;
  }

  updateConfig(config = null) {
    this._config = config;
  }

  isEnabled() {
    return isEnabledFor(this._config);
  }

  isConfigured() {
    return isConfiguredFor(this._config);
  }

  getStatus() {
    return {
      enabled: this.isEnabled(),
      configured: this.isConfigured(),
    };
  }

  testConnection(options) {
    return testConnectionFor(this._config, options);
  }

  search(query, options) {
    return searchFor(this._config, query, options);
  }

  downloadAudio(videoUrl, options) {
    const download = downloadAudioFor(this._config, videoUrl, options);
    const jobId = String(options?.jobId || "");
    if (jobId) {
      activeDownloads.set(jobId, download);
      const forget = () => {
        if (activeDownloads.get(jobId) === download) activeDownloads.delete(jobId);
      };
      void download.then(forget, forget);
    }
    return download;
  }

  cleanupStaging(jobId) {
    return cleanupStagingFor(this._config, jobId);
  }
}

const defaultYtdlpClient = new YtdlpClient();

export function isYtdlpEnabled() {
  return defaultYtdlpClient.isEnabled();
}

export function isConfigured() {
  return defaultYtdlpClient.isConfigured();
}

export function testConnection(options) {
  return defaultYtdlpClient.testConnection(options);
}

export function search(query, options) {
  return defaultYtdlpClient.search(query, options);
}

export function downloadAudio(videoUrl, options) {
  return defaultYtdlpClient.downloadAudio(videoUrl, options);
}

export function cleanupStaging(jobId) {
  return defaultYtdlpClient.cleanupStaging(jobId);
}

export const ytdlpClient = defaultYtdlpClient;
