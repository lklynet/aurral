import type { D1Database } from "@cloudflare/workers-types/index.ts";
import * as v from "valibot";

const DEFAULT_TRACK_MS = 4 * 60_000;
const MAX_TRACK_MS = 30 * 60_000;
const TOP_LIMIT = 10;

const text = v.pipe(
  v.string(),
  v.trim(),
  v.minLength(1),
  v.transform((value) => value.slice(0, 500)),
);
const plays = v.pipe(v.number(), v.integer(), v.minValue(1));
const top = <Entries extends v.ObjectEntries>(entries: Entries) =>
  v.pipe(v.array(v.object({ ...entries, plays })), v.maxLength(TOP_LIMIT));

export const nowPlayingSchema = v.object({
  title: text,
  artist: text,
  album: v.nullish(text),
  durationMs: v.nullish(v.pipe(v.number(), v.integer(), v.minValue(1))),
});

export const topPlaysSchema = v.object({
  artists: top({ name: text }),
  albums: top({ title: text, artist: text }),
  tracks: top({ title: text, artist: text }),
});

export const setNowPlaying = (
  db: D1Database,
  linkId: string,
  { title, artist, album, durationMs }: v.InferOutput<typeof nowPlayingSchema>,
  now = Date.now(),
) =>
  db
    .prepare(
      `INSERT INTO listening (link_id, now_playing, playing_until) VALUES (?, ?, ?)
       ON CONFLICT (link_id) DO UPDATE SET
         now_playing = excluded.now_playing, playing_until = excluded.playing_until`,
    )
    .bind(
      linkId,
      JSON.stringify({ title, artist, album: album ?? null }),
      now + Math.min(durationMs ?? DEFAULT_TRACK_MS, MAX_TRACK_MS),
    )
    .run();

export const setTopPlays = (
  db: D1Database,
  linkId: string,
  snapshot: v.InferOutput<typeof topPlaysSchema>,
  now = Date.now(),
) =>
  db
    .prepare(
      `INSERT INTO listening (link_id, top_plays, top_plays_at) VALUES (?, ?, ?)
       ON CONFLICT (link_id) DO UPDATE SET
         top_plays = excluded.top_plays, top_plays_at = excluded.top_plays_at`,
    )
    .bind(linkId, JSON.stringify(snapshot), now)
    .run();

export const clearListening = (db: D1Database, linkId: string) =>
  db.prepare("DELETE FROM listening WHERE link_id = ?").bind(linkId).run();
