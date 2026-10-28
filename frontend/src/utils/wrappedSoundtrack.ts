import type { WrappedRecap } from "../hooks/useWrapped.ts";
import { buildAuthenticatedApiUrl, resolveApiPath } from "./api/core.ts";

export type WrappedSong = WrappedRecap["topSongs"][number];
export type WrappedCue = { song: WrappedSong; named: boolean };

const NAMED = ["song", "artist", "album"] as const;
const same = (left: string | null | undefined, right: string) =>
  left?.toLowerCase() === right.toLowerCase();

export const playable = (song: WrappedSong) =>
  song.preview !== null || (song.libraryTrackId !== null && song.libraryAlbumId !== null);

export function wrappedSongSource(song: WrappedSong) {
  const path =
    song.preview === null
      ? buildAuthenticatedApiUrl(
          `/library/canonical-stream/${song.libraryAlbumId}/${song.libraryTrackId}`,
        )
      : resolveApiPath(song.preview);
  return new URL(path, window.location.href).href;
}

export function wrappedArtistSong(summary: WrappedRecap) {
  const artist = summary.topArtists[0];
  return (
    (artist && summary.topSongs.find((song) => playable(song) && same(song.artist, artist.name))) ??
    null
  );
}

export function wrappedAlbumSong(summary: WrappedRecap) {
  const album = summary.topAlbums[0];
  return (
    (album &&
      summary.topSongs.find(
        (song) => playable(song) && same(song.album, album.name) && same(song.artist, album.artist),
      )) ??
    null
  );
}

function namedSong(summary: WrappedRecap, kind: string) {
  if (kind === "song") {
    const song = summary.topSongs[0];
    return song && playable(song) ? song : null;
  }
  if (kind === "artist") return wrappedArtistSong(summary);
  if (kind === "album") return wrappedAlbumSong(summary);
  return null;
}

export function wrappedSoundtrack(summary: WrappedRecap, kinds: readonly string[]) {
  const group = (index: number) => Math.ceil(index / 2);
  const picks: (WrappedSong | null)[] = Array.from(
    { length: group(kinds.length - 1) + 1 },
    () => null,
  );
  const used = new Set<WrappedSong>();
  for (const kind of NAMED) {
    const index = kinds.indexOf(kind);
    const song = index < 0 ? null : namedSong(summary, kind);
    if (!song || used.has(song) || picks[group(index)]) continue;
    picks[group(index)] = song;
    used.add(song);
  }
  const rest = summary.topSongs.filter((song) => playable(song) && !used.has(song));
  picks.forEach((song, index) => {
    picks[index] = song ?? rest.shift() ?? picks[index - 1] ?? picks.find(Boolean) ?? null;
  });
  return kinds.map((kind, index): WrappedCue | null => {
    const song = picks[group(index)];
    return song && { song, named: namedSong(summary, kind) === song };
  });
}
