import * as v from "valibot";
import { db } from "../config/db-sqlite.ts";
import { dbOps } from "../db/helpers/index.ts";
import { findDeezerAlbumCover } from "./apiClients/deezer.ts";
import { guessArtistMbid } from "./artistMatch.ts";
import { getArtistImage } from "./imageService.ts";
import { getLibraryArtwork } from "./libraryArtwork.ts";
import { buildStableImageProxyUrl } from "./imageProxyService.ts";
import { selectAlbumCover } from "./imageRanking.ts";
import { getAlbumByMbid, isMetadataNotFoundError } from "./providers/metadataProvider.ts";
import { MBID_PATTERN } from "../../lib/mbid.ts";
import { wrappedKey } from "./wrapped/metrics.ts";

const NOT_FOUND = "NOT_FOUND";

type AlbumArtRow = { id: number; groupMbid: string | null };

const libraryAlbum = db.prepare<[string, string], AlbumArtRow>(
  `SELECT album.id, album.release_group_mbid AS groupMbid FROM library_albums AS album
   JOIN library_artists AS artist ON artist.id = album.artist_id
   WHERE album.title = ? COLLATE NOCASE AND artist.name = ? COLLATE NOCASE
   LIMIT 1`,
);
const libraryArtist = db.prepare<[string], { id: number }>(
  "SELECT id FROM library_artists WHERE name = ? COLLATE NOCASE LIMIT 1",
);
const libraryAlbumByMbid = db.prepare<[string, string, string], AlbumArtRow>(
  `SELECT id, release_group_mbid AS groupMbid FROM library_albums
   WHERE release_group_mbid = ? OR mbid = ?
   ORDER BY release_group_mbid = ? DESC, id LIMIT 1`,
);
const libraryAlbumByMbidNocase = db.prepare<[string, string, string], AlbumArtRow>(
  `SELECT id, release_group_mbid AS groupMbid FROM library_albums
   WHERE lower(release_group_mbid) = ? OR lower(mbid) = ?
   ORDER BY lower(release_group_mbid) = ? DESC, id LIMIT 1`,
);
const libraryArtistByMbid = db.prepare<[string], { id: number }>(
  "SELECT id FROM library_artists WHERE mbid = ? LIMIT 1",
);
const libraryArtistByMbidNocase = db.prepare<[string], { id: number }>(
  "SELECT id FROM library_artists WHERE lower(mbid) = ? LIMIT 1",
);

const lookups = new Map<string, Promise<string | null>>();

async function lookupArt(
  key: string,
  artist: string,
  album: string | undefined,
  mbid: string | null,
) {
  try {
    let found: string | null = null;
    let transientError = false;
    if (album) {
      if (mbid) {
        const metadata = await getAlbumByMbid(mbid).catch((error: unknown) => {
          if (!isMetadataNotFoundError(error)) transientError = true;
          return null;
        });
        const cover = metadata?.cover || selectAlbumCover(metadata?.images)?.url;
        found = buildStableImageProxyUrl(cover);
      }
      found ||= await findDeezerAlbumCover(artist, album);
    } else {
      const artistMbid = mbid || (await guessArtistMbid(artist));
      if (artistMbid) {
        const result = await getArtistImage(artistMbid);
        if (result.transientError) return null;
        found = result.url;
      }
    }
    if (!found && transientError) return null;
    dbOps.setImage(key, found ?? NOT_FOUND);
    return found;
  } catch {
    return null;
  }
}

export async function friendArt(artist: string, album: string | undefined, mbid?: string) {
  const id = mbid && MBID_PATTERN.test(mbid) ? mbid.toLowerCase() : null;
  const localAlbum = album
    ? id
      ? libraryAlbumByMbid.get(id, id, id) || libraryAlbumByMbidNocase.get(id, id, id)
      : libraryAlbum.get(album, artist)
    : null;
  const local = album
    ? localAlbum
    : id
      ? libraryArtistByMbid.get(id) || libraryArtistByMbidNocase.get(id)
      : libraryArtist.get(artist);
  const file = local
    ? await getLibraryArtwork(album ? "album" : "artist", String(local.id)).catch(() => null)
    : null;
  if (file) return { file };
  const catalogueId = localAlbum && id ? (localAlbum.groupMbid?.toLowerCase() ?? null) : id;
  const key = id
    ? `friend:${album ? "album" : "artist"}:${id}`
    : `friend:${wrappedKey(artist)}\u0000${album ? wrappedKey(album) : ""}`;
  const cached = dbOps.getImage(key)?.imageUrl;
  if (cached) return { url: cached === NOT_FOUND ? null : cached };
  let lookup = lookups.get(key);
  if (!lookup) {
    lookup = lookupArt(key, artist, album, catalogueId).finally(() => lookups.delete(key));
    lookups.set(key, lookup);
  }
  return { url: await lookup };
}

export const friendArtUrl = (artist: string, album?: string | null, mbid?: string | null) =>
  `/api/hub-link/friends/art?${new URLSearchParams({
    artist,
    ...(album && { album }),
    ...(mbid && { mbid }),
  })}`;

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
  artists: top.artists.map((artist) => ({
    ...artist,
    artworkUrl: friendArtUrl(artist.name, null, artist.mbid),
  })),
  albums: top.albums.map((album) => ({
    ...album,
    artworkUrl: friendArtUrl(album.artist, album.title, album.mbid),
  })),
});
