import { randomUUID } from "node:crypto";
import { closeSync, fstatSync, openSync, readSync } from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import type * as TagLib from "node-taglib-sharp";

let File: typeof TagLib.File;
let Id3v2FrameClassType: typeof TagLib.Id3v2FrameClassType;
let Id3v2UserTextInformationFrame: typeof TagLib.Id3v2UserTextInformationFrame;
let TagTypes: typeof TagLib.TagTypes;
let readStyle: TagLib.ReadStyle;
let addedTagTypes: TagLib.TagTypes;
let taglibReady: Promise<void> | undefined;

function loadTaglib() {
  return (taglibReady ||= import("node-taglib-sharp").then(({ default: taglib }) => {
    ({ File, Id3v2FrameClassType, Id3v2UserTextInformationFrame, TagTypes } = taglib);
    taglib.Id3v2Settings.useNumericGenres = false;
    readStyle = taglib.ReadStyle.None | taglib.ReadStyle.PictureLazy;
    addedTagTypes = TagTypes.Id3v1 | TagTypes.Ape | TagTypes.MovieId | TagTypes.DivX;
  }));
}

export const AURRAL_IDENTITY_TAG = "AURRAL_IDS";
const AURRAL_IDENTITY_PREFIX = `${AURRAL_IDENTITY_TAG}=`;
const ITUNES_MEAN = "com.apple.iTunes";
const MUSICBRAINZ_UFID_OWNER = "http://musicbrainz.org";

type TagFieldValue = string | number | string[] | null | undefined;

interface TagFieldSpec {
  read(tag: TagLib.Tag): TagFieldValue;
  write(tag: TagLib.Tag, value: TagFieldValue, file: TagLib.File): void;
  normalize?(value: unknown): TagFieldValue;
}

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

const FIELDS = {
  title: {
    read: (tag) => text(tag.title),
    write: (tag, value: string) => {
      tag.title = value;
    },
  },
  artist: {
    read: (tag) => first(tag.performers),
    write: (tag, value: string) => {
      tag.performers = [value];
    },
  },
  albumArtist: {
    read: (tag) => first(tag.albumArtists),
    write: (tag, value: string) => {
      tag.albumArtists = [value];
    },
  },
  album: {
    read: (tag) => text(tag.album),
    write: (tag, value: string) => {
      tag.album = value;
    },
  },
  year: {
    read: (tag) => positive(tag.year),
    write: (tag, value: number) => {
      tag.year = value;
    },
    normalize: positive,
  },
  trackNumber: {
    read: (tag) => positive(tag.track),
    write: (tag, value: number) => {
      tag.track = value;
    },
    normalize: positive,
  },
  discNumber: {
    read: (tag) => positive(tag.disc),
    write: (tag, value: number) => {
      tag.disc = value;
    },
    normalize: positive,
  },
  genres: {
    read: (tag) => list(tag.genres),
    write: (tag, value: string[]) => {
      tag.genres = value;
    },
    normalize: list,
  },
  artistMbid: {
    read: (tag) => text(tag.musicBrainzArtistId),
    write: (tag, value: string) => {
      tag.musicBrainzArtistId = value;
    },
  },
  albumArtistMbid: {
    read: (tag) => text(tag.musicBrainzReleaseArtistId),
    write: (tag, value: string) => {
      tag.musicBrainzReleaseArtistId = value;
    },
  },
  releaseGroupMbid: {
    read: (tag) => text(tag.musicBrainzReleaseGroupId),
    write: (tag, value: string) => {
      tag.musicBrainzReleaseGroupId = value;
    },
  },
  releaseMbid: {
    read: (tag) => text(tag.musicBrainzReleaseId),
    write: (tag, value: string) => {
      tag.musicBrainzReleaseId = value;
    },
  },
  recordingMbid: {
    read: (tag) => text(tag.musicBrainzTrackId),
    write: (tag, value: string, file) => {
      const id3 = file.getTag(TagTypes.Id3v2, false) as TagLib.Id3v2Tag | undefined;
      for (const frame of id3?.getFramesByClassType<TagLib.Id3v2UniqueFileIdentifierFrame>(
        Id3v2FrameClassType.UniqueFileIdentifierFrame,
      ) || []) {
        if (frame.owner === MUSICBRAINZ_UFID_OWNER) id3!.removeFrame(frame);
      }
      tag.musicBrainzTrackId = value;
    },
  },
} satisfies Record<string, TagFieldSpec>;

