import assert from "node:assert/strict";
import { afterAll, afterEach, beforeEach, test, vi } from "vite-plus/test";
import type { RequestUser } from "../../backend/middleware/requestUser.ts";
import { signedInAs } from "../helpers/honoApp.ts";
import {
  cleanupIsolatedState,
  resetDatabase,
  setupIsolatedBackend,
} from "../helpers/backendTestHarness.ts";
import { wrappedPeriod, type WrappedPlay } from "../../backend/services/wrapped/metrics.ts";

process.env.AURRAL_BACKGROUND_WORKER_GROUP = "library";

const [state, { db }, { userOps }, history, reports, lastfm, { default: wrapped }] =
  await setupIsolatedBackend(
    "wrapped-history",
    () => import("../../backend/config/db-sqlite.ts"),
    () => import("../../backend/db/helpers/index.ts"),
    () => import("../../backend/services/wrapped/history.ts"),
    () => import("../../backend/services/wrapped/reports.ts"),
    () => import("../../backend/services/apiClients/lastfm.ts"),
    () => import("../../backend/routes/wrapped.ts"),
  );

const period = wrappedPeriod(2026, "UTC", Date.parse("2027-01-01T00:00:00Z"));
const LAUNCHED = Date.parse("2026-12-02T15:00:00Z");
const json = (body: unknown, method = "POST") => ({
  method,
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify(body),
});

let one: RequestUser;
let two: RequestUser;

const listen = (userId: number, playedAt: number, title = "Song") =>
  db
    .prepare(
      "INSERT INTO play_events (user_id, track_id, title, artist, duration_ms, played_at, source, created_at) VALUES (?, 'track', ?, 'Artist', 180000, ?, 'native-player', ?)",
    )
    .run(userId, title, playedAt, playedAt);

const pendingBuilds = () =>
  db
    .prepare<[], { count: number }>(
      "SELECT COUNT(*) AS count FROM _honker_live WHERE json_extract(payload, '$.kind') = 'wrapped-build'",
    )
    .get()?.count;

beforeEach(() => {
  resetDatabase(db);
  vi.useFakeTimers({ toFake: ["Date"], now: LAUNCHED });
  for (const name of ["one", "two"]) userOps.createUser(name, "hash");
  const [first, second] = ["one", "two"].map((name) => userOps.getUserByUsername(name)!);
  one = { id: first.id, username: "one", role: "user", permissions: { accessFlow: true } };
  two = { id: second.id, username: "two", role: "user", permissions: {} };
});

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

afterAll(async () => {
  delete process.env.AURRAL_BACKGROUND_WORKER_GROUP;
  await cleanupIsolatedState(state);
});

test("Wrapped stays hidden before release and requires a signed-in user account", async () => {
  vi.setSystemTime(Date.parse("2026-11-30T23:59:59Z"));
  assert.equal(
    (await signedInAs(one).route("/", wrapped).request("/wrapped?timeZone=UTC")).status,
    404,
  );
  vi.setSystemTime(LAUNCHED);
  assert.equal(
    (await signedInAs(undefined).route("/", wrapped).request("/wrapped?timeZone=UTC")).status,
    401,
  );
  const service = { id: -1, username: "api", role: "admin", permissions: {} } as const;
  assert.equal(
    (await signedInAs(service).route("/", wrapped).request("/wrapped?timeZone=UTC")).status,
    403,
  );
  assert.equal(
    (await signedInAs(one).route("/", wrapped).request("/wrapped?timeZone=Not/AZone")).status,
    400,
  );
});

test("opening Wrapped starts one build and shows only the listener's own recap", async () => {
  listen(one.id, Date.parse("2026-06-01T12:00:00Z"));
  listen(two.id, Date.parse("2026-06-02T12:00:00Z"), "Other");
  const app = signedInAs(one).route("/", wrapped);

  const first = await (await app.request("/wrapped?timeZone=UTC")).json();
  assert.equal(first.building, true);
  assert.equal(first.summary, null);
  await app.request("/wrapped?timeZone=UTC");
  assert.equal(pendingBuilds(), 1);

  await reports.processWrappedBuild(one.id, "UTC");
  const ready = await (await app.request("/wrapped?timeZone=UTC")).json();
  assert.equal(ready.summary.totalPlays, 1);
  assert.equal(ready.summary.topSongs[0].name, "Song");
  assert.equal(ready.summary.end, Date.parse("2026-12-01T00:00:00Z"));
});

