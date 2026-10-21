import path from "path";
import fs from "fs/promises";
import { parseFile, type ICommonTagsResult, type IAudioMetadata } from "music-metadata";
import { isVariousArtistsCredit } from "./trackMatching/titleText.ts";
import { logger, safeLogDiagnostic } from "./logger.ts";
import { AURRAL_IDENTITY_TAG, writeAudioTags } from "./audioTags.ts";

const AURRAL_IDENTITY_PREFIX = `${AURRAL_IDENTITY_TAG}=`;

export type DownloadTrackFields = {
  artistName?: string | null;
  trackName?: string | null;
  albumName?: string | null;
  artistMbid?: string | null;
  albumMbid?: string | null;
  releaseMbid?: string | null;
  trackMbid?: string | null;
  recordingMbidAliases?: string[] | null;
  releaseYear?: string | number | null;
  durationMs?: number | null;
  trackNumber?: number | null;
  discNumber?: number | null;
  albumTrackCount?: number | null;
  albumTrackTitles?: string[] | null;
  artistAliases?: string[] | null;
  manualReplacementSearch?: boolean;
};

export type AurralIdentity = { artistMbid?: string; albumMbid?: string; trackMbid?: string };

export type IdentitySource = {
  native?: IAudioMetadata["native"];
  common?: Partial<ICommonTagsResult>;
};

type BlockedJobFields = {
  remoteFilename?: string | null;
  stagingPath?: string | null;
  downloadSource?: string | null;
  releaseTitle?: string | null;
};

