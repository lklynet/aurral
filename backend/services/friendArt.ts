import * as v from "valibot";
import { db } from "../config/db-sqlite.ts";
import { dbOps } from "../db/helpers/index.ts";
import { findDeezerAlbumCover } from "./apiClients/deezer.ts";
import { guessArtistMbid } from "./artistMatch.ts";
import { getArtistImage } from "./imageService.ts";
import { getLibraryArtwork } from "./libraryArtwork.ts";
import { wrappedKey } from "./wrapped/metrics.ts";

const NOT_FOUND = "NOT_FOUND";

const libraryAlbum = db.prepare<[string, string], { id: number }>(
  `SELECT library_albums.id FROM library_albums
   JOIN library_artists ON library_artists.id = library_albums.artist_id
   WHERE library_albums.title = ? COLLATE NOCASE AND library_artists.name = ? COLLATE NOCASE
   LIMIT 1`,
);
const libraryArtist = db.prepare<[string], { id: number }>(
  "SELECT id FROM library_artists WHERE name = ? COLLATE NOCASE LIMIT 1",
);

const lookups = new Map<string, Promise<string | null>>();

async function lookupArt(key: string, artist: string, album: string | undefined) {
  try {
    let found: string | null = null;
    if (album) {
      found = await findDeezerAlbumCover(artist, album);
    } else {
      const mbid = await guessArtistMbid(artist);
      if (mbid) {
        const result = await getArtistImage(mbid);
        if (result.transientError) return null;
        found = result.url;
      }
    }
    dbOps.setImage(key, found ?? NOT_FOUND);
    return found;
  } catch {
    return null;
  }
}

export async function friendArt(artist: string, album: string | undefined) {
  const local = album ? libraryAlbum.get(album, artist) : libraryArtist.get(artist);
  const file = local
    ? await getLibraryArtwork(album ? "album" : "artist", String(local.id)).catch(() => null)
    : null;
  if (file) return { file };
  const key = `friend:${wrappedKey(artist)}\u0000${album ? wrappedKey(album) : ""}`;
  const cached = dbOps.getImage(key)?.imageUrl;
  if (cached) return { url: cached === NOT_FOUND ? null : cached };
  let lookup = lookups.get(key);
  if (!lookup) {
    lookup = lookupArt(key, artist, album).finally(() => lookups.delete(key));
    lookups.set(key, lookup);
  }
  return { url: await lookup };
}

export const friendArtUrl = (artist: string, album?: string | null) =>
  `/api/hub-link/friends/art?${new URLSearchParams(album ? { artist, album } : { artist })}`;

export const withArt = <Track extends { artist: string; album: string | null }>(track: Track) => ({
  ...track,
  artworkUrl: friendArtUrl(track.artist, track.album),
});

const ranked = <Entries extends v.ObjectEntries>(entries: Entries) =>
  v.array(v.object({ ...entries, plays: v.number() }));
const mbid = v.nullish(v.string());

export const topPlaysSchema = v.object({
  artists: ranked({ name: v.string(), mbid }),
  albums: ranked({ title: v.string(), artist: v.string(), mbid }),
  tracks: ranked({ title: v.string(), artist: v.string(), mbid, albumMbid: mbid }),
  stats: v.nullish(
    v.object({
      plays: v.number(),
      minutes: v.number(),
      artists: v.number(),
      hours: v.array(v.number()),
    }),
  ),
});

export type TopPlays = v.InferOutput<typeof topPlaysSchema>;

export const topPlaysWithArt = (top: TopPlays) => ({
  ...top,
  artists: top.artists.map((artist) => ({ ...artist, artworkUrl: friendArtUrl(artist.name) })),
  albums: top.albums.map((album) => ({
    ...album,
    artworkUrl: friendArtUrl(album.artist, album.title),
  })),
});
