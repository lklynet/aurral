import createCache from "./simpleCache.ts";
import { compareRecording, MATCH_POLICY } from "../trackMatching/nativeMatcher.ts";
import { parseYoutubeTitle, readYoutubeUpload } from "../trackMatching/youtubeEvidence.ts";

export const youtubeVideoCache = createCache(24 * 3600);
const inflight = new Map<string, ReturnType<typeof findVideo>>();
const YOUTUBE_REQUEST_TIMEOUT_MS = 10_000;

const createSession = async () => {
  const { Innertube, YTNodes } = await import("youtubei.js");
  const youtube = await Innertube.create({
    lang: "en",
    retrieve_player: false,
    generate_session_locally: true,
    fetch: (input, init) =>
      fetch(input, { ...init, signal: AbortSignal.timeout(YOUTUBE_REQUEST_TIMEOUT_MS) }),
  });
  return { youtube, Video: YTNodes.Video };
};

let session: ReturnType<typeof createSession> | null = null;

const getSession = () => {
  session ??= createSession().catch((error) => {
    session = null;
    throw error;
  });
  return session;
};

export const youtubeVideoSearch = {
  async search(query: string) {
    const { youtube, Video } = await getSession();
    const results = await youtube.search(query, { type: "video" });
    return results.videos.flatMap((node) =>
      node.is(Video)
        ? [
            {
              id: node.video_id,
              title: node.title.toString(),
              channel: node.author?.name || "",
              live: Boolean(
                node.is_live ||
                node.is_upcoming ||
                /^streamed\b/iu.test(node.published?.toString() || ""),
              ),
            },
          ]
        : [],
    );
  },
};

type YoutubeSearchResult = Awaited<ReturnType<typeof youtubeVideoSearch.search>>[number];

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
  const results = await youtubeVideoSearch.search(`${artist} ${title} official music video`);
  const request = { title, artists: [artist] };
  const matches = results
    .slice(0, 10)
    .flatMap((result) => {
      if (!/^[a-zA-Z0-9_-]{11}$/u.test(result.id) || result.live) return [];
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
