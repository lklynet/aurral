import type { Music, Outside, Track } from "./music.ts";

const SEARCH_SUFFIX = /\s+official music video$/i;

// YouTube IDs are 11 URL-safe characters, and a track's number fits in that.
const videoId = (track: Track) => track.number.toString(36).padStart(11, "0");

const text = (value: string) => ({ runs: [{ text: value }] });

const video = (track: Track) => ({
  videoRenderer: {
    videoId: videoId(track),
    title: text(`${track.artist.name} - ${track.title} (Official Music Video)`),
    ownerText: text(track.artist.name),
    publishedTimeText: { simpleText: "3 years ago" },
  },
});

const searchResults = (query: string, music: Music) => ({
  estimatedResults: "1",
  contents: {
    twoColumnSearchResultsRenderer: {
      primaryContents: {
        sectionListRenderer: {
          contents: [
            {
              itemSectionRenderer: {
                contents: music.findTracks(query.replace(SEARCH_SUFFIX, "")).slice(0, 5).map(video),
              },
            },
          ],
        },
      },
    },
  },
});

// Aurral finds artist videos through YouTube's own search API, the one its web player uses.
export const youtube: Outside = {
  hosts: ["www.youtube.com"],
  respond({ url, body }, music) {
    if (url.pathname === "/youtubei/v1/config") return {};
    if (url.pathname !== "/youtubei/v1/search") return undefined;
    const asked: unknown = JSON.parse(body || "{}");
    const query =
      typeof asked === "object" && asked && "query" in asked && typeof asked.query === "string"
        ? asked.query
        : "";
    return searchResults(query, music);
  },
};
