import {
  getLibraryForAlbumReferences,
  getLibraryForArtistReferences,
  getLibraryForArtists,
  getLibraryTrack,
  getLibraryForTrackMatches,
} from "../libraryQueryService.ts";
import { selectCanonicalFile } from "../canonicalFileSelector.ts";
import { flowPlaylistConfig } from "../playlists/flowPlaylistConfig.ts";
import { findSharedTrack } from "../../../lib/shareManifest.ts";

const BROWSER_FORMATS = new Set(["mp3", "flac", "ogg", "oga", "opus", "wav", "aac", "webm"]);

interface PlayableFile {
  format?: string | null;
  quality?: { format?: string | null } | null;
}

interface ShareTarget {
  kind: string;
  targetRef: string;
  albumRef: string | null;
}

export function playsInBrowsers(file: PlayableFile | null | undefined) {
  const format = String(file?.format || "").toLowerCase();
  if (BROWSER_FORMATS.has(format)) return true;
  return (
    (format === "m4a" || format === "mp4") && !/alac/i.test(String(file?.quality?.format || ""))
  );
}

const isPositiveId = (value: string | null) =>
  /^\d+$/.test(String(value ?? "")) && Number(value) > 0;

function loadLibrary({ kind, targetRef, albumRef }: ShareTarget) {
  if (kind === "playlist") {
    const playlist = flowPlaylistConfig.getStaticPlaylist(targetRef);
    return getLibraryForTrackMatches({
      availableOnly: true,
      mbids: playlist?.tracks.map((track) => track.trackMbid) || [],
      titles: playlist?.tracks.map((track) => track.trackName) || [],
    });
  }
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

const compareText = (left: string | null | undefined, right: string | null | undefined) =>
  String(left || "").localeCompare(String(right || ""), undefined, { sensitivity: "base" });

export function resolveShareTarget(target: ShareTarget) {
  const playlist =
    target.kind === "playlist" ? flowPlaylistConfig.getStaticPlaylist(target.targetRef) : null;
  if (target.kind === "playlist" && !playlist) return null;
  const library = loadLibrary(target);
  const artists = new Map(library.artists.map((artist) => [artist.id, artist]));
  const tracksById = new Map(library.tracks.map((track) => [track.id, track]));
  const albums = [...library.albums].sort(
    (left, right) =>
      compareText(left.releaseDate, right.releaseDate) || compareText(left.title, right.title),
  );
  const tracks = albums.flatMap((album) => {
    const artist = artists.get(album.artistId);
    const albumTracks = album.trackIds
      .map((trackId) => {
        const track = tracksById.get(trackId);
        const position = track?.albums.find((entry) => entry.albumId === album.id);
        const files = (track?.files || []).filter(
          (file) => file.available && file.source !== "flow",
        );
        const file = selectCanonicalFile(files, album.id, album.managedBy);
        if (!track || !file) return null;
        return {
          albumId: album.id,
          trackId: track.id,
          title: track.title,
          artistName: track.artistName || artist?.name || "",
          albumTitle: album.title,
          artistMbid: artist?.mbid || null,
          albumMbid: album.releaseGroupMbid || null,
          releaseMbid: album.mbid !== album.releaseGroupMbid ? album.mbid : null,
          trackMbid: track.mbid || null,
          albumArtistName: artist?.name || album.albumArtist || "",
          discNumber: Number(position?.discNumber) || 1,
          trackNumber: Number(position?.trackNumber) || 0,
          durationMs: Number(file.durationMs) || null,
          file,
        };
      })
      .filter((track) => track !== null)
      .sort(
        (left, right) => left.discNumber - right.discNumber || left.trackNumber - right.trackNumber,
      );
    return albumTracks;
  });
  if (playlist) {
    const ordered = playlist.tracks
      .map((entry) =>
        findSharedTrack(tracks, {
          title: entry.trackName,
          artistName: entry.artistName,
          trackMbid: entry.trackMbid || null,
          albumMbid: entry.albumMbid || null,
          releaseMbid: entry.releaseMbid || null,
          albumTitle: entry.albumName || null,
        }),
      )
      .filter((track) => track !== undefined);
    return { title: playlist.name, artistName: "", albumTitle: null, tracks: ordered };
  }
  const shared = target.kind === "track" ? tracks.slice(0, 1) : tracks;
  const first = shared[0];
  if (!first) return null;
  if (target.kind === "track") {
    return {
      title: first.title,
      artistName: first.artistName,
      albumTitle: first.albumTitle,
      tracks: shared,
    };
  }
  if (target.kind === "album") {
    return {
      title: first.albumTitle,
      artistName: first.albumArtistName,
      albumTitle: null,
      tracks: shared,
    };
  }
  return {
    title: first.albumArtistName,
    artistName: first.albumArtistName,
    albumTitle: null,
    tracks: shared,
  };
}
