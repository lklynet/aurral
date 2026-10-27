import assert from "node:assert/strict";
import { afterAll, beforeEach, test, vi } from "vite-plus/test";
import express from "express";
import {
  cleanupIsolatedState,
  resetDatabase,
  setupIsolatedBackend,
} from "../helpers/backendTestHarness.ts";
import { wrappedPeriod, type WrappedPlay } from "../../backend/services/wrapped/metrics.ts";
import { createMockHttpServer } from "../helpers/backendTestHarness.ts";
import * as wrappedConfig from "../../lib/wrapped.ts";

const { wrappedSeason } = wrappedConfig;

const [state, { db }, history, lastfm, reports] = await setupIsolatedBackend(
  "wrapped-history",
  () => import("../../backend/config/db-sqlite.ts"),
  () => import("../../backend/services/wrapped/history.ts"),
  () => import("../../backend/services/apiClients/lastfm.ts"),
  () => import("../../backend/services/wrapped/reports.ts"),
);
const period = wrappedPeriod(2026, "UTC", Date.parse("2027-01-01T00:00:00Z"));
const { userOps } = await import("../../backend/db/helpers/index.ts");
const { default: wrappedRouter } = await import("../../backend/routes/wrapped.ts");
const app = express();
app.use(express.json());
app.use((req, _res, next) => {
  const id = Number(req.get("x-test-user"));
  req.user =
    id === -1
      ? { id: -1, username: "api", role: "admin", permissions: {} }
      : userOps.getUserById(id) || undefined;
  next();
});
app.use("/wrapped", wrappedRouter);
const server = await createMockHttpServer(app);
beforeEach(() => {
  resetDatabase(db);
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  vi.spyOn(wrappedConfig, "wrappedSeason").mockImplementation((_appVersion, now) =>
    wrappedSeason("2.0.0", now),
  );
});
afterAll(async () => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  await server.close();
  await cleanupIsolatedState(state);
});

test("the feature stays hidden until release and requires a real user", async () => {
  const clock = vi.spyOn(Date, "now").mockReturnValue(Date.parse("2026-11-30T23:59:59Z"));
  assert.equal((await fetch(`${server.url}/wrapped/2026`)).status, 404);
  clock.mockReturnValue(Date.parse("2026-12-01T00:00:00Z"));
  assert.equal((await fetch(`${server.url}/wrapped/2026`)).status, 401);
  assert.equal(
    (await fetch(`${server.url}/wrapped/2026`, { headers: { "x-test-user": "-1" } })).status,
    403,
  );
});

test("queued builds produce a user-scoped recap and repeated requests reuse it", async () => {
  const now = Date.parse("2026-12-02T15:00:00Z");
  vi.spyOn(Date, "now").mockReturnValue(now);
  db.prepare(
    "INSERT INTO users (id, username, password_hash) VALUES (1, 'one', 'hash'), (2, 'two', 'hash')",
  ).run();
  db.prepare(
    "INSERT INTO play_events (user_id, track_id, title, artist, duration_ms, played_at, source, created_at) VALUES (1, 'track', 'Song', 'Artist', 180000, ?, 'subsonic', ?)",
  ).run(Date.parse("2026-11-30T12:00:00Z"), now);
  const queued = reports.requestWrappedReport(1, 2026, "UTC", now);
  assert.equal(queued.state, "queued");
  assert.equal(reports.requestWrappedReport(1, 2026, "UTC", now).operationId, queued.operationId);
  await reports.processWrappedReport(1, 2026, "UTC", queued.cutoff, queued.requestId);
  const complete = reports.getWrappedReport(1, 2026, "UTC", now);
  assert.equal(complete?.state, "ready");
  if (complete?.state !== "ready") throw new Error("Expected completed report");
  assert.equal(complete.summary.totalPlays, 1);
  assert.equal(complete.summary.listening.minutes, 3);
  assert.equal(reports.getWrappedReport(2, 2026, "UTC", now), null);
  const response = await fetch(`${server.url}/wrapped/2026?timeZone=UTC&userId=1`, {
    headers: { "x-test-user": "2" },
  });
  assert.deepEqual(await response.json(), { report: null });
});