export const AUDIO_TAG_FIELDS = Object.keys(FIELDS);

export class UnsupportedTagFormatError extends Error {
  declare code: string;

  constructor(filePath: string, kind = "") {
    super(`Aurral cannot write tags to ${kind}${path.extname(filePath) || "this kind of"} files`);
    this.code = "TAGS_UNSUPPORTED";
  }
}

// taglib grows the header of a fragmented MP4 without moving the data offsets
// its fragments point at, which breaks the audio.
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

async function openFile(filePath: string) {
  await loadTaglib();
  if (isFragmentedMp4(filePath)) throw new UnsupportedTagFormatError(filePath, "fragmented ");
  try {
    return File.createFromPath(filePath, undefined, readStyle);
  } catch (error) {
    if (/unsupported format/i.test(String(error?.message)))
      throw new UnsupportedTagFormatError(filePath);
    throw error;
  }
}

const emptyValue = (field: string) =>
  field === "genres" ? [] : FIELDS[field].normalize === positive ? 0 : undefined;
const isEmpty = (value: unknown) => (Array.isArray(value) ? value.length === 0 : !value);
const normalize = (field: string, value: unknown) => (FIELDS[field].normalize || text)(value);
const same = (left: unknown, right: unknown) => JSON.stringify(left) === JSON.stringify(right);

type AudioTagValues = { [K in keyof typeof FIELDS]: ReturnType<(typeof FIELDS)[K]["read"]> };

function readFields(tag: TagLib.Tag) {
  return Object.fromEntries(
    AUDIO_TAG_FIELDS.map((field): [string, TagFieldValue] => [field, FIELDS[field].read(tag)]),
  ) as AudioTagValues;
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

function identityFrames(id3: TagLib.Id3v2Tag) {
  return id3
    .getFramesByClassType<TagLib.Id3v2UserTextInformationFrame>(
      Id3v2FrameClassType.UserTextInformationFrame,
    )
    .filter((frame) => frame.description === AURRAL_IDENTITY_TAG);
}

function readIdentity(file: TagLib.File) {
  const xiph = file.getTag(TagTypes.Xiph, false) as TagLib.XiphComment | undefined;
  const id3 = file.getTag(TagTypes.Id3v2, false) as TagLib.Id3v2Tag | undefined;
  const apple = file.getTag(TagTypes.Apple, false) as TagLib.Mpeg4AppleTag | undefined;
  return (
    parseIdentity(xiph?.getFieldFirstValue(AURRAL_IDENTITY_TAG)) ||
    parseIdentity(id3 ? identityFrames(id3)[0]?.text?.[0] : null) ||
    parseIdentity(apple?.getItunesStrings(ITUNES_MEAN, AURRAL_IDENTITY_TAG)?.[0])
  );
}

function writeIdentity(file: TagLib.File, identity: object) {
  const value = JSON.stringify(identity);
  const xiph = file.getTag(TagTypes.Xiph, false) as TagLib.XiphComment | undefined;
  if (xiph) xiph.setFieldAsStrings(AURRAL_IDENTITY_TAG, value);
  const apple = file.getTag(TagTypes.Apple, false) as TagLib.Mpeg4AppleTag | undefined;
  if (apple) apple.setItunesStrings(ITUNES_MEAN, AURRAL_IDENTITY_TAG, value);
  const id3 = file.getTag(TagTypes.Id3v2, false) as TagLib.Id3v2Tag | undefined;
  if (id3) {
    for (const frame of identityFrames(id3)) id3.removeFrame(frame);
    const frame = Id3v2UserTextInformationFrame.fromDescription(AURRAL_IDENTITY_TAG);
    frame.text = [value];
    id3.addFrame(frame);
  }
}

const isLegacyMarker = (value: unknown) => text(value).startsWith(AURRAL_IDENTITY_PREFIX);

// ffmpeg wrote the old comment marker to Vorbis comments as DESCRIPTION, which
// taglib does not read as the comment.
const legacyDescription = (file: TagLib.File) =>
  (
    (file.getTag(TagTypes.Xiph, false) as TagLib.XiphComment | undefined)?.getField(
      "DESCRIPTION",
    ) || []
  ).some(isLegacyMarker);

function clearLegacyIdentity(file: TagLib.File) {
  if (isLegacyMarker(file.tag.grouping)) file.tag.grouping = undefined;
  if (isLegacyMarker(file.tag.comment)) file.tag.comment = undefined;
  if (legacyDescription(file)) {
    const xiph = file.getTag(TagTypes.Xiph, false) as TagLib.XiphComment;
    xiph.setFieldAsStrings(
      "DESCRIPTION",
      ...xiph.getField("DESCRIPTION").filter((value) => !isLegacyMarker(value)),
    );
  }
  const id3 = file.getTag(TagTypes.Id3v2, false) as TagLib.Id3v2Tag | undefined;
  for (const frame of id3?.getFramesByClassType<TagLib.Id3v2UserTextInformationFrame>(
    Id3v2FrameClassType.UserTextInformationFrame,
  ) || []) {
    if (frame.description.toLowerCase() === "comment" && isLegacyMarker(frame.text?.[0]))
      id3!.removeFrame(frame);
  }
}

function hasLegacyIdentity(file: TagLib.File) {
  const id3 = file.getTag(TagTypes.Id3v2, false) as TagLib.Id3v2Tag | undefined;
  return (
    isLegacyMarker(file.tag.grouping) ||
    isLegacyMarker(file.tag.comment) ||
    legacyDescription(file) ||
    (
      id3?.getFramesByClassType<TagLib.Id3v2UserTextInformationFrame>(
        Id3v2FrameClassType.UserTextInformationFrame,
      ) || []
    ).some(
      (frame) => frame.description.toLowerCase() === "comment" && isLegacyMarker(frame.text?.[0]),
    )
  );
}

// Changes only the tags Aurral has a value for. Every other tag, including
// ratings, lyrics, ReplayGain, and cover art, stays as it was.
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
    if (fillOnly && !isEmpty(current[field])) continue;
    changes[field] = wanted;
  }
  if (
    !fillOnly &&
    changes.releaseGroupMbid &&
    current.releaseGroupMbid &&
    current.releaseMbid &&
    !changes.releaseMbid
  ) {
    changes.releaseMbid = null;
  }
  return changes;
}

