import type BetterSqlite3 from "better-sqlite3";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { afterEach, beforeEach, test, vi } from "vite-plus/test";

const backendRequire = createRequire(new URL("../../backend/package.json", import.meta.url));
const Database: typeof BetterSqlite3 = backendRequire("better-sqlite3");
const { onRequestGet } = await import("../../web/functions/api/updates.js");

const HOUR = 60 * 60 * 1000;
const CONFIG_DIGEST = `sha256:${"c".repeat(64)}`;
const NIGHTLY_SHA = "b".repeat(40);

function fakeD1() {
  const sqlite = new Database(":memory:");
  return {
    sqlite,
    prepare(sql: string) {
      const bound = (values: unknown[]) => ({
        bind: (...next: unknown[]) => bound(next),
        first: async () => sqlite.prepare(sql).get(...values) ?? null,
        run: async () => ({ meta: { changes: sqlite.prepare(sql).run(...values).changes } }),
      });
      return bound([]);
    },
  };
}

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status });

function fakeUpstream({ nightlyRun = 512 } = {}) {
  const requests: string[] = [];
  const routes: Record<string, () => Response> = {
    "https://api.github.com/repos/lklynet/aurral/releases/latest": () =>
      json({ tag_name: "v2.10.0", html_url: "https://github.com/r/2.10.0", body: "* fix: x" }),
    "https://ghcr.io/token?service=ghcr.io&scope=repository:lklynet/aurral:pull": () =>
      json({ token: "t" }),
    "https://ghcr.io/v2/lklynet/aurral/manifests/nightly": () =>
      json({ config: { digest: CONFIG_DIGEST } }),
    [`https://ghcr.io/v2/lklynet/aurral/blobs/${CONFIG_DIGEST}`]: () =>
      json({ config: { Env: [`APP_VERSION=nightly.${nightlyRun}+bbbbbbb`] } }),
    "https://api.github.com/repos/lklynet/aurral/commits?sha=bbbbbbb&per_page=50": () =>
      json([{ sha: NIGHTLY_SHA, commit: { message: "feat: newest\n\nbody" } }]),
  };
  let down = false;
  const realFetch = globalThis.fetch;
  globalThis.fetch = async (url) => {
    requests.push(String(url));
    const route = routes[String(url)];
    if (!route) throw new Error(`unexpected request to ${url}`);
    return down ? json({}, 503) : route();
  };
  return {
    requests,
    goDown: () => {
      down = true;
    },
    restore: () => {
      globalThis.fetch = realFetch;
    },
  };
}

const check = async (db: ReturnType<typeof fakeD1>, version: string) =>
  (
    await onRequestGet({
      env: { SHARE_DB: db },
      request: new Request(`https://aurral.org/api/updates?version=${encodeURIComponent(version)}`),
    })
  ).json();

const counts = (db: ReturnType<typeof fakeD1>) =>
  db.sqlite
    .prepare("SELECT hour, channel, version, checks FROM update_checks ORDER BY hour, version")
    .all();

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["Date"], now: Date.UTC(2026, 9, 30, 14, 5) });
});
afterEach(() => {
  vi.useRealTimers();
});

test("each check counts once per hour, channel and version, and other builds are not counted", async (t) => {
  const db = fakeD1();
  const upstream = fakeUpstream();
  t.onTestFinished(upstream.restore);
  const hour = Date.UTC(2026, 9, 30, 14) / 1000;

  await check(db, "2.10.0");
  await check(db, "2.10.0");
  await check(db, "nightly.511+aaaaaaa");
  await check(db, "pr.12+aaaaaaa");
  await check(db, "a1b2c3d");
  vi.setSystemTime(Date.UTC(2026, 9, 30, 15, 1));
  await check(db, "2.10.0");

  assert.deepEqual(counts(db), [
    { hour, channel: "stable", version: "2.10.0", checks: 2 },
    { hour, channel: "nightly", version: "nightly.511+aaaaaaa", checks: 1 },
    { hour: hour + 3600, channel: "stable", version: "2.10.0", checks: 1 },
  ]);
});

test("the feed comes from GitHub at most once an hour and survives an outage", async (t) => {
  const db = fakeD1();
  const upstream = fakeUpstream();
  t.onTestFinished(upstream.restore);
  const feed = {
    stable: { version: "2.10.0", url: "https://github.com/r/2.10.0", notes: ["fix: x"] },
    nightly: {
      version: "nightly.512+bbbbbbb",
      sha: "bbbbbbb",
      commits: [{ sha: NIGHTLY_SHA, subject: "feat: newest" }],
    },
  };

  assert.deepEqual(await check(db, "2.9.0"), feed);
  const fetched = upstream.requests.length;
  assert.deepEqual(await check(db, "2.9.0"), feed);
  assert.equal(upstream.requests.length, fetched);

  upstream.goDown();
  vi.setSystemTime(Date.now() + HOUR);
  assert.deepEqual(await check(db, "2.9.0"), feed);
  const failedAt = upstream.requests.length;
  assert.deepEqual(await check(db, "2.9.0"), feed);
  assert.equal(upstream.requests.length, failedAt);
});
