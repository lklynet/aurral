import { execFile } from "child_process";
import { promisify } from "util";
import path from "path";
import fs from "fs/promises";

const execFileAsync = promisify(execFile);
const AURRAL_IDENTITY_PREFIX = "AURRAL_IDS=";

export function sanitizePathPart(value, fallback = "Unknown") {
  const text = String(value || "")
    .replace(/[<>:"/\\|?*]/g, "_")
    .trim();
  return text || fallback;
}

export function normalizePositiveInteger(value) {
  if (value == null || !Number.isFinite(Number(value))) return null;
  const normalized = Math.floor(Number(value));
  return normalized > 0 ? normalized : null;
}

export function normalizeStringList(value) {
  return Array.isArray(value)
    ? value.map((entry) => String(entry || "").trim()).filter(Boolean)
    : [];
}

export function parseStringListJson(value) {
  if (!value) return [];
  try {
    return normalizeStringList(JSON.parse(value));
  } catch {
    return [];
  }
}

export function stringifyStringListJson(value) {
  const normalized = normalizeStringList(value);
  return normalized.length > 0 ? JSON.stringify(normalized) : null;
}

export function buildAurralIdentityMarker(metadata = {}) {
  const identity = Object.fromEntries(
    ["artistMbid", "albumMbid", "trackMbid"]
      .map((key) => [key, String(metadata?.[key] || "").trim()])
      .filter(([, value]) => value),
  );
  return Object.keys(identity).length > 0
    ? `${AURRAL_IDENTITY_PREFIX}${JSON.stringify(identity)}`
    : null;
}

export function parseAurralIdentityMarker(value) {
  const comments = Array.isArray(value) ? value : [value];
  for (const entry of comments) {
    const text = String(typeof entry === "object" ? entry?.text || "" : entry || "").trim();
    if (!text.startsWith(AURRAL_IDENTITY_PREFIX)) continue;
    try {
      const parsed = JSON.parse(text.slice(AURRAL_IDENTITY_PREFIX.length));
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) return parsed;
    } catch {}
  }
  return null;
}

export function buildResolvedJobTrack(job, payloadTrack = {}) {
  const track = payloadTrack && typeof payloadTrack === "object" ? payloadTrack : {};
  return {
    artistName: job.artistName || track.artistName,
    trackName: job.trackName || track.trackName,
    albumName: job.albumName || track.albumName,
    artistMbid: job.artistMbid || track.artistMbid,
    albumMbid: job.albumMbid || track.albumMbid,
    trackMbid: job.trackMbid || track.trackMbid,
    releaseYear: job.releaseYear || track.releaseYear,
    durationMs: job.durationMs ?? track.durationMs ?? null,
    trackNumber: normalizePositiveInteger(job.trackNumber ?? track.trackNumber),
    albumTrackCount: normalizePositiveInteger(job.albumTrackCount ?? track.albumTrackCount),
    albumTrackTitles: normalizeStringList(
      (job.albumTrackTitles?.length ? job.albumTrackTitles : null) || track.albumTrackTitles,
    ),
    artistAliases:
      Array.isArray(job.artistAliases) && job.artistAliases.length
        ? job.artistAliases
        : normalizeStringList(track.artistAliases),
    manualReplacementSearch: job.manualReplacementSearch === true,
  };
}

export function resolveBlockedJobSourceFilename(job) {
  const remote = String(job?.remoteFilename || "").trim();
  if (remote) return remote;
  const staging = String(job?.stagingPath || "").trim();
  if (!staging) return null;
  return path.basename(staging) || null;
}

export function joinUnderRoot(root, relativePath, fileName = null) {
  const parts = String(relativePath || "")
    .replace(/\\/g, "/")
    .split("/")
    .filter(Boolean);
  if (fileName) {
    parts.push(fileName);
  }
  const resolvedRoot = path.resolve(root);
  const resolvedPath = path.resolve(resolvedRoot, ...parts);
  const relative = path.relative(resolvedRoot, resolvedPath);
  if (relative.startsWith("..") || path.isAbsolute(relative)) {
    throw new Error("Destination must remain inside the configured root");
  }
  return resolvedPath;
}

async function fileExists(filePath) {
  try {
    await fs.access(filePath);
    return true;
  } catch {
    return false;
  }
}

async function resolveAvailableTargetPath(targetPath) {
  if (!(await fileExists(targetPath))) return targetPath;
  const dir = path.dirname(targetPath);
  const ext = path.extname(targetPath);
  const base = path.basename(targetPath, ext);
  for (let index = 2; index < 1000; index += 1) {
    const candidate = path.join(dir, `${base} (${index})${ext}`);
    if (!(await fileExists(candidate))) return candidate;
  }
  return path.join(dir, `${base} (${Date.now()})${ext}`);
}

export async function commitDownloadedFile(
  sourcePath,
  targetPath,
  { reuseExisting = false } = {},
) {
  await fs.mkdir(path.dirname(targetPath), { recursive: true });
  if (path.resolve(sourcePath) === path.resolve(targetPath)) {
    return targetPath;
  }
  if (reuseExisting) {
    const existing = await fs.stat(targetPath).catch(() => null);
    if (existing?.isFile()) {
      await fs.rm(sourcePath, { force: true });
      return targetPath;
    }
  }
  const resolvedTarget = await resolveAvailableTargetPath(targetPath);
  try {
    await fs.rename(sourcePath, resolvedTarget);
  } catch (error) {
    if (error?.code !== "EXDEV") throw error;
    const tempTarget = path.join(
      path.dirname(resolvedTarget),
      `.aurral-import-${process.pid}-${Date.now()}-${path.basename(resolvedTarget)}.tmp`,
    );
    await fs.copyFile(sourcePath, tempTarget);
    const [sourceStat, tempStat] = await Promise.all([fs.stat(sourcePath), fs.stat(tempTarget)]);
    if (sourceStat.size !== tempStat.size) {
      await fs.rm(tempTarget, { force: true }).catch(() => {});
      throw new Error("Imported file copy did not match source size");
    }
    await fs.rename(tempTarget, resolvedTarget);
    await fs.rm(sourcePath, { force: true });
  }
  return resolvedTarget;
}

async function rewriteAudioTags(filePath, tags) {
  const sourcePath = path.resolve(filePath);
  const ext = path.extname(sourcePath) || ".m4a";
  const taggedPath = path.join(
    path.dirname(sourcePath),
    `.${path.basename(sourcePath, ext)}.${process.pid}-${Date.now()}.tagged${ext}`,
  );
  const args = [
    "-hide_banner",
    "-loglevel",
    "error",
    "-nostdin",
    "-y",
    "-i",
    sourcePath,
    "-map",
    "0",
    "-c",
    "copy",
  ];
  for (const [key, value] of tags) {
    args.push("-metadata", `${key}=${value}`);
  }
  args.push(taggedPath);
  try {
    await execFileAsync("ffmpeg", args, { timeout: 120000 });
    await fs.rename(taggedPath, sourcePath);
    return sourcePath;
  } catch (error) {
    await fs.rm(taggedPath, { force: true }).catch(() => {});
    const detail = String(error?.stderr || error?.message || error).trim().slice(-500);
    throw new Error(`Failed to write audio metadata: ${detail}`);
  }
}

export async function writeAudioMetadata(filePath, metadata = {}) {
  const tags = [
    ["title", metadata.trackName],
    ["artist", metadata.artistName],
    ["album_artist", metadata.artistName],
    ["album", metadata.albumName],
    ["musicbrainz_artistid", metadata.artistMbid],
    ["musicbrainz_albumartistid", metadata.artistMbid],
    ["musicbrainz_albumid", metadata.albumMbid],
    ["musicbrainz_releasegroupid", metadata.albumMbid],
    ["musicbrainz_recordingid", metadata.trackMbid],
    ["musicbrainz_trackid", metadata.trackMbid],
    ["grouping", buildAurralIdentityMarker(metadata)],
    ["date", metadata.releaseYear],
    ["track", normalizePositiveInteger(metadata.trackNumber)],
  ]
    .filter(([, value]) => value != null && String(value).trim())
    .map(([key, value]) => [key, String(value).trim()]);
  return rewriteAudioTags(filePath, tags);
}