export async function readAudioTags(filePath: string) {
  const file = await openFile(filePath);
  try {
    return { ...readFields(file.tag), identity: readIdentity(file) };
  } finally {
    file.dispose();
  }
}

// Writes to a copy beside the file and moves it into place, so a crash never
// leaves half a file, and a hardlinked file gets its own copy while the other
// link keeps its tags.
export async function writeAudioTags(
  filePath: string,
  values: Record<string, TagFieldValue> = {},
  { fillOnly = false, identity = null }: { fillOnly?: boolean; identity?: object | null } = {},
) {
  const source = path.resolve(filePath);
  const preview = await openFile(source);
  let changes: Record<string, TagFieldValue>;
  let identityChanged: boolean;
  let legacyIdentity: boolean;
  try {
    changes = planChanges(readFields(preview.tag), values, fillOnly);
    identityChanged = Boolean(identity) && !same(readIdentity(preview), identity);
    legacyIdentity = Boolean(identity) && hasLegacyIdentity(preview);
  } finally {
    preview.dispose();
  }
  const changed = Object.keys(changes);
  if (!changed.length && !identityChanged && !legacyIdentity) return [];

  const extension = path.extname(source);
  const working = path.join(
    path.dirname(source),
    `.${path.basename(source, extension)}.${randomUUID()}.tagging${extension}`,
  );
  await fs.copyFile(source, working, fs.constants.COPYFILE_FICLONE);
  try {
    const file = await openFile(working);
    try {
      file.removeTags(addedTagTypes & ~file.tagTypesOnDisk);
      const id3 = file.getTag(TagTypes.Id3v2, false) as TagLib.Id3v2Tag | undefined;
      if (id3 && !(file.tagTypesOnDisk & TagTypes.Id3v2)) id3.version = 4;
      for (const field of changed) {
        FIELDS[field].write(
          file.tag,
          changes[field] === null ? emptyValue(field) : changes[field],
          file,
        );
      }
      if (identity) {
        writeIdentity(file, identity);
        clearLegacyIdentity(file);
      }
      file.save();
    } finally {
      file.dispose();
    }
    await fs.rename(working, source);
  } catch (error) {
    await fs.rm(working, { force: true }).catch(() => {});
    throw error;
  }
  return changed;
}