test("hiding the banner sticks to the account and resets for the next year's Wrapped", async () => {
  listen(one.id, Date.parse("2026-06-01T12:00:00Z"));
  await reports.processWrappedBuild(one.id, "UTC");
  await reports.processWrappedBuild(two.id, "UTC");
  const app = signedInAs(one).route("/", wrapped);

  const hidden = await app.request(
    "/wrapped/banner",
    json({ hidden: true, timeZone: "UTC" }, "PUT"),
  );
  assert.equal((await hidden.json()).bannerHidden, true);
  const other = await signedInAs(two).route("/", wrapped).request("/wrapped?timeZone=UTC");
  assert.equal((await other.json()).bannerHidden, false);

  vi.setSystemTime(Date.parse("2027-12-01T00:00:00Z"));
  await reports.processWrappedBuild(one.id, "UTC");
  const nextYear = await (await app.request("/wrapped?timeZone=UTC")).json();
  assert.equal(nextYear.year, 2027);
  assert.equal(nextYear.bannerHidden, false);
});

test("a recap built on another release channel is rebuilt with this channel's cutoff", async () => {
  db.prepare(
    "INSERT INTO wrapped_reports (user_id, year, cutoff, time_zone, summary, built_at) VALUES (?, 2026, ?, 'UTC', '{}', 0)",
  ).run(one.id, Date.parse("2026-10-27T00:00:00Z"));
  const response = await signedInAs(one).route("/", wrapped).request("/wrapped?timeZone=UTC");
  const body = await response.json();
  assert.equal(body.summary, null);
  assert.equal(body.building, true);
});

test("a failed rebuild keeps the recap the listener already has", async () => {
  listen(one.id, Date.parse("2026-06-01T12:00:00Z"));
  await reports.processWrappedBuild(one.id, "UTC");
  const build = vi
    .spyOn(history, "buildWrappedSummary")
    .mockRejectedValueOnce(new Error("Last.fm is down"));
  await reports.processWrappedBuild(one.id, "UTC");
  build.mockRestore();
  const body = await (
    await signedInAs(one).route("/", wrapped).request("/wrapped?timeZone=UTC")
  ).json();
  assert.equal(body.summary.totalPlays, 1);
  assert.match(body.error, /could not be collected/);
});

test("saving the playlist reports songs that are not in the Library", async () => {
  listen(one.id, Date.parse("2026-06-01T12:00:00Z"));
  await reports.processWrappedBuild(one.id, "UTC");
  const response = await signedInAs(one)
    .route("/", wrapped)
    .request("/wrapped/playlist", json({ timeZone: "UTC" }));
  assert.equal(response.status, 409);
  assert.match((await response.json()).error, /Library/);
});

test("local history stays scoped to the listener and the calendar year", () => {
  listen(one.id, period.start);
  listen(two.id, period.start);
  listen(one.id, period.end);
  assert.equal(history.readLocalWrappedHistory(one.id, period).length, 1);
});

test("a source that fails partway keeps the pages it already read", async () => {
  const play: WrappedPlay = {
    source: "lastfm",
    account: "one",
    id: "one",
    title: "Song",
    artist: "Artist",
    playedAt: period.start,
  };
  const result = await history.readWrappedSource("lastfm", async (page) => {
    if (page === 2) throw new Error("unavailable");
    return { plays: [play], more: true };
  });
  assert.equal(result.status.state, "partial");
  assert.equal(result.plays.length, 1);
});

test("Last.fm history leaves out the track that is playing right now", async () => {
  vi.spyOn(lastfm, "lastfmRequest").mockResolvedValue({
    recenttracks: {
      "@attr": { totalPages: "1" },
      track: [
        { name: "Song", artist: { "#text": "Artist" }, date: { uts: String(period.start / 1000) } },
        { name: "Now playing", artist: { "#text": "Artist" }, "@attr": { nowplaying: "true" } },
      ],
    },
  });
  const result = await history.readWrappedSource(
    "lastfm",
    history.lastfmWrappedReader("one", period),
  );
  assert.deepEqual(
    result.plays.map((play) => play.title),
    ["Song"],
  );
});

