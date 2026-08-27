import { spawn } from "child_process";
import fs from "fs";
import fsPromises from "fs/promises";
import path from "path";
import { dbOps } from "../db/helpers/index.js";
import { resolveYtdlpStagingRoot } from "./downloadFolderConfig.js";

const DEFAULT_BINARY = "yt-dlp";
const SEARCH_LIMIT = 5;
const DOWNLOAD_TIMEOUT_MS = 10 * 60 * 1000;
const AUDIO_FORMAT = "m4a";

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

function isConfiguredFor(config = null) {
  return isEnabledFor(config) && resolveBinaryExists(getBinaryPath());
}

function runYtdlp(args, { timeoutMs = 120000, cwd } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(getBinaryPath(), args, {
      cwd,
      env: process.env,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      reject(new Error(`yt-dlp timed out after ${timeoutMs}ms`));
    }, timeoutMs);
    child.stdout.on("data", (chunk) => {
      stdout += chunk.toString();
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk.toString();
    });
    child.on("error", (error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.on("close", (code) => {
      clearTimeout(timer);
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

async function searchFor(_config = null, query, { limit = SEARCH_LIMIT } = {}) {
  const trimmed = String(query || "").trim();
  if (!trimmed) return [];
  const capped = Math.min(Math.max(Number(limit) || SEARCH_LIMIT, 1), 10);
  const { stdout } = await runYtdlp(
    [
      "--flat-playlist",
      "--dump-json",
      "--no-download",
      "--no-warnings",
      `ytsearch${capped}:${trimmed}`,
    ],
    { timeoutMs: 60000 },
  );
  const results = [];
  for (const line of String(stdout || "").split("\n")) {
    const raw = line.trim();
    if (!raw) continue;
    try {
      const entry = JSON.parse(raw);
      const id = String(entry.id || entry.url || "").trim();
      if (!id) continue;
      results.push({
        id,
        title: String(entry.title || "").trim(),
        url:
          String(entry.webpage_url || entry.url || "").trim() ||
          `https://www.youtube.com/watch?v=${id}`,
        channel: String(entry.channel || entry.uploader || "").trim(),
        durationSec:
          Number.isFinite(Number(entry.duration)) && Number(entry.duration) > 0
            ? Number(entry.duration)
            : null,
        liveStatus: String(entry.live_status || "").trim().toLowerCase(),
      });
    } catch {
    }
  }
  return results;
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

async function downloadAudioFor(config = null, videoUrl, { jobId } = {}) {
  const url = String(videoUrl || "").trim();
  if (!url) throw new Error("Missing yt-dlp download URL");
  const stagingDir = resolveStagingDir(config, jobId);
  await fsPromises.rm(stagingDir, { recursive: true, force: true }).catch(() => {});
  await fsPromises.mkdir(stagingDir, { recursive: true });
  const outTemplate = path.join(stagingDir, "%(id)s.%(ext)s");
  try {
    await runYtdlp(
      [
        "--no-playlist",
        "--no-warnings",
        "-x",
        "--audio-format",
        AUDIO_FORMAT,
        "--audio-quality",
        "0",
        "-o",
        outTemplate,
        "--",
        url,
      ],
      { timeoutMs: DOWNLOAD_TIMEOUT_MS, cwd: stagingDir },
    );
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
    return downloadAudioFor(this._config, videoUrl, options);
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
