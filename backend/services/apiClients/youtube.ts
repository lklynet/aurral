import createCache from "./simpleCache.ts";
import { ytdlpClient } from "../ytdlpClient.ts";
import { compareRecording, MATCH_POLICY } from "../trackMatching/nativeMatcher.ts";
import { parseYoutubeTitle, readYoutubeUpload } from "../trackMatching/youtubeEvidence.ts";

export const youtubeVideoCache = createCache(24 * 3600);
const inflight = new Map<string, ReturnType<typeof findVideo>>();
const liveStatuses = new Set(["is_live", "was_live", "post_live", "is_upcoming"]);

type YoutubeSearchResult = Awaited<ReturnType<typeof ytdlpClient.search>>[number];

function videoPreference(result: YoutubeSearchResult, artistChannel: string | null) {
  const title = result.title;
  const type = /\blyrics?\b/iu.test(title)
    ? 1
    : /\bvisuali[sz]er\b/iu.test(title)
      ? 2
      : /\b(?:video|mv|clip)\b/iu.test(title)
        ? 0
        : 3;
  return (artistChannel ? 0 : 4) + type;
}

async function findVideo(artist: string, title: string) {
  const results = await ytdlpClient.search(`${artist} ${title} official music video`, {
    limit: 10,
    timeoutMs: 15000,
  });
  const request = { title, artists: [artist] };
  const matches = results
    .flatMap((result) => {
      if (!/^[a-zA-Z0-9_-]{11}$/u.test(result.id) || liveStatuses.has(result.liveStatus)) return [];
      const parsed = parseYoutubeTitle(result.title, [artist], title);
      const upload = readYoutubeUpload(result.title, result.channel, [artist]);
      const comparison = compareRecording(request, {
        title: parsed.title,
        versionTitle: parsed.versionTitle,
        artists: [parsed.artist || upload.channelArtist].filter(Boolean),
      });
      if (
        comparison.contradictions.length ||
        comparison.titleSimilarity !== 1 ||
        comparison.artistSimilarity == null ||
        comparison.artistSimilarity < MATCH_POLICY.minArtistSimilarity
      )
        return [];
      return [{ result, preference: videoPreference(result, upload.channelArtist) }];
    })
    .sort((a, b) => a.preference - b.preference);
  const match = matches[0]?.result;
  return match
    ? {
        videoId: match.id,
        embedUrl: `https://www.youtube-nocookie.com/embed/${match.id}`,
      }
    : null;
}

export async function youtubeFindTopSongVideo(
  artistName: string | null | undefined,
  trackTitle: string | null | undefined,
) {
  const artist = String(artistName || "").trim();
  const title = String(trackTitle || "").trim();
  if (!artist || !title) return null;
  const key = `${artist.toLowerCase()}\0${title.toLowerCase()}`;
  const cached: Awaited<ReturnType<typeof findVideo>> | undefined = youtubeVideoCache.get(key);
  if (cached !== undefined) return cached;
  const existing = inflight.get(key);
  if (existing) return existing;
  const lookup = findVideo(artist, title)
    .then((video) => {
      youtubeVideoCache.set(key, video, video ? 24 * 3600 : 300);
      return video;
    })
    .finally(() => inflight.delete(key));
  inflight.set(key, lookup);
  return lookup;
}
