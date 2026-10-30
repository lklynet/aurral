import { getPublishedNightlyImage } from "../../../lib/nightly-image.ts";
import {
  extractReleaseNoteItems,
  normalizeReleaseVersion,
  parseReleaseVersion,
  releaseChannel,
} from "../../../lib/release-version.ts";

const REPOSITORY = "lklynet/aurral";
const FEED_TTL_S = 60 * 60;
const FEED_RETRY_S = 10 * 60;
const NIGHTLY_COMMITS = 50;
const EMPTY_FEED = JSON.stringify({ stable: null, nightly: null });

const schemaReady = new WeakMap();

function ensureSchema(db) {
  if (!schemaReady.has(db)) {
    const ready = Promise.all([
      db
        .prepare(
          `CREATE TABLE IF NOT EXISTS update_checks (
            hour INTEGER NOT NULL,
            channel TEXT NOT NULL,
            version TEXT NOT NULL,
            checks INTEGER NOT NULL,
            PRIMARY KEY (hour, channel, version)
          )`,
        )
        .run(),
      db
        .prepare(
          `CREATE TABLE IF NOT EXISTS update_feed (
            id INTEGER PRIMARY KEY CHECK (id = 1),
            payload TEXT,
            checked_at INTEGER NOT NULL
          )`,
        )
        .run(),
    ]).catch((error) => {
      schemaReady.delete(db);
      throw error;
    });
    schemaReady.set(db, ready);
  }
  return schemaReady.get(db);
}

async function github(path, token) {
  const headers = { Accept: "application/vnd.github+json", "User-Agent": "aurral.org" };
  if (token) headers.Authorization = `Bearer ${token}`;
  const response = await fetch(`https://api.github.com/repos/${REPOSITORY}${path}`, {
    headers,
    signal: AbortSignal.timeout(15000),
  });
  if (!response.ok) throw new Error(`GitHub answered ${response.status}`);
  return response.json();
}

async function fetchFeed(token) {
  const [release, nightly] = await Promise.all([
    github("/releases/latest", token),
    getPublishedNightlyImage(REPOSITORY),
  ]);
  const commits = nightly
    ? await github(`/commits?sha=${nightly.sha}&per_page=${NIGHTLY_COMMITS}`, token)
    : [];
  const stableVersion = normalizeReleaseVersion(release?.tag_name);
  return {
    stable: parseReleaseVersion(stableVersion)
      ? {
          version: stableVersion,
          url: release.html_url,
          notes: extractReleaseNoteItems(release.body),
        }
      : null,
    nightly: nightly && {
      version: nightly.version,
      sha: nightly.sha,
      commits: commits.map((commit) => ({
        sha: commit.sha,
        subject: String(commit.commit?.message || "").split(/\r?\n/, 1)[0],
      })),
    },
  };
}

async function currentFeed(db, now, token) {
  const claim = await db
    .prepare(
      `INSERT INTO update_feed (id, payload, checked_at) VALUES (1, NULL, ?)
       ON CONFLICT(id) DO UPDATE SET checked_at = excluded.checked_at
       WHERE update_feed.checked_at <= ?`,
    )
    .bind(now, now - FEED_TTL_S)
    .run();
  if (claim.meta.changes === 1) {
    try {
      const payload = JSON.stringify(await fetchFeed(token));
      await db.prepare("UPDATE update_feed SET payload = ? WHERE id = 1").bind(payload).run();
      return payload;
    } catch {
      await db
        .prepare("UPDATE update_feed SET checked_at = ? WHERE id = 1")
        .bind(now - FEED_TTL_S + FEED_RETRY_S)
        .run();
    }
  }
  const row = await db.prepare("SELECT payload FROM update_feed WHERE id = 1").first();
  return row?.payload ?? null;
}

function countCheck(db, now, version) {
  const channel = releaseChannel(version);
  if (!channel) return null;
  return db
    .prepare(
      `INSERT INTO update_checks (hour, channel, version, checks) VALUES (?, ?, ?, 1)
       ON CONFLICT(hour, channel, version) DO UPDATE SET checks = checks + 1`,
    )
    .bind(
      now - (now % 3600),
      channel,
      channel === "stable" ? normalizeReleaseVersion(version) : version,
    )
    .run();
}

export async function onRequestGet({ env, request }) {
  const db = env.SHARE_DB;
  if (!db) {
    return new Response(JSON.stringify({ error: "updates_unavailable" }), {
      status: 503,
      headers: { "Content-Type": "application/json", "Cache-Control": "no-store" },
    });
  }
  await ensureSchema(db);
  const now = Math.floor(Date.now() / 1000);
  const version = new URL(request.url).searchParams.get("version") || "";
  const [payload] = await Promise.all([
    currentFeed(db, now, env.GITHUB_TOKEN),
    countCheck(db, now, version),
  ]);
  return new Response(payload ?? EMPTY_FEED, {
    headers: { "Content-Type": "application/json", "Cache-Control": "no-store" },
  });
}
