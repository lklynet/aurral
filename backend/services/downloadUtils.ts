import path from "path";
import * as v from "valibot";
import fs from "fs/promises";
import type { ICommonTagsResult, IAudioMetadata } from "music-metadata";
import { isVariousArtistsCredit } from "./trackMatching/titleText.ts";
import { asAppError } from "../../lib/errors.ts";
import { logger, safeLogDiagnostic } from "./logger.ts";
import { AURRAL_IDENTITY_TAG, writeAudioTags } from "./audioTags.ts";
import { getAlbumByMbid } from "./providers/brainzmashProvider.ts";
import { isNzbSource } from "./usenetClientCommon.ts";
import { musicbrainzGetReleaseTrackCredits } from "./apiClients/musicbrainz.ts";
import { formatArtistCredit } from "../../lib/artistCredit.ts";

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

const aurralIdentitySchema = v.object({
  artistMbid: v.optional(v.string()),
  albumMbid: v.optional(v.string()),
  trackMbid: v.optional(v.string()),
});

export type AurralIdentity = v.InferOutput<typeof aurralIdentitySchema>;

const parseIdentity = (text: string) => {
  try {
    const parsed = v.safeParse(aurralIdentitySchema, JSON.parse(text));
    return parsed.success ? parsed.output : null;
  } catch {
    return null;
  }
};

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

// A leading dot hides a file or folder from most scanners, and SMB and NTFS
// reject a name ending in a dot, so names never start or end with one.
export function sanitizePathPart(value: unknown, fallback = "Unknown") {
  const text = String(value || "")
    .replace(/[<>:"/\\|?*]/g, "_")
    .replace(/^[\s.]+|[\s.]+$/g, "");
  return text || fallback;
}

// "07 - Title.flac" when the album position is known, or "2-07 - Title.flac"
// past the first disc, so a folder lists in album order and two tracks with
// one title keep distinct names.
export function buildTrackFileName(job: DownloadTrackFields, ext: string) {
  const title = sanitizePathPart(job?.trackName, "Unknown Track");
  const track = normalizePositiveInteger(job?.trackNumber);
  const disc = normalizePositiveInteger(job?.discNumber);
  const position = track
    ? `${disc !== null && disc > 1 ? `${disc}-` : ""}${String(track).padStart(2, "0")} - `
    : "";
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
  const identity: AurralIdentity = {};
  for (const key of ["artistMbid", "albumMbid", "trackMbid"] as const) {
    const value = String(metadata?.[key] || "").trim();
    if (value) identity[key] = value;
  }
  return Object.keys(identity).length > 0 ? identity : null;
}

const commentText = (entry: unknown) =>
  String(
    entry && typeof entry === "object" ? ("text" in entry && entry.text) || "" : entry || "",
  ).trim();

function parseAurralIdentityComment(value: unknown) {
  for (const entry of Array.isArray(value) ? value : [value]) {
    const text = commentText(entry);
    if (!text.startsWith(AURRAL_IDENTITY_PREFIX)) continue;
    const identity = parseIdentity(text.slice(AURRAL_IDENTITY_PREFIX.length));
    if (identity) return identity;
  }
  return null;
}

const nativeTags = (metadata: IdentitySource) =>
  Object.values(metadata?.native || {}).flatMap((tags) => (Array.isArray(tags) ? tags : []));

// Older versions kept the marker in the comment, then the grouping tag.
function readLegacyAurralIdentity(metadata: IdentitySource) {
  const nativeComments: unknown[] = nativeTags(metadata)
    .filter((tag) => ["txxx:comment", "comm"].includes(String(tag?.id || "").toLowerCase()))
    .map((tag) => tag.value);
  const found = [
    parseAurralIdentityComment(nativeComments),
    parseAurralIdentityComment(metadata?.common?.comment),
    parseAurralIdentityComment(metadata?.common?.grouping),
  ].filter((identity) => identity !== null);
  return found.length ? found.reduce((merged, identity) => ({ ...merged, ...identity })) : null;
}

const OWN_IDENTITY_TAG = new RegExp(`(^|:)${AURRAL_IDENTITY_TAG}$`, "i");

export function readAurralIdentity(metadata: IdentitySource): AurralIdentity | null {
  const tag = nativeTags(metadata).find((entry) => OWN_IDENTITY_TAG.test(String(entry?.id || "")));
  const own = parseIdentity(String(tag?.value ?? ""));
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
  return isNzbSource(job?.downloadSource) ? staged || remote : remote || staged;
}

export function resolveBlockedJobReleaseTitle(job: BlockedJobFields) {
  if (!isNzbSource(job?.downloadSource)) return null;
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
    const failure = asAppError(error);
    if (failure?.code !== "EXDEV") throw error;
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

const albumInfo = async (albumMbid: string | null | undefined) =>
  albumMbid ? getAlbumByMbid(albumMbid).catch(() => null) : null;

async function trackCredit({ releaseMbid, trackMbid, recordingMbidAliases }: DownloadTrackFields) {
  if (!releaseMbid || !trackMbid) return null;
  const credits = await musicbrainzGetReleaseTrackCredits(releaseMbid);
  for (const mbid of [trackMbid, ...(recordingMbidAliases ?? [])]) {
    const credit = credits.get(mbid);
    if (credit) return credit;
  }
  return null;
}

// A compilation's tracks keep their own performer as the artist. The download
// job knows which track it fetched, so its identity replaces the uploader's.
export async function writeAudioMetadata(filePath: string, metadata: DownloadTrackFields = {}) {
  const [credit, album] = await Promise.all([trackCredit(metadata), albumInfo(metadata.albumMbid)]);
  const performer = isVariousArtistsCredit(metadata.artistName, metadata.artistMbid)
    ? metadata.artistAliases?.[0]
    : null;
  const albumArtists = Array.isArray(album?.artists) ? album.artists : [];
  const mainArtist =
    albumArtists.find((entry) => entry.id === album?.artistId) || albumArtists[0] || null;
  const albumArtist = mainArtist?.name || metadata.artistName;
  const albumArtistMbid = mainArtist?.id || metadata.artistMbid;
  return writeAudioTags(
    filePath,
    {
      title: metadata.trackName,
      artist: credit ? formatArtistCredit(credit) : performer || metadata.artistName,
      artists: credit?.map((entry) => entry.name),
      albumArtist,
      album: metadata.albumName,
      artistMbid: credit
        ? credit.flatMap((entry) => (entry.mbid ? [entry.mbid] : []))
        : performer
          ? undefined
          : metadata.artistMbid,
      albumArtistMbid,
      releaseGroupMbid: metadata.albumMbid,
      releaseMbid: metadata.releaseMbid,
      recordingMbid: metadata.trackMbid,
      year: metadata.releaseYear,
      trackNumber: metadata.trackNumber,
      discNumber: metadata.discNumber,
      genres: album?.genres.slice(0, 5),
    },
    { identity: buildAurralIdentity(metadata) },
  );
}
