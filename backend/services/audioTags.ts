import {
  parseFile,
  updateFile,
  type IAudioMetadata,
  type ICommonTagsResult,
  type TagPatch,
  UnsupportedFileTypeError,
  UnsupportedFeatureError,
  UnsupportedFormatError,
  CouldNotDetermineFileTypeError,
} from "music-metadata/node";
import { closeSync, fstatSync, openSync, readSync } from "node:fs";
import path from "node:path";
import { isDeepStrictEqual } from "node:util";
import { tagValues } from "../../lib/artistCredit.ts";
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

// TXXX descriptions mapped into music-metadata's common model, so upgrades
// don't re-write mapped or cleared values through native.
const MAPPED_ID3_TXXX = new Set([
  "acoustid fingerprint",
  "acoustid id",
  "acoustid_id",
  "albumartists",
  "artists",
  "asin",
  "barcode",
  "catalogid",
  "catalognumber",
  "director",
  "discogs_album_artists",
  "discogs_artist_id",
  "discogs_artist_name",
  "discogs_artists",
  "discogs_catalog",
  "discogs_country",
  "discogs_date",
  "discogs_label",
  "discogs_label_id",
  "discogs_master_release_id",
  "discogs_rating",
  "discogs_release_id",
  "discogs_released",
  "discogs_votes",
  "disctotal",
  "gapless",
  "hdvideo",
  "isrc",
  "itunes_cddb_1",
  "license",
  "longdescription",
  "mp3gain_album_minmax",
  "mp3gain_minmax",
  "mp3gain_undo",
  "musicbrainz album artist id",
  "musicbrainz album id",
  "musicbrainz album release country",
  "musicbrainz album status",
  "musicbrainz album type",
  "musicbrainz artist id",
  "musicbrainz composer id",
  "musicbrainz disc id",
  "musicbrainz original album id",
  "musicbrainz original artist id",
  "musicbrainz release group id",
  "musicbrainz release track id",
  "musicbrainz trm id",
  "musicbrainz work id",
  "musicip puid",
  "musicmagic fingerprint",
  "notes",
  "originalyear",
  "performer",
  "performer:instrument",
  "releasecountry",
  "replaygain_album_gain",
  "replaygain_album_peak",
  "replaygain_album_range",
  "replaygain_reference_loudness",
  "replaygain_track_gain",
  "replaygain_track_gain_ratio",
  "replaygain_track_peak",
  "replaygain_track_peak_ratio",
  "replaygain_track_range",
  "script",
  "showmovement",
  "stik",
  "style",
  "technician",
  "tracktotal",
  "tvepisode",
  "tvepisodeid",
  "tvnetwork",
  "tvseason",
  "tvshow",
  "tvshowsort",
  "work",
  "writer",
]);

const stripNulls = (value: string) => value.replace(/\0\uFEFF?/g, "");

function cleanNested(value: unknown): unknown {
  if (typeof value === "string") return value.includes("\0") ? stripNulls(value) : value;
  if (Array.isArray(value)) return value.map(cleanNested);
  if (value && typeof value === "object" && Object.getPrototypeOf(value) === Object.prototype) {
    return Object.fromEntries(
      Object.entries(value).map(([key, entry]) => [key, cleanNested(entry)]),
    );
  }
  return value;
}

// ID3v2.3 multi-value frames from editors like Mp3tag carry raw NUL/BOM bytes in
// common text fields, which ID3v2.4 serialization rejects as invalid text.
function cleanLegacyCommon(common: ICommonTagsResult): TagPatch {
  const cleaned: Record<string, unknown> = {};
  for (const key of Object.keys(common) as (keyof ICommonTagsResult)[]) {
    const value: unknown = common[key];
    if (value === undefined || typeof value === "function") continue;
    if (typeof value === "string") {
      const clean = value.includes("\0") ? tagValues(value)[0] : value;
      if (clean !== undefined) cleaned[key] = clean;
    } else if (Array.isArray(value)) {
      const items = value.flatMap((entry) =>
        typeof entry === "string"
          ? entry.includes("\0")
            ? tagValues(entry)
            : [entry]
          : [cleanNested(entry)],
      );
      if (items.length) cleaned[key] = items;
    } else {
      cleaned[key] = cleanNested(value);
    }
  }
  return cleaned as TagPatch;
}