test("console previews require a PR build, stay user-scoped, and can be closed or expire", async () => {
  const now = Date.parse("2026-10-27T15:00:00Z");
  const clock = vi.spyOn(Date, "now").mockReturnValue(now);
  const previewBuild = vi.spyOn(wrappedConfig, "isWrappedPreviewBuild").mockReturnValue(false);
  const preview = await import("../../backend/services/wrapped/preview.ts");
  db.prepare(
    "INSERT INTO users (id, username, password_hash) VALUES (1, 'one', 'hash'), (2, 'two', 'hash')",
  ).run();
  db.prepare(
    "INSERT INTO play_events (user_id, track_id, title, artist, duration_ms, played_at, source, created_at) VALUES (1, 'track', 'Song', 'Artist', 180000, ?, 'subsonic', ?)",
  ).run(now - 180000, now);
  const request = (userId: number, enabled = true) =>
    fetch(`${server.url}/wrapped/preview`, {
      method: "POST",
      headers: { "x-test-user": String(userId), "Content-Type": "application/json" },
      body: JSON.stringify({ timeZone: "UTC", enabled, userId: 2 }),
    });
  assert.equal((await request(1)).status, 404);
  previewBuild.mockReturnValue(true);
  assert.equal((await request(0)).status, 401);
  assert.equal((await request(-1)).status, 403);
  assert.equal((await request(1)).status, 200);
  assert.equal(preview.getWrappedPreview(2), null);
  assert.equal(
    (await fetch(`${server.url}/wrapped/2026`, { headers: { "x-test-user": "2" } })).status,
    404,
  );
  const queued = reports.getWrappedReport(1, 2026, "UTC");
  assert.ok(queued);
  assert.equal(queued.cutoff, now);
  await reports.processWrappedReport(1, 2026, "UTC", queued.cutoff, queued.requestId);
  clock.mockReturnValue(now + 3600000);
  const ready = reports.getWrappedReport(1, 2026, "UTC");
  assert.equal(ready?.state, "ready");
  if (ready?.state !== "ready") throw new Error("Expected completed preview");
  assert.equal(ready.summary.totalPlays, 1);
  assert.equal((await request(1, false)).status, 200);
  assert.equal(preview.getWrappedPreview(1), null);
  assert.equal(
    (await fetch(`${server.url}/wrapped/2026`, { headers: { "x-test-user": "1" } })).status,
    404,
  );
  assert.equal((await request(1)).status, 200);
  clock.mockReturnValue(now + 25 * 3600000);
  assert.equal(preview.getWrappedPreview(1), null);
  reports.cleanupWrappedReports();
  assert.equal(
    db.prepare("SELECT key FROM settings WHERE key = 'wrapped-preview:1'").get(),
    undefined,
  );
});

test("announcements require listening and dismissals apply only to the signed-in user", async () => {
  const now = Date.parse("2026-12-02T12:00:00Z");
  vi.spyOn(Date, "now").mockReturnValue(now);
  db.prepare(
    "INSERT INTO users (id, username, password_hash) VALUES (1, 'one', 'hash'), (2, 'two', 'hash')",
  ).run();
  const announcement = await import("../../backend/services/wrapped/announcement.ts");
  assert.equal(announcement.getWrappedAnnouncement(1, 2026, "UTC").ready, false);
  db.prepare(
    "INSERT INTO play_events (user_id, track_id, title, artist, duration_ms, played_at, source, created_at) VALUES (1, 'track', 'Song', 'Artist', 180000, ?, 'subsonic', ?)",
  ).run(Date.parse("2026-11-30T12:00:00Z"), now);
  for (const userId of [1, 2]) {
    const queued = reports.requestWrappedReport(userId, 2026, "UTC", now);
    assert.equal(announcement.getWrappedAnnouncement(userId, 2026, "UTC").ready, false);
    await reports.processWrappedReport(userId, 2026, "UTC", queued.cutoff, queued.requestId);
  }
  assert.equal(announcement.getWrappedAnnouncement(1, 2026, "UTC").ready, true);
  assert.equal(announcement.getWrappedAnnouncement(2, 2026, "UTC").ready, false);
  const response = await fetch(`${server.url}/wrapped/announcement`, {
    method: "POST",
    headers: { "x-test-user": "1", "Content-Type": "application/json" },
    body: JSON.stringify({ year: 2026, timeZone: "UTC", hidden: true, userId: 2 }),
  });
  assert.equal(response.status, 200);
  assert.equal(announcement.getWrappedAnnouncement(1, 2026, "UTC").hidden, true);
  assert.equal(announcement.getWrappedAnnouncement(1, 2026, "Asia/Tokyo").hidden, true);
  assert.equal(announcement.getWrappedAnnouncement(2, 2026, "UTC").hidden, false);
  announcement.setWrappedAnnouncementHidden(1, 2026, "UTC", false);
  const restored = await fetch(`${server.url}/wrapped/announcement?timeZone=UTC`, {
    headers: { "x-test-user": "1" },
  });
  assert.deepEqual(await restored.json(), {
    year: 2026,
    state: "ready",
    ready: true,
    hidden: false,
    artwork: [],
  });
});

