import * as v from "valibot";
import { db, dbHelpers } from "../../config/db-sqlite.ts";
import { APP_VERSION } from "../../config/constants.ts";
import { userOps } from "../../db/helpers/index.ts";
import type { LibraryTracksRow, WrappedReportsRow } from "../../db/rows.ts";
import { wrappedSeason, type WrappedSeason } from "../../../lib/wrapped.ts";
import { enqueueSystemTaskJob, findActiveHonkerJob, getSystemTaskQueueName } from "../honkerDb.ts";
import { findCachedImageUrl, warmPublicImageUrl } from "../imageProxyService.ts";
import { logger } from "../logger.ts";
import { subsonicId } from "../libraryMediaStore.ts";
import { createSubsonicPlaylist } from "../subsonicLibraryService.ts";
import type { RequestUser } from "../../middleware/requestUser.ts";
import { wrappedPeriod } from "./metrics.ts";

const BUILD_KIND = "wrapped-build";

const readReport = db.prepare<[number], WrappedReportsRow>(
  "SELECT * FROM wrapped_reports WHERE user_id = ?",
);
const saveReport = db.prepare<
  [number, number, number, string, string | null, string | null, number]
>(`
  INSERT INTO wrapped_reports (user_id, year, cutoff, time_zone, summary, error, built_at)
  VALUES (?, ?, ?, ?, ?, ?, ?)
  ON CONFLICT(user_id) DO UPDATE SET
    banner_hidden = CASE WHEN year = excluded.year THEN banner_hidden ELSE 0 END,
    summary = CASE
      WHEN excluded.summary IS NULL AND year = excluded.year AND cutoff = excluded.cutoff
      THEN summary ELSE excluded.summary END,
    year = excluded.year,
    cutoff = excluded.cutoff,
    time_zone = excluded.time_zone,
    error = excluded.error,
    built_at = excluded.built_at
`);
const setBannerHidden = db.prepare<[number, number]>(
  "UPDATE wrapped_reports SET banner_hidden = ? WHERE user_id = ?",
);

const SUMMARY_VERSION = 4;

const leader = v.nullable(
  v.looseObject({ name: v.string(), artist: v.string(), plays: v.number() }),
);
const rankedRow = {
  key: v.string(),
  name: v.string(),
  artist: v.string(),
  album: v.nullable(v.string()),
  plays: v.number(),
  minutes: v.number(),
  firstPlayedAt: v.number(),
  artwork: v.nullable(v.string()),
  color: v.nullable(v.string()),
  preview: v.nullable(v.string()),
  beats: v.nullable(
    v.looseObject({
      start: v.number(),
      bpm: v.number(),
      beats: v.array(v.number()),
      downbeat: v.number(),
    }),
  ),
  libraryTrackId: v.nullable(v.number()),
  libraryAlbumId: v.nullable(v.number()),
};
const storedSummarySchema = v.looseObject({
  version: v.literal(SUMMARY_VERSION),
  year: v.number(),
  timeZone: v.string(),
  totalPlays: v.number(),
  minutes: v.nullable(v.number()),
  uniqueArtists: v.number(),
  uniqueSongs: v.number(),
  uniqueAlbums: v.number(),
  activeDays: v.number(),
  longestStreak: v.nullable(
    v.looseObject({ days: v.number(), start: v.string(), end: v.string() }),
  ),
  topArtists: v.array(v.looseObject(rankedRow)),
  topSongs: v.array(v.looseObject(rankedRow)),
  topAlbums: v.array(v.looseObject({ ...rankedRow, songs: v.number() })),
  topGenres: v.array(v.looseObject({ name: v.string(), plays: v.number() })),
  busiestDay: v.nullable(v.looseObject({ date: v.string(), plays: v.number(), topSong: leader })),
  months: v.array(v.looseObject({ month: v.string(), plays: v.number(), topArtist: leader })),
  hours: v.array(v.number()),
  calendar: v.array(v.number()),
  sources: v.array(v.looseObject({ state: v.picklist(["ready", "partial", "unavailable"]) })),
});

export const currentWrappedSeason = (now = Date.now()) => wrappedSeason(APP_VERSION, now);

const activeBuild = (userId: number) =>
  findActiveHonkerJob(getSystemTaskQueueName(BUILD_KIND), (payload) => payload?.userId === userId, {
    payloadKind: BUILD_KIND,
    recoverExpired: true,
  });

