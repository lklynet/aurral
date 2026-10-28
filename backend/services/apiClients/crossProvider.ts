import { dbOps } from "../../db/helpers/index.ts";
import { resolveAlbumByArtistAndTitle } from "../providers/brainzmashProvider.ts";
import { guessArtistMbid } from "../artistMatch.ts";

function normalizeArtistAlbumKey(
  artistName: string | null | undefined,
  albumName: string | null | undefined,
) {
  const a = String(artistName || "")
    .trim()
    .toLowerCase();
  const b = String(albumName || "")
    .trim()
    .toLowerCase();
  return `aa:${a}\0${b}`;
}

export async function resolveDeezerAlbumToMbid(
  artistName: string | null | undefined,
  albumName: string | null | undefined,
  deezerAlbumId: string | number | null | undefined,
) {
  const deezerId = String(deezerAlbumId || "")
    .replace(/^dz-/, "")
    .trim();
  const dzKey = deezerId ? `dz:${deezerId}` : null;
  const aaKey = normalizeArtistAlbumKey(artistName, albumName);
  const cached = (dzKey && dbOps.getDeezerMbidCache(dzKey)) || dbOps.getDeezerMbidCache(aaKey);
  if (cached) return cached;

  const artist = String(artistName || "").trim();
  const album = String(albumName || "").trim();
  if (!artist || !album) return null;

  try {
    const id = await resolveAlbumByArtistAndTitle({
      artistName: artist,
      albumTitle: album,
    });
    if (!id) return null;
    if (dzKey) dbOps.setDeezerMbidCache(dzKey, id);
    dbOps.setDeezerMbidCache(aaKey, id);
    return id;
  } catch (e) {
    return null;
  }
}

interface ArtistAlbumLookup {
  artistName?: string | null;
  albumName?: unknown;
  deezerAlbumId?: string | number | null;
}

export async function resolveArtistAndAlbumMbids({
  artistName,
  albumName,
  deezerAlbumId,
}: ArtistAlbumLookup) {
  const artist = String(artistName || "").trim();
  const album = String(albumName || "").trim();
  const [artistMbid, albumMbid] = await Promise.all([
    guessArtistMbid(artist, { album }),
    album ? resolveDeezerAlbumToMbid(artist, album, deezerAlbumId) : null,
  ]);
  return { artistMbid: artistMbid || null, albumMbid: albumMbid || null };
}
