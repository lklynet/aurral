import createCache from "./simpleCache.js";
import { ytdlpClient } from "../ytdlpClient.js";
import { compareRecording, MATCH_POLICY } from "../trackMatching/nativeMatcher.js";
import { parseYoutubeTitle, readYoutubeUpload } from "../trackMatching/youtubeEvidence.js";

export const youtubeVideoCache = createCache(24 * 3600);
const inflight = new Map();
const liveStatuses = new Set(["is_live", "was_live", "post_live", "is_upcoming"]);

function videoPreference(result, artistChannel) {
  const title = result.title;
  const type = /\blyrics?\b/iu.test(title) ? 1
    : /\bvisuali[sz]er\b/iu.test(title) ? 2
      : /\b(?:video|mv|clip)\b/iu.test(title) ? 0 : 3;
  return (artistChannel ? 0 : 4) + type;
}

async function findVideo(artist, title) {
  const results = await ytdlpClient.search(`${artist} ${title} official music video`, {
    limit: 10,
    timeoutMs: 15000,
  });
  const request = { title, artists: [artist] };
  const matches = results.flatMap(result => {
    if (!/^[a-zA-Z0-9_-]{11}$/u.test(result.id) || liveStatuses.has(result.liveStatus)) return [];
    const parsed = parseYoutubeTitle(result.title, [artist], title);
    const upload = readYoutubeUpload(result.title, result.channel, [artist]);
    const comparison = compareRecording(request, {
      title: parsed.title,
      versionTitle: parsed.versionTitle,
      artists: [parsed.artist || upload.channelArtist].filter(Boolean),
    });
    if (comparison.contradictions.length || comparison.titleSimilarity !== 1
      || comparison.artistSimilarity < MATCH_POLICY.minArtistSimilarity
      || comparison.artistSimilarity == null) return [];
    return [{ result, preference: videoPreference(result, upload.channelArtist) }];
  }).sort((a, b) => a.preference - b.preference);
  const match = matches[0]?.result;
  return match ? {
    videoId: match.id,
    embedUrl: `https://www.youtube-nocookie.com/embed/${match.id}`,
  } : null;
}

export async function youtubeFindTopSongVideo(artistName, trackTitle) {
  const artist = String(artistName || "").trim();
  const title = String(trackTitle || "").trim();
  if (!artist || !title) return null;
  const key = `${artist.toLowerCase()}\0${title.toLowerCase()}`;
  const cached = youtubeVideoCache.get(key);
  if (cached !== undefined) return cached;
  if (inflight.has(key)) return inflight.get(key);
  const lookup = findVideo(artist, title).then(video => {
    youtubeVideoCache.set(key, video, video ? 24 * 3600 : 300);
    return video;
  }).finally(() => inflight.delete(key));
  inflight.set(key, lookup);
  return lookup;
}
