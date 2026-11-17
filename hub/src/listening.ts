import type { D1Database } from "@cloudflare/workers-types/index.ts";
import * as v from "valibot";

const DEFAULT_TRACK_MS = 4 * 60_000;
const MAX_TRACK_MS = 30 * 60_000;
const TOP_LIMIT = 10;
const TOP_PLAYS_FRESH_MS = 7 * 86_400_000;

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

type TopPlays = v.InferOutput<typeof topPlaysSchema>;
type Listening = {
  nowPlaying: { title: string; artist: string; album: string | null } | null;
  topPlays: TopPlays | null;
};
export type ListeningRow = {
  handle: string;
  now_playing: string | null;
  playing_until: number | null;
  top_plays: string | null;
  top_plays_at: number | null;
};

const storedNowPlaying = v.object({
  title: v.string(),
  artist: v.string(),
  album: v.nullable(v.string()),
});

const stored = <Schema extends v.GenericSchema>(schema: Schema, json: string | null) => {
  try {
    const parsed = v.safeParse(schema, JSON.parse(json ?? "null"));
    return parsed.success ? parsed.output : null;
  } catch {
    return null;
  }
};

const sum = <Entry extends { plays: number }>(
  lists: Entry[][],
  key: (entry: Entry) => string,
  limit: number,
) => {
  const totals = new Map<string, Entry>();
  for (const entry of lists.flat()) {
    const seen = totals.get(key(entry));
    totals.set(key(entry), seen ? { ...seen, plays: seen.plays + entry.plays } : entry);
  }
  return [...totals.values()].sort((a, b) => b.plays - a.plays).slice(0, limit);
};

const lower = (...parts: string[]) => parts.map((part) => part.toLowerCase()).join("\u0000");

export function mergeTopPlays(snapshots: TopPlays[]): TopPlays | null {
  if (!snapshots.length) return null;
  return {
    artists: sum(
      snapshots.map((top) => top.artists),
      (entry) => lower(entry.name),
      5,
    ),
    albums: sum(
      snapshots.map((top) => top.albums),
      (entry) => lower(entry.artist, entry.title),
      5,
    ),
    tracks: sum(
      snapshots.map((top) => top.tracks),
      (entry) => lower(entry.artist, entry.title),
      TOP_LIMIT,
    ),
  };
}

export async function friendsListening(db: D1Database, accountId: string, now = Date.now()) {
  const { results } = await db
    .prepare(
      `SELECT handles.handle, listening.now_playing, listening.playing_until,
         listening.top_plays, listening.top_plays_at
       FROM friends AS asked
       JOIN friends AS back ON back.account_id = asked.friend_id AND back.friend_id = asked.account_id
       JOIN handles ON handles.account_id = asked.friend_id
       JOIN links ON links.account_id = asked.friend_id
       JOIN listening ON listening.link_id = links.id
       WHERE asked.account_id = ?1 AND (listening.playing_until > ?2 OR listening.top_plays_at > ?3)`,
    )
    .bind(accountId, now, now - TOP_PLAYS_FRESH_MS)
    .all<ListeningRow>();
  const byHandle = new Map<
    string,
    { until: number; nowPlaying: Listening["nowPlaying"]; snapshots: TopPlays[] }
  >();
  for (const row of results) {
    const entry = byHandle.get(row.handle) ?? { until: 0, nowPlaying: null, snapshots: [] };
    const until = row.playing_until ?? 0;
    if (until > now && until > entry.until) {
      const playing = stored(storedNowPlaying, row.now_playing);
      if (playing) Object.assign(entry, { until, nowPlaying: playing });
    }
    const top =
      (row.top_plays_at ?? 0) > now - TOP_PLAYS_FRESH_MS && stored(topPlaysSchema, row.top_plays);
    if (top) entry.snapshots.push(top);
    byHandle.set(row.handle, entry);
  }
  return new Map(
    [...byHandle].map(([handle, { nowPlaying, snapshots }]): [string, Listening] => [
      handle,
      { nowPlaying, topPlays: mergeTopPlays(snapshots) },
    ]),
  );
}
