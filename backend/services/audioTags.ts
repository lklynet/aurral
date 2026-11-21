import {
  parseFile,
  updateFile,
  type TagPatch,
  UnsupportedFileTypeError,
  UnsupportedFeatureError,
  UnsupportedFormatError,
  CouldNotDetermineFileTypeError,
  type IAudioMetadata,
} from "music-metadata/node";
import { closeSync, fstatSync, openSync, readSync } from "node:fs";
import path from "node:path";
import { isDeepStrictEqual } from "node:util";
export const AURRAL_IDENTITY_TAG = "AURRAL_IDS";
const AURRAL_IDENTITY_PREFIX = `${AURRAL_IDENTITY_TAG}=`;
type TagFieldValue = string | number | string[] | null | undefined;

const text = (value: unknown) => (value == null ? "" : String(value).trim());
const first = (values: unknown) => text(Array.isArray(values) ? values[0] : values);
const positive = (value: unknown) => {
  const number = Number(value);
  return Number.isSafeInteger(number) && number > 0 ? number : 0;
};
const list = (value: unknown) =>
  (Array.isArray(value) ? value : text(value) ? [value] : [])
    .flatMap((entry) => String(entry).split(";"))
    .map(text)
    .filter(Boolean);
const texts = (value: unknown) =>
  (Array.isArray(value) ? value : [value]).map(text).filter(Boolean);

const FIELDS = {
  title: "title",
  artist: "artist",
  artists: "artists",
  albumArtist: "albumArtist",
  album: "album",
  year: "year",
  trackNumber: "trackNumber",
  discNumber: "discNumber",
  genres: "genres",
  artistMbid: "mbArtistId",
  albumArtistMbid: "mbAlbumArtistId",
  releaseGroupMbid: "mbReleaseGroupId",
  releaseMbid: "mbReleaseId",
  recordingMbid: "mbRecordingId",
} as const;
type AudioTagField = keyof typeof FIELDS;
export const AUDIO_TAG_FIELDS = Object.keys(FIELDS) as AudioTagField[];

const isAudioTagField = (field: string): field is AudioTagField =>
  AUDIO_TAG_FIELDS.some((candidate) => candidate === field);

export class UnsupportedTagFormatError extends Error {
  declare code: string;

  constructor(filePath: string, kind = "", cause?: Error) {
    const format = kind + (path.extname(filePath) || "this kind of");
    super(`Aurral cannot write tags to ${format} files${cause ? `: ${cause.message}` : ""}`, {
      cause,
    });
    this.code = "TAGS_UNSUPPORTED";
  }
}

function isFragmentedMp4(filePath: string) {
  const fd = openSync(filePath, "r");
  try {
    const size = fstatSync(fd).size;
    const header = Buffer.alloc(16);
    for (let offset = 0; offset + 8 <= size;) {
      readSync(fd, header, 0, 16, offset);
      const type = header.toString("latin1", 4, 8);
      if (offset === 0 && type !== "ftyp") return false;
      if (type === "moof") return true;
      const boxSize = header.readUInt32BE(0);
      const length =
        boxSize === 1 ? Number(header.readBigUInt64BE(8)) : boxSize === 0 ? size - offset : boxSize;
      if (length < 8) return false;
      offset += length;
    }
    return false;
  } finally {
    closeSync(fd);
  }
}

async function readMetadata(filePath: string) {
  if (isFragmentedMp4(filePath)) throw new UnsupportedTagFormatError(filePath, "fragmented ");
  try {
    return await parseFile(filePath, { skipCovers: true });
  } catch (error) {
    if (
      error instanceof UnsupportedFileTypeError ||
      error instanceof CouldNotDetermineFileTypeError
    )
      throw new UnsupportedTagFormatError(filePath);
    throw error;
  }
}
function normalize(field: AudioTagField, value: unknown) {
  switch (field) {
    case "trackNumber":
    case "discNumber":
    case "year":
      return positive(value);
    case "genres":
      return list(value);
    case "artists":
    case "artistMbid":
      return texts(value);
    default:
      return text(value);
  }
}
const isEmpty = (value: unknown) => (Array.isArray(value) ? value.length === 0 : !value);
const same = (left: unknown, right: unknown) => JSON.stringify(left) === JSON.stringify(right);