test("switching from nightly to stable rebuilds the recap with the stable listening cutoff", async () => {
  const clock = vi.spyOn(Date, "now").mockReturnValue(Date.parse("2026-11-28T00:00:00Z"));
  let version = "nightly.42+abcdef0";
  vi.spyOn(wrappedConfig, "wrappedSeason").mockImplementation((_appVersion, now) =>
    wrappedSeason(version, now),
  );
  db.prepare("INSERT INTO users (id, username, password_hash) VALUES (1, 'one', 'hash')").run();
  const preview = reports.requestWrappedReport(1, 2026, "UTC");
  await reports.processWrappedReport(1, 2026, "UTC", preview.cutoff, preview.requestId);
  assert.equal(reports.getWrappedReport(1, 2026, "UTC")?.state, "ready");
  assert.equal(preview.cutoff, Date.parse("2026-11-28T00:00:00Z"));
  version = "2.0.0";
  clock.mockReturnValue(Date.parse("2026-12-01T00:00:00Z"));
  assert.equal(reports.getWrappedReport(1, 2026, "UTC"), null);
  const stable = reports.requestWrappedReport(1, 2026, "UTC");
  assert.notEqual(stable.requestId, preview.requestId);
  assert.equal(stable.cutoff, Date.parse("2026-12-01T00:00:00Z"));
});

test("announcement dismissals expire at the next Wrapped release", async () => {
  const clock = vi.spyOn(Date, "now").mockReturnValue(Date.parse("2026-12-02T12:00:00Z"));
  const announcement = await import("../../backend/services/wrapped/announcement.ts");
  announcement.setWrappedAnnouncementHidden(1, 2026, "UTC", true);
  clock.mockReturnValue(Date.parse("2027-11-30T23:59:59Z"));
  assert.equal(announcement.getWrappedAnnouncement(1, 2026, "UTC").hidden, true);
  clock.mockReturnValue(Date.parse("2027-12-01T00:00:00Z"));
  assert.equal(announcement.getWrappedAnnouncement(1, 2027, "UTC").hidden, false);
  reports.cleanupWrappedReports();
  assert.equal(
    db.prepare("SELECT key FROM settings WHERE key = 'wrapped-banner:1'").get(),
    undefined,
  );
});

test("timestamp cursor pagination retains listens at a page boundary", async () => {
  const listenbrainz = await import("../../backend/services/apiClients/listenbrainz.ts");
  const end = Math.floor(period.end / 1000) - 1;
  const row = (timestamp: number) => ({
    listened_at: timestamp,
    recording_msid: String(timestamp),
    track_metadata: { track_name: "Song", artist_name: "Artist" },
  });
  const request = vi.spyOn(listenbrainz, "listenbrainzRequest");
  request.mockResolvedValueOnce({
    payload: { listens: Array.from({ length: 1000 }, (_, index) => row(end - index)) },
  });
  request.mockResolvedValueOnce({ payload: { listens: [row(end - 999), row(end - 1000)] } });
  const result = await history.readWrappedSource(
    "listenbrainz",
    history.listenbrainzWrappedReader("one", period),
  );
  const { mergeWrappedPlays } = await import("../../backend/services/wrapped/metrics.ts");
  assert.equal(mergeWrappedPlays(result.plays).length, 1001);
  assert.equal(result.status.state, "ready");
});