// TXXX descriptions written by Aurral's common patch fields, used to avoid
// resurrecting a replaced or cleared ID3v2.2 TXX tag through native.
const PATCH_TXXX_FIELDS: readonly [keyof TagPatch, readonly string[]][] = [
  ["artists", ["artists", "discogs_artists", "discogs_artist_name"]],
  ["genres", ["style"]],
  ["mbArtistId", ["musicbrainz artist id"]],
  ["mbAlbumArtistId", ["musicbrainz album artist id"]],
  ["mbReleaseGroupId", ["musicbrainz release group id", "musicbrainz album id"]],
  ["mbReleaseId", ["musicbrainz album id", "musicbrainz release group id"]],
];

function unmappedLegacyTxxx(tags: IAudioMetadata["native"][string], patch: TagPatch) {
  const overriddenV22 = new Set<string>();
  for (const [field, descriptions] of PATCH_TXXX_FIELDS) {
    if (patch[field] !== undefined) {
      for (const description of descriptions) overriddenV22.add(description);
    }
  }
  const preserved = new Map<string, { key: string; values: string[] }>();
  for (const tag of tags) {
    if (typeof tag.value !== "string") continue;
    let desc = "";
    let raw = "";
    let isV22 = false;
    if (tag.id.startsWith("TXXX:")) {
      desc = stripNulls(tag.id.slice(5));
      raw = tag.value;
    } else if (tag.id === "TXX") {
      const separator = tag.value.indexOf("\0");
      if (separator <= 0) continue;
      desc = tag.value.slice(0, separator).replace(/^\uFEFF/, "");
      raw = tag.value.slice(separator + 1);
      isV22 = true;
    } else {
      continue;
    }
    const lower = desc.toLowerCase();
    if (
      !lower ||
      (!isV22 && lower === AURRAL_IDENTITY_TAG.toLowerCase()) ||
      (isV22 ? overriddenV22.has(lower) : MAPPED_ID3_TXXX.has(lower))
    )
      continue;
    const values = raw.includes("\0") ? tagValues(raw) : [raw];
    if (!values.length) continue;
    const existing = preserved.get(lower);
    if (existing) existing.values.push(...values);
    else preserved.set(lower, { key: `TXXX:${desc}`, values });
  }
  const native: Record<string, string | string[]> = {};
  for (const { key, values } of preserved.values()) {
    native[key] = values.length === 1 ? values[0]! : values;
  }
  return native;
}

async function updateTags(
  filePath: string,
  metadata: IAudioMetadata,
  patch: TagPatch,
  dryRun = false,
) {
  try {
    const legacyId3 = !metadata.native["ID3v2.4"]
      ? (metadata.native["ID3v2.3"] ?? metadata.native["ID3v2.2"])
      : undefined;
    if (legacyId3) {
      // Actual replacement needs embedded artwork skipped during planning.
      const source = dryRun ? metadata : await parseFile(filePath);
      const legacyTags = source.native["ID3v2.3"] ?? source.native["ID3v2.2"] ?? [];
      const native: Record<string, NonNullable<TagPatch["native"]>[string]> = unmappedLegacyTxxx(
        legacyTags,
        patch,
      );
      const identity = readIdentity(source);
      const identityKey = `TXXX:${AURRAL_IDENTITY_TAG}`;
      if (identity) native[identityKey] = JSON.stringify(identity);
      for (const [key, value] of Object.entries(patch.native ?? {})) {
        const existing = Object.keys(native).find((k) => k.toLowerCase() === key.toLowerCase());
        if (existing && existing !== key) delete native[existing];
        native[key] = value;
      }
      await updateFile(
        filePath,
        { ...cleanLegacyCommon(source.common), ...patch, native },
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
