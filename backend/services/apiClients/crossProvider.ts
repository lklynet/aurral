import { dbOps } from "../../db/helpers/index.ts";
import {
  lookupIds,
  resolveAlbumByArtistAndTitle,
  searchTracks,
} from "../providers/metadataProvider.ts";
import { scoreTextMatch } from "../providers/metadataRanking.ts";
import { guessArtistMbid } from "../artistMatch.ts";
import { musicbrainzFindTrackReleaseGroup } from "./musicbrainz.ts";

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
  artistMbid: string | null = null,
) {
  const deezerId = String(deezerAlbumId || "")
    .replace(/^dz-/, "")
    .trim();
  const dzKey = deezerId ? `dz:${deezerId}` : null;
  const aaKey = normalizeArtistAlbumKey(artistName, albumName);
  const cached = (dzKey && dbOps.getDeezerMbidCache(dzKey)) || dbOps.getDeezerMbidCache(aaKey);
  if (cached) return cached;

  if (dzKey) {
    const key = `deezer-album:${deezerId}`;
    const linked = (await lookupIds([key]).catch(() => null))?.get(key)?.albumMbid;
    if (linked) {
      dbOps.setDeezerMbidCache(dzKey, linked);
      return linked;
    }
  }

  const artist = String(artistName || "").trim();
  const album = String(albumName || "").trim();
  if (!artist || !album) return null;

  try {
    const id = await resolveAlbumByArtistAndTitle({
      artistName: artist,
      artistMbid: artistMbid ?? "",
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

// The release group a song is on, found from the song itself, for a song whose
// album is not one of the artist's own, such as a soundtrack credited to the
// game. The album the song came with wins. MusicBrainz answers for a song the
// search index leaves out.
async function findTrackReleaseGroup(lookup: {
  artistMbid: string;
  artistName: string;
  trackName: string;
  albumName: string;
}) {
  const tracks = await searchTracks(lookup.trackName, { artistName: lookup.artistName }).catch(
    () => [],
  );
  const onAlbum = (title: string | null) => Number(scoreTextMatch(title, lookup.albumName) >= 85);
  const [best] = tracks
    .filter(
      (track) =>
        track.albumId &&
        track.artistId === lookup.artistMbid &&
        scoreTextMatch(track.title, lookup.trackName) >= 85,
    )
    .toSorted((left, right) => onAlbum(right.albumTitle) - onAlbum(left.albumTitle));
  return best?.albumId ?? musicbrainzFindTrackReleaseGroup(lookup).catch(() => null);
}

interface ArtistAlbumLookup {
  artistName?: string | null;
  albumName?: unknown;
  deezerAlbumId?: string | number | null;
  trackName?: string | null;
}

export async function resolveArtistAndAlbumMbids({
  artistName,
  albumName,
  deezerAlbumId,
  trackName,
}: ArtistAlbumLookup) {
  const artist = String(artistName || "").trim();
  const album = String(albumName || "").trim();
  const track = String(trackName || "").trim();
  const artistMbid = await guessArtistMbid(artist, { album });
  const albumMbid = album
    ? await resolveDeezerAlbumToMbid(artist, album, deezerAlbumId, artistMbid)
    : null;
  const trackAlbumMbid =
    !albumMbid && artistMbid && track
      ? await findTrackReleaseGroup({
          artistMbid,
          artistName: artist,
          trackName: track,
          albumName: album,
        })
      : null;
  return { artistMbid: artistMbid || null, albumMbid: albumMbid || trackAlbumMbid || null };
}