test("Plex history stays filtered to its linked music account", async () => {
  const { PlexClient } = await import("../../backend/services/plex.ts");
  const client = new PlexClient("http://127.0.0.1", "token", "client");
  const request = vi.spyOn(client, "request").mockResolvedValue({
    MediaContainer: {
      size: 1,
      totalSize: 1,
      Metadata: [
        {
          type: "track",
          ratingKey: "track",
          viewedAt: period.start / 1000,
          title: "Song",
          grandparentTitle: "Artist",
          duration: 120000,
        },
      ],
    },
  });
  const result = await history.readWrappedSource("plex", history.plexReader(client, 42, period));
  assert.equal(result.plays[0].durationMs, 120000);
  assert.equal(result.plays[0].account, "42");
  assert.equal(request.mock.calls[0][1]?.params?.accountID, 42);
  assert.equal(request.mock.calls[0][1]?.params?.type, 10);
});

test("Navidrome history joins events to track metadata", async () => {
  const { NavidromeClient } = await import("../../backend/services/navidrome.ts");
  const client = new NavidromeClient("http://127.0.0.1", "one", "password");
  vi.spyOn(client, "_nativeRequest")
    .mockResolvedValueOnce([{ id: 5, mediaFileId: "song", submissionTime: period.start / 1000 }])
    .mockResolvedValueOnce({ title: "Song", artist: "Artist", duration: 120 });
  const result = await history.readWrappedSource(
    "navidrome",
    history.navidromeReader(client, "one", period),
  );
  assert.equal(result.status.state, "ready");
  assert.equal(result.plays[0].durationMs, 120000);
  assert.equal(result.plays[0].id, "5");
});

test("Koito reads authenticated native history with the existing token", async () => {
  const service = await createMockHttpServer((req, res) => {
    assert.equal(req.headers.authorization, "Token test-token");
    assert.equal(new URL(req.url || "", "http://localhost").pathname, "/apis/web/v1/listens");
    res.setHeader("Content-Type", "application/json");
    res.end(
      JSON.stringify({
        has_next_page: false,
        items: [
          {
            time: "2026-06-01T12:00:00Z",
            track: { id: 7, title: "Song", artists: [{ name: "Artist" }] },
          },
        ],
      }),
    );
  });
  try {
    const result = await history.readWrappedSource(
      "koito",
      history.koitoReader(service.url, "test-token", period),
    );
    assert.equal(result.status.state, "ready");
    assert.equal(result.plays[0].artist, "Artist");
  } finally {
    await service.close();
  }
});

test("Jellyfin uses reported time and leaves plugin failures recoverable", async () => {
  const { JellyfinClient } = await import("../../backend/services/jellyfin.ts");
  const client = new JellyfinClient("http://127.0.0.1", "key", "one");
  const request = vi
    .spyOn(client, "request")
    .mockResolvedValueOnce({ results: [["2026-01-01 12:00:00", "song", 65]] })
    .mockResolvedValueOnce({
      Items: [{ Id: "song", Name: "Song", Artists: ["Artist"], RunTimeTicks: 1800000000 }],
    });
  const result = await history.readWrappedSource(
    "jellyfin",
    history.jellyfinReader(client, "one", period),
  );
  assert.equal(result.plays[0].listenedMs, 65000);
  assert.equal(result.plays[0].durationMs, 180000);
  request.mockResolvedValueOnce({ results: [], message: "no such table: PlaybackActivity" });
  const failed = await history.readWrappedSource(
    "jellyfin",
    history.jellyfinReader(client, "one", period),
  );
  assert.equal(failed.status.state, "unavailable");
});

test("local annual history is user scoped and does not enqueue outgoing scrobbles", () => {
  db.prepare(
    "INSERT INTO users (id, username, password_hash) VALUES (1, 'one', 'hash'), (2, 'two', 'hash')",
  ).run();
  const insert = db.prepare(
    "INSERT INTO play_events (user_id, track_id, title, artist, played_at, source, created_at) VALUES (?, 'track', 'Song', 'Artist', ?, 'subsonic', ?)",
  );
  insert.run(1, period.start, period.start);
  insert.run(2, period.start, period.start);
  insert.run(1, period.end, period.end);
  assert.equal(history.readLocalWrappedHistory(1, period).length, 1);
  assert.deepEqual(db.prepare("SELECT COUNT(*) AS count FROM play_events").get(), { count: 3 });
  assert.deepEqual(
    db
      .prepare("SELECT COUNT(*) AS count FROM _honker_live WHERE queue = '_outbox:play-events'")
      .get(),
    { count: 0 },
  );
});

