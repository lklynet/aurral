import * as v from "valibot";
import { asAppError } from "../../lib/errors.ts";
import {
  DownloadSourceError,
  type DownloadSource,
  type ResolvedTrack,
} from "./download/downloadSource.ts";
import { getDownloadClient } from "./download/downloadClientSettings.ts";
import { buildYtdlpSearchQueries } from "./downloadJobs/ytdlpSearch.ts";
import type { buildResolvedJobTrack } from "./downloadUtils.ts";
import { logger } from "./logger.ts";
import { mergeSearchResults } from "./pipelineHelpers.ts";
import { buildSourceCandidates, prefilterCandidates } from "./trackMatching/index.ts";
import { readYoutubeUpload } from "./trackMatching/youtubeEvidence.ts";
import type { YtdlpClient } from "./ytdlpClient.ts";

const ytdlpClient = getDownloadClient("ytdlp");
const SONG_READS = 6;
const MANUAL_RESULTS = 10;
const LIVE_STATUSES = new Set(["is_live", "was_live", "post_live", "is_upcoming"]);
const video = v.object({ url: v.pipe(v.string(), v.minLength(1)) });

type YtdlpResult = Awaited<ReturnType<YtdlpClient["search"]>>[number];
type YtdlpSearchOptions = NonNullable<Parameters<YtdlpClient["search"]>[1]>;

export function isYtdlpLiveResult(result: Pick<YtdlpResult, "liveStatus">) {
  return LIVE_STATUSES.has(
    String(result?.liveStatus || "")
      .trim()
      .toLowerCase(),
  );
}

// The release audio on the artist's channel is the copy to download, so the
// next query runs until a usable one turns up.
export function hasEnoughCandidates(
  aggregated: YtdlpResult[],
  resolvedTrack: ReturnType<typeof buildResolvedJobTrack>,
) {
  const artistNames = [resolvedTrack.artistName, ...(resolvedTrack.artistAliases || [])].filter(
    Boolean,
  );
  return prefilterCandidates({
    source: "ytdlp",
    candidates: aggregated.filter((result) => !isYtdlpLiveResult(result)),
    request: resolvedTrack,
  }).some(
    (entry) =>
      !entry.rejected &&
      readYoutubeUpload(entry.candidate.title, entry.candidate.provider?.uploader, artistNames)
        .officialAudio,
  );
}

const resultKey = (entry: YtdlpResult) =>
  String(entry.id || entry.url || "")
    .trim()
    .toLowerCase();

// Live streams are not recordings of the requested track. A result keeps
// the channel, song, and live fields the matcher reads.
const toResults = (results: YtdlpResult[]) =>
  results
    .filter((result) => !isYtdlpLiveResult(result))
    .map((result) => ({
      ...result,
      artist: result.channel || result.title,
      durationMs: result.durationSec ? result.durationSec * 1000 : null,
    }));

async function searchTrack(track: ResolvedTrack, denied: ReadonlySet<string>) {
  const { queries, fallbackQuery } = buildYtdlpSearchQueries(track);
  const found: Record<"songs" | "videos", YtdlpResult[]> = { songs: [], videos: [] };
  const seen: Record<"songs" | "videos", Set<string>> = { songs: new Set(), videos: new Set() };
  let lastError = "";
  const searchOnce = async (
    kind: "songs" | "videos",
    query: string,
    options: YtdlpSearchOptions,
  ) => {
    try {
      const results = await ytdlpClient.search(query, options);
      mergeSearchResults(
        found[kind],
        seen[kind],
        results.filter((entry) => !denied.has(String(entry.id || "").trim())),
        resultKey,
      );
    } catch (error) {
      lastError = asAppError(error)?.message || String(error);
      logger.warn("ytdlp", "yt-dlp search failed", { query, error: lastError });
    }
  };
  // A song id is also a video id. Once videos are searched, a video replaces
  // the song with its id, so a song judged off the requested album can still
  // win as the artist's own upload.
  const searchedResults = () => {
    const videoKeys = new Set(found.videos.map(resultKey));
    return [...found.songs.filter((song) => !videoKeys.has(resultKey(song))), ...found.videos];
  };
  const holdsTrack = async (results: YtdlpResult[]) =>
    (
      await buildSourceCandidates({
        source: "ytdlp",
        results: results.filter((result) => !isYtdlpLiveResult(result)),
        request: track,
      })
    ).evaluations.some((entry) => entry.decision === "accept" || entry.decision === "verify");

  // YouTube Music lists the release audio with its artists, album, and
  // length. Its search reads the next few songs only while none read so far
  // could be the track, and video search runs only when none of its songs is.
  if (queries[0]) {
    await searchOnce("songs", queries[0], {
      songs: true,
      limit: SONG_READS,
      wanted: (song) =>
        !denied.has(song.id) &&
        prefilterCandidates({
          source: "ytdlp",
          candidates: [{ ...song, song: true }],
          request: track,
        })[0]?.rejected === false,
      decided: holdsTrack,
    });
  }
  if (!(await holdsTrack(searchedResults()))) {
    for (const query of [...queries, fallbackQuery].filter((value): value is string =>
      Boolean(value),
    )) {
      if (hasEnoughCandidates(found.videos, track)) break;
      if (query === fallbackQuery && found.videos.length > 0) break;
      await searchOnce("videos", query, { limit: 5 });
    }
  }
  const results = searchedResults();
  if (lastError && results.length === 0) throw new DownloadSourceError(lastError);
  return toResults(results);
}

export const ytdlpSource = {
  id: "ytdlp",
  get staging() {
    return ytdlpClient.stagingRoot();
  },
  tracks: {
    search: (track, { denied }) => searchTrack(track, denied),
    async manualSearch(track) {
      const query = [track.artistName, track.trackName, track.albumName].filter(Boolean).join(" ");
      return toResults(await ytdlpClient.search(query, { limit: MANUAL_RESULTS }));
    },
    async download({ result, directory, signal }) {
      if (!v.is(video, result)) throw new DownloadSourceError("No yt-dlp video URL available");
      try {
        return { path: await ytdlpClient.downloadAudio(result.url, { directory, signal }) };
      } catch (error) {
        if (error instanceof DownloadSourceError) throw error;
        throw new DownloadSourceError(asAppError(error)?.message || String(error));
      }
    },
  },
} satisfies DownloadSource;
