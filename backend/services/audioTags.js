import { randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import taglib from "node-taglib-sharp";

const {
  File,
  Id3v2FrameClassType,
  Id3v2Settings,
  Id3v2UserTextInformationFrame,
  ReadStyle,
  TagTypes,
} = taglib;

Id3v2Settings.useNumericGenres = false;

export const AURRAL_IDENTITY_TAG = "AURRAL_IDS";
const AURRAL_IDENTITY_PREFIX = `${AURRAL_IDENTITY_TAG}=`;
const ITUNES_MEAN = "com.apple.iTunes";
const MUSICBRAINZ_UFID_OWNER = "http://musicbrainz.org";
const READ_STYLE = ReadStyle.None | ReadStyle.PictureLazy;
const ADDED_TAG_TYPES = TagTypes.Id3v1 | TagTypes.Ape | TagTypes.MovieId | TagTypes.DivX;

const text = (value) => (value == null ? "" : String(value).trim());
const first = (values) => text(Array.isArray(values) ? values[0] : values);
const positive = (value) => {
  const number = Number(value);
  return Number.isSafeInteger(number) && number > 0 ? number : 0;
};
const list = (value) => (Array.isArray(value) ? value : text(value) ? [value] : [])
  .flatMap((entry) => String(entry).split(";"))
  .map(text)
  .filter(Boolean);

const FIELDS = {
  title: { read: (tag) => text(tag.title), write: (tag, value) => { tag.title = value; } },
  artist: { read: (tag) => first(tag.performers), write: (tag, value) => { tag.performers = [value]; } },
  albumArtist: { read: (tag) => first(tag.albumArtists), write: (tag, value) => { tag.albumArtists = [value]; } },
  album: { read: (tag) => text(tag.album), write: (tag, value) => { tag.album = value; } },
  year: { read: (tag) => positive(tag.year), write: (tag, value) => { tag.year = value; }, normalize: positive },
  trackNumber: { read: (tag) => positive(tag.track), write: (tag, value) => { tag.track = value; }, normalize: positive },
  discNumber: { read: (tag) => positive(tag.disc), write: (tag, value) => { tag.disc = value; }, normalize: positive },
  genres: {
    read: (tag) => list(tag.genres),
    write: (tag, value) => { tag.genres = value; },
    normalize: list,
  },
  artistMbid: {
    read: (tag) => text(tag.musicBrainzArtistId),
    write: (tag, value) => { tag.musicBrainzArtistId = value; },
  },
  albumArtistMbid: {
    read: (tag) => text(tag.musicBrainzReleaseArtistId),
    write: (tag, value) => { tag.musicBrainzReleaseArtistId = value; },
  },
  releaseGroupMbid: {
    read: (tag) => text(tag.musicBrainzReleaseGroupId),
    write: (tag, value) => { tag.musicBrainzReleaseGroupId = value; },
  },
  releaseMbid: {
    read: (tag) => text(tag.musicBrainzReleaseId),
    write: (tag, value) => { tag.musicBrainzReleaseId = value; },
  },
  recordingMbid: {
    read: (tag) => text(tag.musicBrainzTrackId),
    write: (tag, value, file) => {
      const id3 = file.getTag(TagTypes.Id3v2, false);
      for (const frame of id3?.getFramesByClassType(Id3v2FrameClassType.UniqueFileIdentifierFrame) || []) {
        if (frame.owner === MUSICBRAINZ_UFID_OWNER) id3.removeFrame(frame);
      }
      tag.musicBrainzTrackId = value;
    },
  },
};

export const AUDIO_TAG_FIELDS = Object.keys(FIELDS);

export class UnsupportedTagFormatError extends Error {
  constructor(filePath) {
    super(`Aurral cannot write tags to ${path.extname(filePath) || "this kind of"} files`);
    this.code = "TAGS_UNSUPPORTED";
  }
}

function openFile(filePath) {
  try {
    return File.createFromPath(filePath, undefined, READ_STYLE);
  } catch (error) {
    if (/unsupported format/i.test(String(error?.message))) throw new UnsupportedTagFormatError(filePath);
    throw error;
  }
}

const emptyValue = (field) => (field === "genres" ? [] : FIELDS[field].normalize === positive ? 0 : undefined);
const isEmpty = (value) => (Array.isArray(value) ? value.length === 0 : !value);
const normalize = (field, value) => (FIELDS[field].normalize || text)(value);
const same = (left, right) => JSON.stringify(left) === JSON.stringify(right);

function readFields(tag) {
  return Object.fromEntries(AUDIO_TAG_FIELDS.map((field) => [field, FIELDS[field].read(tag)]));
}

function parseIdentity(value) {
  const raw = text(value);
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw.startsWith(AURRAL_IDENTITY_PREFIX) ? raw.slice(AURRAL_IDENTITY_PREFIX.length) : raw);
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

function identityFrames(id3) {
  return id3.getFramesByClassType(Id3v2FrameClassType.UserTextInformationFrame)
    .filter((frame) => frame.description === AURRAL_IDENTITY_TAG);
}

function readIdentity(file) {
  const xiph = file.getTag(TagTypes.Xiph, false);
  const id3 = file.getTag(TagTypes.Id3v2, false);
  const apple = file.getTag(TagTypes.Apple, false);
  return parseIdentity(xiph?.getFieldFirstValue(AURRAL_IDENTITY_TAG))
    || parseIdentity(id3 ? identityFrames(id3)[0]?.text?.[0] : null)
    || parseIdentity(apple?.getItunesStrings(ITUNES_MEAN, AURRAL_IDENTITY_TAG)?.[0]);
}

function writeIdentity(file, identity) {
  const value = JSON.stringify(identity);
  const xiph = file.getTag(TagTypes.Xiph, false);
  if (xiph) xiph.setFieldAsStrings(AURRAL_IDENTITY_TAG, value);
  const apple = file.getTag(TagTypes.Apple, false);
  if (apple) apple.setItunesStrings(ITUNES_MEAN, AURRAL_IDENTITY_TAG, value);
  const id3 = file.getTag(TagTypes.Id3v2, false);
  if (id3) {
    for (const frame of identityFrames(id3)) id3.removeFrame(frame);
    const frame = Id3v2UserTextInformationFrame.fromDescription(AURRAL_IDENTITY_TAG);
    frame.text = [value];
    id3.addFrame(frame);
  }
}

const isLegacyMarker = (value) => text(value).startsWith(AURRAL_IDENTITY_PREFIX);

function clearLegacyIdentity(file) {
  if (isLegacyMarker(file.tag.grouping)) file.tag.grouping = undefined;
  if (isLegacyMarker(file.tag.comment)) file.tag.comment = undefined;
  const id3 = file.getTag(TagTypes.Id3v2, false);
  for (const frame of id3?.getFramesByClassType(Id3v2FrameClassType.UserTextInformationFrame) || []) {
    if (frame.description.toLowerCase() === "comment" && isLegacyMarker(frame.text?.[0])) id3.removeFrame(frame);
  }
}

function hasLegacyIdentity(file) {
  const id3 = file.getTag(TagTypes.Id3v2, false);
  return isLegacyMarker(file.tag.grouping) || isLegacyMarker(file.tag.comment)
    || (id3?.getFramesByClassType(Id3v2FrameClassType.UserTextInformationFrame) || [])
      .some((frame) => frame.description.toLowerCase() === "comment" && isLegacyMarker(frame.text?.[0]));
}

// Changes only the tags Aurral has a value for. Every other tag, including
// ratings, lyrics, ReplayGain, and cover art, stays as it was.
function planChanges(current, values, fillOnly) {
  const changes = {};
  for (const field of AUDIO_TAG_FIELDS) {
    if (values[field] == null) continue;
    const wanted = normalize(field, values[field]);
    if (isEmpty(wanted) || same(wanted, current[field])) continue;
    if (fillOnly && !isEmpty(current[field])) continue;
    changes[field] = wanted;
  }
  if (!fillOnly && changes.releaseGroupMbid && current.releaseGroupMbid && current.releaseMbid && !changes.releaseMbid) {
    changes.releaseMbid = null;
  }
  return changes;
}

export async function readAudioTags(filePath) {
  const file = openFile(filePath);
  try {
    return { ...readFields(file.tag), identity: readIdentity(file) };
  } finally {
    file.dispose();
  }
}

// Writes to a copy beside the file and moves it into place, so a crash never
// leaves half a file, and a hardlinked file gets its own copy while the other
// link keeps its tags.
export async function writeAudioTags(filePath, values = {}, { fillOnly = false, identity = null } = {}) {
  const source = path.resolve(filePath);
  const preview = openFile(source);
  let changes;
  let identityChanged;
  let legacyIdentity;
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
  const working = path.join(path.dirname(source), `.${path.basename(source, extension)}.${randomUUID()}.tagging${extension}`);
  await fs.copyFile(source, working, fs.constants.COPYFILE_FICLONE);
  try {
    const file = openFile(working);
    try {
      file.removeTags(ADDED_TAG_TYPES & ~file.tagTypesOnDisk);
      const id3 = file.getTag(TagTypes.Id3v2, false);
      if (id3 && !(file.tagTypesOnDisk & TagTypes.Id3v2)) id3.version = 4;
      for (const field of changed) {
        FIELDS[field].write(file.tag, changes[field] === null ? emptyValue(field) : changes[field], file);
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
