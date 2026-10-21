import { db } from "../config/db-sqlite.ts";
import type { MetadataProviderBudgetRow } from "../db/rows.ts";

db.exec(`
  CREATE TABLE IF NOT EXISTS metadata_provider_budget (
    base_url TEXT PRIMARY KEY,
    next_request_at INTEGER NOT NULL DEFAULT 0,
    forbidden_until INTEGER NOT NULL DEFAULT 0,
    rate_limited_until INTEGER NOT NULL DEFAULT 0
  );
`);

const readBudget = db.prepare<[string], MetadataProviderBudgetRow>(
  "SELECT * FROM metadata_provider_budget WHERE base_url = ?",
);
const reserve = db.prepare(`
  INSERT INTO metadata_provider_budget(base_url, next_request_at) VALUES (?, ?)
  ON CONFLICT(base_url) DO UPDATE SET next_request_at = excluded.next_request_at
`);

export function getMetadataProviderBudget(baseUrl: string): Partial<MetadataProviderBudgetRow> {
  return readBudget.get(baseUrl) || {};
}

const reserveRequest = db.transaction((baseUrl: string, intervalMs: number) => {
  const now = Date.now();
  const next = Math.max(now, Number(readBudget.get(baseUrl)?.next_request_at || 0));
  if (next === now) reserve.run(baseUrl, now + intervalMs);
  return next - now;
});

export function reserveMetadataProviderRequest(baseUrl: string, intervalMs: number) {
  return reserveRequest.immediate(baseUrl, intervalMs);
}

export function setMetadataProviderCooldown(baseUrl: string, status: number, until: number) {
  const column = status === 403 ? "forbidden_until" : "rate_limited_until";
  db.prepare(`
    INSERT INTO metadata_provider_budget(base_url, ${column}) VALUES (?, ?)
    ON CONFLICT(base_url) DO UPDATE SET ${column} = MAX(${column}, excluded.${column})
  `).run(baseUrl, until);
}