test("ListenBrainz paging keeps listens that share the boundary second", async () => {
  const listenbrainz = await import("../../backend/services/apiClients/listenbrainz.ts");
  const end = Math.floor(period.end / 1000) - 1;
  const row = (timestamp: number) => ({
    listened_at: timestamp,
    recording_msid: String(timestamp),
    track_metadata: { track_name: "Song", artist_name: "Artist" },
  });
  vi.spyOn(listenbrainz, "listenbrainzRequest")
    .mockResolvedValueOnce({
      payload: { listens: Array.from({ length: 1000 }, (_, index) => row(end - index * 600)) },
    })
    .mockResolvedValueOnce({ payload: { listens: [row(end - 999 * 600), row(end - 1000 * 600)] } });
  const result = await history.readWrappedSource(
    "listenbrainz",
    history.listenbrainzWrappedReader("one", period),
  );
  const { mergeWrappedPlays } = await import("../../backend/services/wrapped/metrics.ts");
  assert.equal(mergeWrappedPlays(result.plays).length, 1001);
});

test("Navidrome looks up song details in batches", async () => {
  const { NavidromeClient } = await import("../../backend/services/navidrome.ts");
  const client = new NavidromeClient("http://127.0.0.1", "one", "password");
  const scrobbles = Array.from({ length: 150 }, (_, index) => ({
    id: index,
    mediaFileId: `song-${index}`,
    submissionTime: period.start / 1000 + index * 600,
  }));
  const request = vi.spyOn(client, "_nativeRequest").mockImplementation(async (_method, path) => {
    if (path.startsWith("/api/scrobble")) return scrobbles;
    const ids = new URLSearchParams(path.split("?")[1]).getAll("id");
    return ids.map((id) => ({ id, title: id, artist: "Artist", duration: 120, mbzArtistId: "a" }));
  });
  const result = await history.readWrappedSource(
    "navidrome",
    history.navidromeReader(client, "one", period),
  );
  assert.equal(result.plays.length, 150);
  assert.equal(result.plays[149].title, "song-149");
  assert.equal(result.plays[0].artistMbid, "a");
  assert.equal(request.mock.calls.length, 3);
});

test("Jellyfin play times are converted from the server's local clock", async () => {
  const { JellyfinClient } = await import("../../backend/services/jellyfin.ts");
  const client = new JellyfinClient("http://127.0.0.1", "key", "one");
  const request = vi
    .spyOn(client, "request")
    .mockResolvedValueOnce({ results: [["-18000"]] })
    .mockResolvedValueOnce({ results: [["2026-01-01 07:00:00.1234567", "song", "65"]] })
    .mockResolvedValueOnce({
      Items: [{ Id: "song", Name: "Song", Artists: ["Artist"], RunTimeTicks: 1800000000 }],
    });
  const result = await history.readWrappedSource(
    "jellyfin",
    history.jellyfinReader(client, "one", period),
  );
  assert.equal(result.plays[0].playedAt, Date.parse("2026-01-01T12:00:00Z"));
  assert.equal(result.plays[0].listenedMs, 65000);

  request.mockRejectedValueOnce(new Error("forbidden")).mockResolvedValueOnce({
    results: [],
    message: "no such table: PlaybackActivity",
  });
  const failed = await history.readWrappedSource(
    "jellyfin",
    history.jellyfinReader(client, "one", period),
  );
  assert.equal(failed.status.state, "unavailable");
});

test("a cover's color favors its vivid area over a larger plain background", () => {
  const pixels = [
    ...Array.from({ length: 60 }, () => [12, 12, 12]),
    ...Array.from({ length: 30 }, () => [240, 40, 120]),
  ].flat();
  assert.equal(history.vividColor(Uint8Array.from(pixels)), "#f02878");
  assert.equal(history.vividColor(Uint8Array.from([12, 12, 12, 12, 12, 12])), "#0c0c0c");
});
