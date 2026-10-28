import axios from "../../../lib/axiosFetch.ts";
import { APP_NAME, APP_VERSION } from "../../config/constants.ts";
import createCache from "./simpleCache.ts";

const LRCLIB_API = "https://lrclib.net/api";
export const lrclibCache = createCache(24 * 3600, 2000);
const lrclibInflight = new Map<string, Promise<string | null>>();

type LrclibTrack = {
  instrumental?: boolean;
  plainLyrics?: string | null;
  syncedLyrics?: string | null;
};

export function lrclibGetLyrics({
  artist,
  title,
  album,
  durationSec,
}: {
  artist: string;
  title: string;
  album?: string | null;
  durationSec?: number | null;
}) {
  const params = {
    artist_name: artist.trim(),
    track_name: title.trim(),
    ...(album?.trim() ? { album_name: album.trim() } : {}),
    ...(durationSec && durationSec > 0 ? { duration: Math.round(durationSec) } : {}),
  };
  if (!params.artist_name || !params.track_name) return Promise.resolve(null);
  const key = JSON.stringify(params).toLowerCase();
  const cached: string | null | undefined = lrclibCache.get(key);
  if (cached !== undefined) return Promise.resolve(cached);
  const existing = lrclibInflight.get(key);
  if (existing) return existing;
  const lookup = axios
    .get(`${LRCLIB_API}/get`, {
      params,
      headers: { "User-Agent": `${APP_NAME}/${APP_VERSION} (https://github.com/lklynet/aurral)` },
      timeout: 5000,
      validateStatus: (status) => status === 200 || status === 404,
    })
    .then((response) => {
      const track: LrclibTrack | null = response.status === 200 ? response.data : null;
      const lyrics = track?.instrumental
        ? null
        : track?.syncedLyrics?.trim() || track?.plainLyrics?.trim() || null;
      lrclibCache.set(key, lyrics);
      return lyrics;
    })
    .catch(() => null)
    .finally(() => lrclibInflight.delete(key));
  lrclibInflight.set(key, lookup);
  return lookup;
}
