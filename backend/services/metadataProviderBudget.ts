import { db } from "../config/db-sqlite.ts";
import type { MetadataProviderBudgetRow } from "../db/rows.ts";
import { randomUUID } from "node:crypto";

db.exec(`
  CREATE TABLE IF NOT EXISTS metadata_provider_budget (
    base_url TEXT PRIMARY KEY,
    next_request_at INTEGER NOT NULL DEFAULT 0,
    forbidden_until INTEGER NOT NULL DEFAULT 0,
    rate_limited_until INTEGER NOT NULL DEFAULT 0
  );

  CREATE TABLE IF NOT EXISTS metadata_request_state (
    cache_key TEXT PRIMARY KEY,
    failure_count INTEGER NOT NULL DEFAULT 0,
    retry_after INTEGER NOT NULL DEFAULT 0,
    lease_token TEXT,
    lease_until INTEGER NOT NULL DEFAULT 0,
    updated_at INTEGER NOT NULL DEFAULT 0
  );
`);

interface MetadataRequestStateRow {
  cache_key: string;
  failure_count: number;
  retry_after: number;
  lease_token: string | null;
  lease_until: number;
  updated_at: number;
}

const TRANSIENT_BACKOFF_MS = [60 * 60 * 1000, 6 * 60 * 60 * 1000, 24 * 60 * 60 * 1000];
const REQUEST_STATE_RETENTION_MS = 30 * 24 * 60 * 60 * 1000;
const REQUEST_STATE_CLEANUP_INTERVAL_MS = 60 * 60 * 1000;
let nextRequestStateCleanupAt = 0;

const readRequestState = db.prepare<[string], MetadataRequestStateRow>(
  "SELECT * FROM metadata_request_state WHERE cache_key = ?",
);
const claimRequest = db.prepare<[string, string, number, number]>(`
  INSERT INTO metadata_request_state(
    cache_key, failure_count, retry_after, lease_token, lease_until, updated_at
  ) VALUES (?, 0, 0, ?, ?, ?)
  ON CONFLICT(cache_key) DO UPDATE SET
    lease_token = excluded.lease_token,
    lease_until = excluded.lease_until,
    updated_at = excluded.updated_at
`);
const clearRequestState = db.prepare<[string]>(
  "DELETE FROM metadata_request_state WHERE cache_key = ?",
);
const releaseRequest = db.prepare<[number, string, string]>(`
  UPDATE metadata_request_state
  SET lease_token = NULL, lease_until = 0, updated_at = ?
  WHERE cache_key = ? AND lease_token = ?
`);
const clearAllRequestStates = db.prepare("DELETE FROM metadata_request_state");
const cleanOldRequestStates = db.prepare<[number, number]>(`
  DELETE FROM metadata_request_state
  WHERE updated_at < ? AND lease_until < ?
`);
const finishFailedRequest = db.prepare<[number, number, number, string, string]>(`
  UPDATE metadata_request_state
  SET failure_count = ?, retry_after = ?, lease_token = NULL, lease_until = 0, updated_at = ?
  WHERE cache_key = ? AND lease_token = ?
`);

function retryAfterFailure(failureCount: number, now: number) {
  const backoffMs =
    TRANSIENT_BACKOFF_MS[Math.min(failureCount - 1, TRANSIENT_BACKOFF_MS.length - 1)];
  return now + backoffMs;
}

export function getMetadataRequestState(cacheKey: string) {
  const row = readRequestState.get(cacheKey);
  return row
    ? {
        failureCount: Number(row.failure_count || 0),
        retryAfter: Number(row.retry_after || 0),
        leaseUntil: Number(row.lease_until || 0),
        leased: Boolean(row.lease_token),
      }
    : null;
}

const acquireRequest = db.transaction((cacheKey: string, leaseMs: number, now: number) => {
  const existing = readRequestState.get(cacheKey);
  if (Number(existing?.retry_after || 0) > now) {
    return { acquired: false as const, retryAfter: Number(existing!.retry_after), leased: false };
  }
  if (existing?.lease_token && Number(existing.lease_until || 0) > now) {
    return { acquired: false as const, retryAfter: 0, leased: true };
  }
  if (existing?.lease_token) {
    const failures = Math.max(0, Number(existing.failure_count || 0)) + 1;
    const retryAfter = retryAfterFailure(failures, now);
    finishFailedRequest.run(failures, retryAfter, now, cacheKey, existing.lease_token);
    return { acquired: false as const, retryAfter, leased: false };
  }
  const token = randomUUID();
  claimRequest.run(cacheKey, token, now + leaseMs, now);
  return { acquired: true as const, token, retryAfter: 0, leased: false };
});

export function acquireMetadataRequest(cacheKey: string, leaseMs: number, now = Date.now()) {
  if (now >= nextRequestStateCleanupAt) {
    nextRequestStateCleanupAt = now + REQUEST_STATE_CLEANUP_INTERVAL_MS;
    cleanOldRequestStates.run(now - REQUEST_STATE_RETENTION_MS, now);
  }
  return acquireRequest.immediate(cacheKey, Math.max(1000, Math.floor(leaseMs)), now);
}

export function completeMetadataRequest(cacheKey: string, token: string) {
  return db
    .prepare("DELETE FROM metadata_request_state WHERE cache_key = ? AND lease_token = ?")
    .run(cacheKey, token).changes;
}

export function releaseMetadataRequest(cacheKey: string, token: string, now = Date.now()) {
  return releaseRequest.run(now, cacheKey, token).changes;
}

const failRequest = db.transaction((cacheKey: string, token: string, now: number) => {
  const current = readRequestState.get(cacheKey);
  if (!current || current.lease_token !== token) return 0;
  const failures = Math.max(0, Number(current.failure_count || 0)) + 1;
  const retryAfter = retryAfterFailure(failures, now);
  finishFailedRequest.run(failures, retryAfter, now, cacheKey, token);
  return retryAfter;
});

export function failMetadataRequest(cacheKey: string, token: string, now = Date.now()) {
  return failRequest.immediate(cacheKey, token, now);
}

export function forgetMetadataRequestState(cacheKey: string) {
  return clearRequestState.run(cacheKey).changes;
}

export function clearMetadataRequestStates() {
  return clearAllRequestStates.run().changes;
}

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