function startBuild(userId: number, timeZone: string) {
  if (!activeBuild(userId)) enqueueSystemTaskJob({ kind: BUILD_KIND, userId, timeZone });
}

function cachedArtwork<Row extends { artwork: string | null }>(rows: Row[]) {
  return rows.map((row) => {
    if (!row.artwork?.startsWith("http")) return row;
    const local = findCachedImageUrl(row.artwork);
    if (local) return { ...row, artwork: local };
    void warmPublicImageUrl(row.artwork);
    return row;
  });
}

export function getWrapped(season: WrappedSeason, userId: number, timeZone: string) {
  const stored = readReport.get(userId);
  const parsed = dbHelpers.parseJSON(stored?.summary);
  const summary = v.is(storedSummarySchema, parsed)
    ? {
        ...parsed,
        topSongs: cachedArtwork(parsed.topSongs),
        topArtists: cachedArtwork(parsed.topArtists),
        topAlbums: cachedArtwork(parsed.topAlbums),
      }
    : null;
  const row =
    stored?.year === season.year &&
    (season.preview || stored.cutoff === season.cutoff) &&
    (summary || stored.error)
      ? stored
      : null;
  if (!row) startBuild(userId, timeZone);
  return {
    year: season.year,
    preview: season.preview,
    building: !row || Boolean(activeBuild(userId)),
    bannerHidden: row?.banner_hidden === 1,
    error: row?.error ?? null,
    summary: row ? summary : null,
  };
}

export function rebuildWrapped(season: WrappedSeason, userId: number, timeZone: string) {
  startBuild(userId, timeZone);
  return getWrapped(season, userId, timeZone);
}

export function hideWrappedBanner(
  season: WrappedSeason,
  userId: number,
  timeZone: string,
  hidden: boolean,
) {
  setBannerHidden.run(hidden ? 1 : 0, userId);
  return getWrapped(season, userId, timeZone);
}

export async function processWrappedBuild(userId: number, timeZone: string) {
  const season = currentWrappedSeason();
  if (!season || userOps.getUserById(userId)?.status !== "active") return;
  const { buildWrappedSummary } = await import("./history.ts");
  let summary: string | null = null;
  let error: string | null = null;
  try {
    summary = JSON.stringify({
      ...(await buildWrappedSummary(userId, wrappedPeriod(season.year, timeZone, season.cutoff))),
      version: SUMMARY_VERSION,
    } satisfies v.InferInput<typeof storedSummarySchema>);
  } catch (cause) {
    logger.warn("wrapped", "Recap build failed", { userId, cause: String(cause) });
    error = "Your listening history could not be collected. Check your connections and try again.";
  }
  saveReport.run(userId, season.year, season.cutoff, timeZone, summary, error, Date.now());
}

export async function saveWrappedPlaylist(
  season: WrappedSeason,
  user: RequestUser,
  timeZone: string,
) {
  const wrapped = getWrapped(season, user.id, timeZone);
  if (!wrapped.summary) return { error: "Build your recap first" } as const;
  const trackIds = wrapped.summary.topSongs.flatMap((song) =>
    song.libraryTrackId ? [song.libraryTrackId] : [],
  );
  const keys = new Map(
    trackIds.length
      ? db
          .prepare<number[], Pick<LibraryTracksRow, "id" | "identity_key">>(
            `SELECT id, identity_key FROM library_tracks WHERE id IN (${trackIds.map(() => "?").join(",")})`,
          )
          .all(...trackIds)
          .map((row) => [row.id, row.identity_key])
      : [],
  );
  const songIds = trackIds.flatMap((id) => {
    const key = keys.get(id);
    return key ? [subsonicId("song", key)] : [];
  });
  if (!songIds.length) return { error: "None of these songs are in your Library" } as const;
  const playlist = await createSubsonicPlaylist(user, {
    name: `Your Top Songs ${wrapped.year}`,
    songIds,
  });
  if (!playlist)
    return { error: "Your Library changed. Rebuild your recap and try again." } as const;
  return {
    playlistId: playlist.id,
    trackCount: songIds.length,
    missingCount: wrapped.summary.topSongs.length - songIds.length,
  };
}
