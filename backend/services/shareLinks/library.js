import {
  getLibraryForAlbumReferences,
  getLibraryForArtistReferences,
  getLibraryForArtists,
  getLibraryTrack,
} from "../libraryQueryService.js";
import { selectCanonicalFile } from "../canonicalFileSelector.js";

const BROWSER_FORMATS = new Set(["mp3", "flac", "ogg", "oga", "opus", "wav", "aac", "webm"]);

export function playsInBrowsers(file) {
  const format = String(file?.format || "").toLowerCase();
  if (BROWSER_FORMATS.has(format)) return true;
  return (format === "m4a" || format === "mp4") && !/alac/i.test(String(file?.quality?.format || ""));
}

const isPositiveId = (value) => /^\d+$/.test(String(value ?? "")) && Number(value) > 0;

function loadLibrary({ kind, targetRef, albumRef }) {
  if (kind === "track") {
    return getLibraryTrack({
      trackId: targetRef,
      availableOnly: true,
      albumId: isPositiveId(albumRef) ? Number(albumRef) : null,
    });
  }
  if (kind === "album") {
    return getLibraryForAlbumReferences({ references: [targetRef], availableOnly: true });
  }
  if (kind === "artist") {
    return isPositiveId(targetRef)
      ? getLibraryForArtistReferences({ references: [targetRef], availableOnly: true })
      : getLibraryForArtists({ mbids: [targetRef], availableOnly: true });
  }
  return { artists: [], albums: [], tracks: [] };
}

const compareText = (left, right) =>
  String(left || "").localeCompare(String(right || ""), undefined, { sensitivity: "base" });

export function resolveShareTarget(target) {
  const library = loadLibrary(target);
  const artists = new Map(library.artists.map((artist) => [artist.id, artist]));
  const tracksById = new Map(library.tracks.map((track) => [track.id, track]));
  const albums = [...library.albums].sort(
    (left, right) =>
      compareText(left.releaseDate, right.releaseDate) || compareText(left.title, right.title),
  );
  const tracks = [];
  for (const album of albums) {
    const artist = artists.get(album.artistId);
    const albumTracks = album.trackIds
      .map((trackId) => {
        const track = tracksById.get(trackId);
        const position = track?.albums.find((entry) => entry.albumId === album.id);
        const files = (track?.files || []).filter((file) => file.available && file.source !== "flow");
        const file = selectCanonicalFile(files, album.id, album.managedBy);
        if (!track || !file) return null;
        return {
          albumId: album.id,
          trackId: track.id,
          title: track.title,
          artistName: track.artistName || artist?.name || "",
          albumTitle: album.title,
          albumArtistName: artist?.name || album.albumArtist || "",
          discNumber: Number(position?.discNumber) || 1,
          trackNumber: Number(position?.trackNumber) || 0,
          durationMs: Number(file.durationMs) || null,
          file,
        };
      })
      .filter(Boolean)
      .sort((left, right) => left.discNumber - right.discNumber || left.trackNumber - right.trackNumber);
    tracks.push(...albumTracks);
  }
  const shared = target.kind === "track" ? tracks.slice(0, 1) : tracks;
  const first = shared[0];
  if (!first) return null;
  if (target.kind === "track") {
    return { title: first.title, artistName: first.artistName, albumTitle: first.albumTitle, tracks: shared };
  }
  if (target.kind === "album") {
    return { title: first.albumTitle, artistName: first.albumArtistName, albumTitle: null, tracks: shared };
  }
  return { title: first.albumArtistName, artistName: first.albumArtistName, albumTitle: null, tracks: shared };
}
