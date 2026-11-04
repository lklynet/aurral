import { MAX_TELEMETRY_BYTES, isTelemetryReport } from "../../../lib/telemetry.ts";

const DAY_S = 24 * 60 * 60;
const RETENTION_DAYS = 400;

const schemaReady = new WeakMap();

function ensureSchema(db) {
  if (!schemaReady.has(db)) {
    const ready = db
      .batch([
        db.prepare(
          `CREATE TABLE IF NOT EXISTS telemetry_reports (
            id INTEGER PRIMARY KEY,
            day INTEGER NOT NULL,
            report TEXT NOT NULL
          )`,
        ),
        db.prepare("CREATE INDEX IF NOT EXISTS telemetry_reports_day ON telemetry_reports (day)"),
      ])
      .catch((error) => {
        schemaReady.delete(db);
        throw error;
      });
    schemaReady.set(db, ready);
  }
  return schemaReady.get(db);
}

const answer = (status, error) =>
  new Response(error ? JSON.stringify({ error }) : null, {
    status,
    headers: { "Content-Type": "application/json", "Cache-Control": "no-store" },
  });

export async function onRequestPost({ env, request }) {
  const db = env.TELEMETRY_DB;
  if (!db) return answer(503, "telemetry_unavailable");
  const body = await request.text();
  if (body.length > MAX_TELEMETRY_BYTES) return answer(413, "too_large");
  let parsed;
  try {
    parsed = JSON.parse(body);
  } catch {
    return answer(400, "invalid_json");
  }
  if (!isTelemetryReport(parsed)) return answer(400, "invalid_report");
  await ensureSchema(db);
  const now = Math.floor(Date.now() / 1000);
  const day = now - (now % DAY_S);
  await db
    .prepare("INSERT INTO telemetry_reports (day, report) VALUES (?, ?)")
    .bind(day, JSON.stringify(parsed))
    .run();
  await db
    .prepare("DELETE FROM telemetry_reports WHERE day < ?")
    .bind(day - RETENTION_DAYS * DAY_S)
    .run();
  return answer(204);
}