export function sanitizePathPart(value: unknown, fallback = "Unknown") {
  const text = String(value || "")
    .replace(/[<>:"/\\|?*]/g, "_")
    .trim();
  return text || fallback;
}

// "07 - Title.flac" when the album position is known, or "2-07 - Title.flac"
// past the first disc, so a folder lists in album order and two tracks with
// one title keep distinct names.
export function buildTrackFileName(job: DownloadTrackFields, ext: string) {
  const title = sanitizePathPart(job?.trackName, "Unknown Track");
  const track = normalizePositiveInteger(job?.trackNumber);
  const disc = normalizePositiveInteger(job?.discNumber);
  const position = track ? `${disc > 1 ? `${disc}-` : ""}${String(track).padStart(2, "0")} - ` : "";
  return `${position}${title}${ext}`;
}

export function normalizePositiveInteger(value: unknown) {
  if (value == null || !Number.isFinite(Number(value))) return null;
  const normalized = Math.floor(Number(value));
  return normalized > 0 ? normalized : null;
}

export function normalizeStringList(value: unknown) {
  return Array.isArray(value)
    ? value.map((entry) => String(entry || "").trim()).filter(Boolean)
    : [];
}

export function parseStringListJson(value: string | null | undefined) {
  if (!value) return [];
  try {
    return normalizeStringList(JSON.parse(value));
  } catch {
    return [];
  }
}

export function stringifyStringListJson(value: unknown) {
  const normalized = normalizeStringList(value);
  return normalized.length > 0 ? JSON.stringify(normalized) : null;
}

export function buildAurralIdentity(metadata: DownloadTrackFields = {}) {
  const identity = Object.fromEntries(
    (["artistMbid", "albumMbid", "trackMbid"] as const)
      .map((key) => [key, String(metadata?.[key] || "").trim()])
      .filter(([, value]) => value),
  );
  return Object.keys(identity).length > 0 ? identity : null;
}

export function parseAurralIdentityComment(value: unknown) {
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

const nativeTags = (metadata: IdentitySource) =>
  Object.values(metadata?.native || {}).flatMap((tags) => (Array.isArray(tags) ? tags : []));

// Older versions kept the marker in the comment, then the grouping tag.
export function readLegacyAurralIdentity(metadata: IdentitySource) {
  const nativeComments = nativeTags(metadata)
    .filter((tag) => ["txxx:comment", "comm"].includes(String(tag?.id || "").toLowerCase()))
    .map((tag) => tag.value);
  const found = [
    parseAurralIdentityComment(nativeComments),
    parseAurralIdentityComment(metadata?.common?.comment),
    parseAurralIdentityComment(metadata?.common?.grouping),
  ].filter(Boolean);
  return found.length ? Object.assign({}, ...found) : null;
}

const OWN_IDENTITY_TAG = new RegExp(`(^|:)${AURRAL_IDENTITY_TAG}$`, "i");

export function readAurralIdentity(metadata: IdentitySource): AurralIdentity | null {
  const tag = nativeTags(metadata).find((entry) => OWN_IDENTITY_TAG.test(String(entry?.id || "")));
  let own = null;
  try {
    const parsed = JSON.parse(String(tag?.value ?? ""));
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) own = parsed;
  } catch {}
  const legacy = readLegacyAurralIdentity(metadata);
  return own || legacy ? { ...(legacy || {}), ...(own || {}) } : null;
}

export function buildResolvedJobTrack(
  job: DownloadTrackFields,
  payloadTrack: DownloadTrackFields = {},
) {
  const track: DownloadTrackFields =
    payloadTrack && typeof payloadTrack === "object" ? payloadTrack : {};
  return {
    artistName: job.artistName || track.artistName,
    trackName: job.trackName || track.trackName,
    albumName: job.albumName || track.albumName,
    artistMbid: job.artistMbid || track.artistMbid,
    albumMbid: job.albumMbid || track.albumMbid,
    releaseMbid: job.releaseMbid || track.releaseMbid || null,
    trackMbid: job.trackMbid || track.trackMbid,
    recordingMbidAliases: normalizeStringList(
      (job.recordingMbidAliases?.length ? job.recordingMbidAliases : null) ||
        track.recordingMbidAliases,
    ),
    releaseYear: job.releaseYear || track.releaseYear,
    durationMs: job.durationMs ?? track.durationMs ?? null,
    trackNumber: normalizePositiveInteger(job.trackNumber ?? track.trackNumber),
    discNumber: normalizePositiveInteger(job.discNumber ?? track.discNumber),
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

// A Usenet job's remote name is the whole release, so the held file is the
// only name that identifies the track waiting for review.
export function resolveBlockedJobSourceFilename(job: BlockedJobFields) {
  const remote = String(job?.remoteFilename || "").trim() || null;
  const staging = String(job?.stagingPath || "").trim();
  const staged = staging ? path.basename(staging) || null : null;
  return job?.downloadSource === "usenet" ? staged || remote : remote || staged;
}

export function resolveBlockedJobReleaseTitle(job: BlockedJobFields) {
  if (job?.downloadSource !== "usenet") return null;
  return String(job?.releaseTitle || "").trim() || null;
}

export function joinUnderRoot(root: string, relativePath: unknown, fileName: string | null = null) {
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

async function fileExists(filePath: string) {
  try {
    await fs.access(filePath);
    return true;
  } catch {
    return false;
  }
}

async function resolveAvailableTargetPath(targetPath: string) {
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
  sourcePath: string,
  targetPath: string,
  {
    reuseExisting = false,
    preserveSource = false,
  }: { reuseExisting?: boolean; preserveSource?: boolean } = {},
) {
  await fs.mkdir(path.dirname(targetPath), { recursive: true });
  if (path.resolve(sourcePath) === path.resolve(targetPath)) {
    return targetPath;
  }
  if (reuseExisting) {
    const existing = await fs.stat(targetPath).catch(() => null);
    if (existing?.isFile()) {
      if (!preserveSource) await fs.rm(sourcePath, { force: true });
      return targetPath;
    }
  }
  const resolvedTarget = await resolveAvailableTargetPath(targetPath);
  if (preserveSource) {
    const tempTarget = path.join(
      path.dirname(resolvedTarget),
      `.aurral-import-${process.pid}-${Date.now()}-${path.basename(resolvedTarget)}.tmp`,
    );
    try {
      await fs.copyFile(sourcePath, tempTarget);
      const [sourceStat, tempStat] = await Promise.all([fs.stat(sourcePath), fs.stat(tempTarget)]);
      if (sourceStat.size !== tempStat.size) {
        throw new Error("Imported file copy did not match source size");
      }
      await fs.rename(tempTarget, resolvedTarget);
    } finally {
      await fs.rm(tempTarget, { force: true }).catch(() => {});
    }
    return resolvedTarget;
  }
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

// Tags a file that is already at its final location. Tagging writes a copy of
// the file, so doing it after the import keeps that I/O on the library disk rather
// than in the download client's folder, which may be a slow network mount. By
// then the download is in place and its source is gone, so a failure is logged
// instead of failing the job, which could not be retried anyway.
export async function writeImportedFileMetadata(
  filePath: string,
  metadata: DownloadTrackFields = {},
  { source = "download", jobId = null }: { source?: string; jobId?: string | number | null } = {},
) {
  try {
    await writeAudioMetadata(filePath, metadata);
  } catch (error) {
    logger.warn(source, "Failed to write audio metadata after import", {
      jobId,
      filePath,
      reason: safeLogDiagnostic(error),
    });
  }
}

// A compilation's tracks keep their own performer as the artist. The download
// job knows which track it fetched, so its identity replaces the uploader's.
export async function writeAudioMetadata(filePath: string, metadata: DownloadTrackFields = {}) {
  const performer = isVariousArtistsCredit(metadata.artistName, metadata.artistMbid)
    ? metadata.artistAliases?.[0]
    : null;
  return writeAudioTags(
    filePath,
    {
      title: metadata.trackName,
      artist: performer || metadata.artistName,
      albumArtist: metadata.artistName,
      album: metadata.albumName,
      artistMbid: performer ? undefined : metadata.artistMbid,
      albumArtistMbid: metadata.artistMbid,
      releaseGroupMbid: metadata.albumMbid,
      recordingMbid: metadata.trackMbid,
      year: metadata.releaseYear,
      trackNumber: metadata.trackNumber,
      discNumber: metadata.discNumber,
    },
    { identity: buildAurralIdentity(metadata) },
  );
}

export async function moveIdentityMarkerToOwnTag(
  filePath: string,
  identity: AurralIdentity | null,
) {
  return writeAudioTags(filePath, {}, { identity });
}

type RepairableJob = DownloadTrackFields & {
  status?: string | null;
  downloadClient?: string | null;
  finalPath?: string | null;
  externalPath?: string | null;
};

export async function repairYtdlpMetadata(jobs: RepairableJob[] = []) {
  const result = { scanned: 0, repaired: 0, failed: 0 };
  const seen = new Set<string>();
  for (const job of jobs) {
    if (
      job?.status !== "done" ||
      job?.downloadClient !== "ytdlp" ||
      job?.externalPath ||
      path.extname(job?.finalPath || "").toLowerCase() !== ".m4a"
    ) {
      continue;
    }
    const filePath = path.resolve(job.finalPath!);
    if (seen.has(filePath)) continue;
    seen.add(filePath);
    result.scanned += 1;
    try {
      const metadata = await parseFile(filePath, { skipCovers: true });
      const { common } = metadata;
      const expected = [
        [common.title, job.trackName],
        [common.artist, job.artistName],
        [common.albumartist, job.artistName],
        [common.album, job.albumName],
      ].filter(([, value]) => String(value || "").trim());
      const embeddedIdentity = readAurralIdentity(metadata) || {};
      const expectedIdentity = [
        [
          common.musicbrainz_albumartistid ||
            common.musicbrainz_artistid ||
            embeddedIdentity.artistMbid,
          job.artistMbid,
        ],
        [
          common.musicbrainz_releasegroupid ||
            common.musicbrainz_albumid ||
            embeddedIdentity.albumMbid,
          job.albumMbid,
        ],
        [
          common.musicbrainz_recordingid ||
            common.musicbrainz_trackid ||
            embeddedIdentity.trackMbid,
          job.trackMbid,
        ],
      ].filter(([, value]) => String(value || "").trim());
      if (
        expected.every(([actual, value]) => String(actual || "").trim() === String(value).trim()) &&
        expectedIdentity.every(
          ([actual, value]) => String(actual || "").trim() === String(value).trim(),
        )
      ) {
        continue;
      }
      await writeAudioMetadata(filePath, job);
      result.repaired += 1;
    } catch {
      result.failed += 1;
    }
  }
  return result;
}