test("one unavailable source preserves the records from its completed pages", async () => {
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

test("Last.fm reader excludes now-playing and keeps the year filter fixed across pages", async () => {
  const requests: unknown[] = [];
  vi.spyOn(lastfm, "lastfmRequest").mockImplementation(async (_method, params) => {
    requests.push(params);
    return {
      recenttracks: {
        "@attr": { totalPages: "2" },
        track: [
          {
            name: "Song",
            artist: { "#text": "Artist" },
            date: { uts: String(period.start / 1000) },
          },
          { name: "Now playing", "@attr": { nowplaying: "true" } },
        ],
      },
    };
  });
  const reader = history.lastfmWrappedReader("one", period);
  assert.equal((await reader(1)).plays.length, 1);
  assert.equal((await reader(2)).more, false);
  assert.deepEqual(
    requests,
    [1, 2].map((page) => ({
      user: "one",
      from: period.start / 1000 - 1,
      to: period.end / 1000,
      limit: 200,
      page,
    })),
  );
});

test("the released recap stays available until the next annual launch", () => {
  assert.doesNotThrow(() =>
    reports.validateWrappedRequest(1, 2026, "UTC", Date.parse("2027-01-31T12:00:00Z")),
  );
  assert.doesNotThrow(() =>
    reports.validateWrappedRequest(1, 2026, "UTC", Date.parse("2027-02-01T00:00:00Z")),
  );
  assert.throws(() =>
    reports.validateWrappedRequest(1, 2027, "UTC", Date.parse("2027-11-30T23:59:59Z")),
  );
  assert.throws(() =>
    reports.validateWrappedRequest(1, 2026, "UTC", Date.parse("2027-12-01T00:00:00Z")),
  );
  assert.doesNotThrow(() =>
    reports.validateWrappedRequest(1, 2027, "UTC", Date.parse("2027-12-01T00:00:00Z")),
  );
  db.prepare("INSERT INTO settings (key, value) VALUES (?, ?)").run(
    "wrapped:expired",
    JSON.stringify({ expiresAt: 10 }),
  );
  db.prepare("INSERT INTO settings (key, value) VALUES (?, ?)").run(
    "unrelated",
    JSON.stringify({ expiresAt: 10 }),
  );
  reports.cleanupWrappedReports(11);
  assert.equal(
    db.prepare("SELECT key FROM settings WHERE key = 'wrapped:expired'").get(),
    undefined,
  );
  assert.ok(db.prepare("SELECT key FROM settings WHERE key = 'unrelated'").get());
});

test("completed summaries last one season and annual rollover queues a replacement once", async () => {
  const clock = vi.spyOn(Date, "now").mockReturnValue(Date.parse("2026-12-02T12:00:00Z"));
  db.prepare(
    "INSERT INTO users (id, username, password_hash) VALUES (1, 'one', 'hash'), (2, 'two', 'hash')",
  ).run();
  const queued = reports.requestWrappedReport(1, 2026, "UTC");
  assert.equal(queued.cutoff, Date.parse("2026-12-01T00:00:00Z"));
  await reports.processWrappedReport(1, 2026, "UTC", queued.cutoff, queued.requestId);
  const second = reports.requestWrappedReport(2, 2026, "UTC");
  await reports.processWrappedReport(2, 2026, "UTC", second.cutoff, second.requestId);
  clock.mockReturnValue(Date.parse("2027-06-01T12:00:00Z"));
  reports.cleanupWrappedReports();
  const ready = reports.getWrappedReport(1, 2026, "UTC");
  assert.equal(ready?.state, "ready");
  assert.equal(ready?.expiresAt, Date.parse("2027-12-01T00:00:00Z"));
  reports.rolloverWrappedReports();
  assert.equal(reports.getWrappedReport(1, 2027, "UTC"), null);
  clock.mockReturnValue(Date.parse("2027-12-01T00:00:00Z"));
  reports.requestWrappedReport(1, 2027, "UTC");
  reports.rolloverWrappedReports();
  const next = reports.getWrappedReport(1, 2027, "UTC");
  assert.equal(next?.state, "queued");
  assert.equal(reports.getWrappedReport(2, 2027, "UTC")?.state, "queued");
  assert.equal(reports.getWrappedReport(1, 2026, "UTC"), null);
  reports.rolloverWrappedReports();
  assert.equal(reports.getWrappedReport(1, 2027, "UTC")?.requestId, next?.requestId);
});