function readFields(metadata: IAudioMetadata) {
  const c = metadata.common;
  return {
    title: first(c.title),
    artist: first(c.artist),
    artists: texts(c.artists),
    albumArtist: first(c.albumArtist),
    album: first(c.album),
    year: positive(c.year),
    trackNumber: positive(c.trackNumber),
    discNumber: positive(c.discNumber),
    genres: list(c.genres),
    artistMbid: texts(c.mbArtistId),
    albumArtistMbid: first(c.mbAlbumArtistId),
    releaseGroupMbid: first(c.mbReleaseGroupId),
    releaseMbid: first(c.mbReleaseId),
    recordingMbid: first(c.mbRecordingId),
  };
}
function parseIdentity(value: unknown) {
  const raw = text(value);
  if (!raw) return null;
  try {
    const parsed: unknown = JSON.parse(
      raw.startsWith(AURRAL_IDENTITY_PREFIX) ? raw.slice(AURRAL_IDENTITY_PREFIX.length) : raw,
    );
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

function readIdentity(metadata: IAudioMetadata) {
  for (const tags of Object.values(metadata.native)) {
    for (const tag of tags) {
      if (tag.id.split(":").at(-1)?.toUpperCase() === AURRAL_IDENTITY_TAG)
        return parseIdentity(tag.value);
    }
  }
  return null;
}
// Changes only the fields Aurral has a value for. The exception is the release
// pair: uploaders name different releases, and media servers split an album by
// them. Files placed under an album carry its release and release group or none.
function planChanges(
  current: Record<string, TagFieldValue>,
  values: Record<string, TagFieldValue>,
  fillOnly: boolean,
) {
  const changes: Record<string, TagFieldValue> = {};
  for (const field of AUDIO_TAG_FIELDS) {
    if (values[field] == null) continue;
    const wanted = normalize(field, values[field]);
    if (isEmpty(wanted) || same(wanted, current[field])) continue;
    // Aurral can represent a solo credit without writing a redundant artist list.
    if (
      field === "artists" &&
      isEmpty(current.artists) &&
      same(wanted, [text(values.artist) || current.artist])
    )
      continue;
    if (fillOnly && !isEmpty(current[field])) continue;
    changes[field] = wanted;
  }
  if (!fillOnly && values.releaseGroupMbid && current.releaseMbid && !values.releaseMbid) {
    changes.releaseMbid = null;
  }
  if (!fillOnly && values.releaseMbid && current.releaseGroupMbid && !values.releaseGroupMbid) {
    changes.releaseGroupMbid = null;
  }
  return changes;
}

async function updateTags(
  filePath: string,
  metadata: IAudioMetadata,
  patch: TagPatch,
  dryRun = false,
) {
  try {
    if (metadata.native["ID3v2.3"]) {
      // Replacement needs the full common model, including artwork skipped during planning.
      // Unmapped/private frames are not represented by this conversion.
      const full = await parseFile(filePath);
      const identity = readIdentity(full);
      const native = { ...patch.native };
      const identityKey = `TXXX:${AURRAL_IDENTITY_TAG}`;
      if (identity && !Object.hasOwn(native, identityKey))
        native[identityKey] = JSON.stringify(identity);
      await updateFile(
        filePath,
        { ...full.common, ...patch, native },
        { replaceId3: true, dryRun },
      );
    } else {
      await updateFile(filePath, patch, { dryRun });
    }
  } catch (error) {
    if (error instanceof UnsupportedFormatError || error instanceof UnsupportedFeatureError)
      throw new UnsupportedTagFormatError(filePath, "", error);
    throw error;
  }
}

export async function readAudioTags(filePath: string) {
  const metadata = await readMetadata(filePath);
  // Parsing supports more formats and tag variants than the writer can edit.
  await updateTags(filePath, metadata, {}, true);
  return { ...readFields(metadata), identity: readIdentity(metadata) };
}
export async function writeAudioTags(
  filePath: string,
  values: Record<string, TagFieldValue> = {},
  { fillOnly = false, identity = null }: { fillOnly?: boolean; identity?: object | null } = {},
) {
  const metadata = await readMetadata(filePath);
  const current = readFields(metadata);
  const changes = planChanges(current, values, fillOnly);
  const changed = Object.keys(changes).filter(isAudioTagField);
  const patch: TagPatch = {};
  for (const field of changed) {
    const value = changes[field];
    if (field === "trackNumber" || field === "discNumber") patch[FIELDS[field]] = positive(value);
    else if (field === "year") patch.date = String(value);
    else if (field === "artists" || field === "artistMbid" || field === "genres")
      patch[FIELDS[field]] = texts(value);
    else patch[FIELDS[field]] = value === null ? null : text(value);
  }
  if (identity) {
    const container = metadata.format.container || "";
    const isMp4 =
      !container.startsWith("ADTS/") &&
      (/MPEG-4|M4A|isom|mp4/i.test(container) || metadata.native.iTunes);
    const prefix = isMp4
      ? "----:com.apple.iTunes:"
      : /MPEG|WAVE|ADTS/i.test(container)
        ? "TXXX:"
        : "";
    const native: Record<string, string | string[] | null> = {};
    const marker = (value: unknown) => text(value).startsWith(AURRAL_IDENTITY_PREFIX);

    const serialized = JSON.stringify(identity);
    if (!isDeepStrictEqual(JSON.parse(serialized), readIdentity(metadata)))
      native[prefix + AURRAL_IDENTITY_TAG] = serialized;
    if (marker(metadata.common.grouping)) patch.grouping = null;
    // Vorbis combines COMMENT and DESCRIPTION in the common model. Edit each native field in place.
    if (!metadata.native.vorbis && metadata.common.comments?.some((c) => marker(c.text)))
      patch.comments = metadata.common.comments.filter((c) => !marker(c.text));
    for (const [type, tags] of Object.entries(metadata.native)) {
      const fields =
        type === "vorbis" ? ["COMMENT", "DESCRIPTION"] : ["DESCRIPTION", "TXXX:comment"];
      for (const id of fields) {
        const matching = tags.filter((t) => t.id.toUpperCase() === id.toUpperCase());
        if (matching.some((t) => marker(t.value)))
          native[matching[0]!.id] = matching
            .filter((t) => !marker(t.value))
            .map((t) => String(t.value));
      }
    }
    if (Object.keys(native).length) patch.native = native;
  }
  if (Object.keys(patch).length) await updateTags(filePath, metadata, patch);
  return changed;
}
