const DAY_S = 24 * 60 * 60;
const WINDOW_DAYS = 3;
const COMPARE_DAYS = 30;
const CACHE_TTL_S = 60 * 60;

async function summarize(db, from, to) {
  const [installs, facts] = await Promise.all([
    db
      .prepare("SELECT COUNT(*) AS n FROM telemetry_reports WHERE day >= ? AND day < ?")
      .bind(from, to)
      .first(),
    db
      .prepare(
        `SELECT j.path AS path,
                CASE WHEN typeof(j.key) = 'integer' THEN NULL ELSE j.key END AS key,
                j.atom AS value,
                COUNT(DISTINCT r.id) AS n
         FROM telemetry_reports r, json_tree(r.report) j
         WHERE r.day >= ? AND r.day < ? AND j.type NOT IN ('object', 'array')
         GROUP BY 1, 2, 3`,
      )
      .bind(from, to)
      .all(),
  ]);
  return { installs: installs?.n ?? 0, facts: facts.results ?? [] };
}

async function buildStats(db, now) {
  const today = now - (now % DAY_S);
  const current = await summarize(db, today - WINDOW_DAYS * DAY_S, today);
  const previous = await summarize(
    db,
    today - (COMPARE_DAYS + WINDOW_DAYS) * DAY_S,
    today - COMPARE_DAYS * DAY_S,
  );
  return { through: today, ...current, previous };
}

const EMPTY = { installs: 0, facts: [] };

const schemaReady = new WeakMap();

function ensureCacheTable(db) {
  if (!schemaReady.has(db)) {
    const ready = db
      .prepare(
        `CREATE TABLE IF NOT EXISTS telemetry_stats (
          id INTEGER PRIMARY KEY CHECK (id = 1),
          payload TEXT NOT NULL,
          built_at INTEGER NOT NULL
        )`,
      )
      .run()
      .catch((error) => {
        schemaReady.delete(db);
        throw error;
      });
    schemaReady.set(db, ready);
  }
  return schemaReady.get(db);
}

const hasReports = async (db) =>
  Boolean(
    await db
      .prepare("SELECT 1 AS found FROM sqlite_master WHERE type = 'table' AND name = ?")
      .bind("telemetry_reports")
      .first(),
  );

const json = (body, status = 200, cache = "no-store") =>
  new Response(typeof body === "string" ? body : JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json", "Cache-Control": cache },
  });

export async function onRequestGet({ env }) {
  const db = env.TELEMETRY_DB;
  if (!db) return json({ error: "stats_unavailable" }, 503);
  await ensureCacheTable(db);
  const now = Math.floor(Date.now() / 1000);
  const cached = await db
    .prepare("SELECT payload FROM telemetry_stats WHERE id = 1 AND built_at > ?")
    .bind(now - CACHE_TTL_S)
    .first();
  if (cached) return json(cached.payload, 200, "public, max-age=600");
  const payload = JSON.stringify(
    (await hasReports(db))
      ? await buildStats(db, now)
      : { through: now - (now % DAY_S), ...EMPTY, previous: EMPTY },
  );
  await db
    .prepare(
      `INSERT INTO telemetry_stats (id, payload, built_at) VALUES (1, ?, ?)
       ON CONFLICT(id) DO UPDATE SET payload = excluded.payload, built_at = excluded.built_at`,
    )
    .bind(payload, now)
    .run();
  return json(payload, 200, "public, max-age=600");
}
