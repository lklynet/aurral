import { readAudioTags, UnsupportedTagFormatError } from "../audioTags.js";
import { isSameLibraryName } from "../libraryMediaStore.js";
import {
  getAlbumByMbid,
  isMetadataNotFoundError,
  resolveAlbumByArtistAndTitle,
  selectAlbumRelease,
} from "../providers/brainzmashProvider.js";

const LENGTH_TOLERANCE_MS = 15000;

const FIELD_LABELS = [
  ["MusicBrainz IDs", ["artistMbid", "albumArtistMbid", "releaseGroupMbid", "releaseMbid", "recordingMbid"]],
  ["Title", ["title"]],
  ["Artist", ["artist"]],
  ["Album artist", ["albumArtist"]],
  ["Album", ["album"]],
  ["Year", ["year"]],
  ["Track", ["trackNumber"]],
  ["Disc", ["discNumber"]],
  ["Genre", ["genres"]],
];

const yearOf = (value) => Number(String(value || "").match(/^\d{4}/)?.[0]) || 0;
const isEmpty = (value) => (Array.isArray(value) ? value.length === 0 : !value);

// Only an album the provider does not have is no match. Any other failure
// reaches planTagFill, which says the provider could not be reached.
const albumOrNone = (mbid) => getAlbumByMbid(mbid).catch((error) => {
  if (isMetadataNotFoundError(error)) return null;
  throw error;
});

async function resolveMusicBrainzAlbum(album, artist) {
  for (const mbid of [...new Set([album.releaseGroupMbid, album.releaseMbid].filter(Boolean))]) {
    const found = await albumOrNone(mbid);
    if (found?.id) return found;
  }
  const releaseGroup = await resolveAlbumByArtistAndTitle({
    artistName: artist.name || "",
    albumTitle: album.title,
    releaseYear: yearOf(album.year) || null,
  });
  if (!releaseGroup) return null;
  const found = await albumOrNone(releaseGroup);
  const artists = Array.isArray(found?.artists) ? found.artists : [];
  const sameArtist = artist.mbid
    ? found?.artistId === artist.mbid || artists.some((entry) => entry.id === artist.mbid)
    : artists.some((entry) => isSameLibraryName(entry.name, artist.name));
  return sameArtist ? found : null;
}

const atFilePosition = (file) => (entry) => entry.trackNumber === file.trackNumber
  && (!file.discNumber || (entry.mediumNumber || 1) === file.discNumber);

function matchMusicBrainzTrack(mbAlbum, file, { recordingMbid, releaseMbid }) {
  const own = releaseMbid && mbAlbum.releases?.find((release) => release.id === releaseMbid);
  const chosen = own || selectAlbumRelease(mbAlbum);
  const releases = [chosen, ...(mbAlbum.releases || []).filter((release) => release !== chosen)].filter(Boolean);
  if (recordingMbid) {
    for (const release of releases) {
      let tracks = (release.tracks || []).filter((entry) =>
        entry.recordingId === recordingMbid || entry.oldRecordingIds?.includes(recordingMbid));
      if (tracks.length > 1) tracks = file.trackNumber ? tracks.filter(atFilePosition(file)) : [];
      if (tracks.length === 1) return { release, track: tracks[0] };
      if (tracks.length > 1) return null;
    }
    return null;
  }
  for (const release of own ? [own] : releases) {
    let candidates = (release.tracks || []).filter((entry) => isSameLibraryName(entry.title, file.title));
    if (file.trackNumber) candidates = candidates.filter(atFilePosition(file));
    if (candidates.length > 1) return null;
    if (candidates.length !== 1) continue;
    const [track] = candidates;
    const lengthsAgree = !file.durationMs || !track.durationMs
      || Math.abs(file.durationMs - track.durationMs) <= LENGTH_TOLERANCE_MS;
    if (lengthsAgree) return { release, track };
  }
  return null;
}

function musicBrainzTags(mbAlbum, { release, track }) {
  const artists = Array.isArray(mbAlbum.artists) ? mbAlbum.artists : [];
  const albumArtist = artists.find((entry) => entry.id === mbAlbum.artistId) || artists[0] || null;
  const trackArtist = artists.find((entry) => entry.id === track.artistId);
  return {
    title: track.title,
    artist: track.artistId ? trackArtist?.name : albumArtist?.name,
    albumArtist: albumArtist?.name,
    album: mbAlbum.title,
    year: yearOf(mbAlbum.releaseDate),
    trackNumber: track.trackNumber || 0,
    discNumber: track.mediumNumber || 1,
    genres: (mbAlbum.genres || []).slice(0, 5),
    artistMbid: track.artistId || mbAlbum.artistId,
    albumArtistMbid: mbAlbum.artistId,
    releaseGroupMbid: mbAlbum.id,
    releaseMbid: release.id,
    recordingMbid: track.recordingId,
  };
}

export function describeTagFields(tags = {}) {
  return FIELD_LABELS
    .filter(([, fields]) => fields.some((field) => field in tags))
    .map(([label]) => label);
}

// Which of a file's empty tags MusicBrainz can fill in. Tags the file already
// has are never planned, and a file without a confident match gets none.
export async function planTagFill({ filePath, album, artist, file }, albums = new Map()) {
  let current;
  try {
    current = await readAudioTags(filePath);
  } catch (error) {
    if (error instanceof UnsupportedTagFormatError) return { reason: `${error.message}, so its tags stay as they are.` };
    return { reason: "Aurral could not read this file's tags." };
  }
  const key = JSON.stringify([
    current.releaseGroupMbid || album.releaseGroupMbid || "",
    current.releaseMbid || album.releaseMbid || "",
    artist.mbid || artist.name || "",
    album.title || "",
    yearOf(album.year),
  ]);
  let mbAlbum;
  try {
    if (!albums.has(key)) {
      albums.set(key, resolveMusicBrainzAlbum({
        ...album,
        releaseGroupMbid: current.releaseGroupMbid || album.releaseGroupMbid,
        releaseMbid: current.releaseMbid || album.releaseMbid,
      }, artist));
    }
    mbAlbum = await albums.get(key);
  } catch {
    albums.delete(key);
    return { reason: "Aurral could not reach the metadata provider, so its tags stay as they are." };
  }
  if (!mbAlbum) return { reason: "No confident MusicBrainz match for this album, so its tags stay as they are." };
  const match = matchMusicBrainzTrack(mbAlbum, file, current);
  if (!match) return { reason: "No confident MusicBrainz match for this track, so its tags stay as they are." };
  const tags = Object.fromEntries(Object.entries(musicBrainzTags(mbAlbum, match))
    .filter(([field, value]) => !isEmpty(value) && isEmpty(current[field])));
  return Object.keys(tags).length ? { tags, fields: describeTagFields(tags) } : {};
}
