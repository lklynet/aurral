import * as v from "valibot";
import type { albumQuery, trackQuery } from "./sourcePipeline.ts";

const MAX_RESULTS = 50;
const MAX_FILES = 1000;

const text = v.pipe(v.string(), v.trim(), v.minLength(1), v.maxLength(500));
export const trackResult = v.object({
  id: text,
  title: text,
  artist: text,
  album: v.nullish(v.pipe(v.string(), v.maxLength(500))),
  durationMs: v.nullish(v.pipe(v.number(), v.minValue(0))),
  format: v.nullish(v.pipe(v.string(), v.maxLength(20))),
  bitrate: v.nullish(v.pipe(v.number(), v.minValue(0))),
  data: v.optional(v.unknown()),
});
export const searchResults = v.pipe(v.array(trackResult), v.maxLength(MAX_RESULTS));
const albumResult = v.object({
  id: text,
  title: text,
  artist: text,
  year: v.nullish(v.pipe(v.number(), v.integer())),
  trackCount: v.nullish(v.pipe(v.number(), v.integer(), v.minValue(0))),
  format: v.nullish(v.pipe(v.string(), v.maxLength(20))),
  bitrate: v.nullish(v.pipe(v.number(), v.minValue(0))),
  data: v.optional(v.unknown()),
});
export const albumResults = v.pipe(v.array(albumResult), v.maxLength(MAX_RESULTS));
const pending = v.pipe(v.string(), v.minLength(1), v.maxLength(500));
const filePathText = v.pipe(v.string(), v.minLength(1));
export const trackDownloadResult = v.union([
  v.object({ path: filePathText }),
  v.object({ pending }),
]);
export const albumDownloadResult = v.nullish(v.object({ pending: v.optional(pending) }), {});
export const fileResults = v.nullable(
  v.pipe(
    v.array(v.object({ path: filePathText, size: v.pipe(v.number(), v.minValue(0)) })),
    v.maxLength(MAX_FILES),
  ),
);
export const statusResult = v.object({
  done: v.boolean(),
  path: v.optional(filePathText),
  imported: v.optional(filePathText),
});

export type TrackResult = v.InferOutput<typeof trackResult>;
export type AlbumResult = v.InferOutput<typeof albumResult>;

export type TrackQuery = ReturnType<typeof trackQuery>;
export type AlbumQuery = Awaited<ReturnType<typeof albumQuery>>;
export type Upgrade = { currentTier: string | null } | null;

// A failure the source expects, like a search that found nothing or a client
// that rejected the download. The pipeline moves on to the next result or
// source. Any other error fails the step, and the queue retries it.
export class DownloadSourceError extends Error {}

// Plugins and native sources implement this. Aurral matches, judges, stages,
// and files what a source returns, so a source only finds and fetches. A
// source that downloads on its own returns `pending`, and Aurral asks its
// `status` until the download is done. One that files its own downloads,
// like Lidarr, names the folder it `imported` them to, and Aurral uses those
// files where they are. An upgrade search names the quality
// the current file has. A source without `tracks` serves a track from an
// album download. One with `albums.files` downloads only the files Aurral
// keeps: `list` is null until the source knows the files, and then `keep`
// names the files to download, every file when Aurral can't tell.
export type DownloadSource = {
  id: string;
  staging: string;
  tracks?: {
    search: (track: TrackQuery, upgrade: Upgrade) => Promise<TrackResult[]>;
    download: (input: {
      result: TrackResult;
      directory: string;
    }) => Promise<v.InferOutput<typeof trackDownloadResult>>;
  };
  albums?: {
    search: (album: AlbumQuery, upgrade: Upgrade) => Promise<AlbumResult[]>;
    download: (input: {
      result: AlbumResult;
      album: AlbumQuery;
      directory: string;
    }) => Promise<v.InferOutput<typeof albumDownloadResult>>;
    files?: {
      list: (id: string) => Promise<v.InferOutput<typeof fileResults>>;
      keep: (input: { id: string; paths: string[] }) => Promise<void>;
    };
  };
  status: (input: { id: string; directory: string }) => Promise<v.InferOutput<typeof statusResult>>;
  discard?: (id: string) => Promise<void>;
};
