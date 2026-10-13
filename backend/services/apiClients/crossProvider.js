import axios from "../../../lib/axiosFetch.js";
import createCache from "./simpleCache.js";
import { dbOps } from "../../db/helpers/index.js";
import { resolveAlbumByArtistAndTitle } from "../providers/brainzmashProvider.js";
import { musicbrainzResolveArtistMbidByName } from "./musicbrainz.js";

const youtubeVideoCache = createCache(24 * 3600);

function normalizeArtistAlbumKey(artistName, albumName) {
  const a = String(artistName || "").trim().toLowerCase();
  const b = String(albumName || "").trim().toLowerCase();
  return `aa:${a}\0${b}`;
}

export async function resolveDeezerAlbumToMbid(
  artistName,
  albumName,
  deezerAlbumId,
) {
  const deezerId = String(deezerAlbumId || "").replace(/^dz-/, "").trim();
  const dzKey = deezerId ? `dz:${deezerId}` : null;
  const aaKey = normalizeArtistAlbumKey(artistName, albumName);
  const cached =
    (dzKey && dbOps.getDeezerMbidCache(dzKey)) || dbOps.getDeezerMbidCache(aaKey);
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

export async function resolveArtistAndAlbumMbids({ artistName, albumName, deezerAlbumId }) {
  const artist = String(artistName || "").trim();
  const album = String(albumName || "").trim();
  const [artistMbid, albumMbid] = await Promise.all([
    musicbrainzResolveArtistMbidByName(artist),
    album ? resolveDeezerAlbumToMbid(artist, album, deezerAlbumId) : null,
  ]);
  return { artistMbid: artistMbid || null, albumMbid: albumMbid || null };
}
export async function youtubeFindTopSongVideo(artistName, trackTitle) {
  const artist = String(artistName || "").trim();
  const title = String(trackTitle || "").trim();
  if (!artist || !title) return null;

  const cacheKey = `${artist.toLowerCase()}\0${title.toLowerCase()}`;
  const cached = youtubeVideoCache.get(cacheKey);
  if (cached !== undefined) return cached;

  try {
    const query = `${artist} ${title} official video`;
    const response = await axios.get("https://www.youtube.com/results", {
      params: { search_query: query },
      timeout: 5000,
      headers: {
        "Accept-Language": "en-US,en;q=0.9",
        "User-Agent":
          "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36",
      },
    });
    const matches = [
      ...String(response.data || "").matchAll(
        /"videoId":"([a-zA-Z0-9_-]{11})"/g,
      ),
    ];
    const videoId = [...new Set(matches.map((match) => match[1]))][0] || null;
    const result = videoId
      ? {
          videoId,
          embedUrl: `https://www.youtube-nocookie.com/embed/${videoId}`,
          query,
        }
      : null;
    youtubeVideoCache.set(cacheKey, result);
    return result;
  } catch (e) {
    youtubeVideoCache.set(cacheKey, null, 300);
    return null;
  }
}

export { youtubeVideoCache };
