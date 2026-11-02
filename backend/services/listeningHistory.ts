import { db } from "../config/db-sqlite.ts";
import type { ListenHistorySourcesRow } from "../db/rows.ts";
import { isOwnKey } from "../../lib/ownKey.ts";
import { validateExternalUrl } from "../middleware/urlValidator.ts";
import { normalizeKoitoBaseUrl } from "./koitoClient.ts";

export const LISTEN_HISTORY_PROVIDERS = ["lastfm", "listenbrainz", "koito"] as const;
export type ListenHistoryProvider = (typeof LISTEN_HISTORY_PROVIDERS)[number];
export type ListenHistory = Record<ListenHistoryProvider, string | null>;

export class ListenHistoryError extends Error {}

const selectStmt = db.prepare<[number], Pick<ListenHistorySourcesRow, "provider" | "account">>(
  "SELECT provider, account FROM listen_history_sources WHERE user_id = ?",
);
const upsertStmt = db.prepare<[number, string, string]>(
  "INSERT INTO listen_history_sources (user_id, provider, account) VALUES (?, ?, ?) ON CONFLICT (user_id, provider) DO UPDATE SET account = excluded.account",
);
const deleteStmt = db.prepare<[number, string]>(
  "DELETE FROM listen_history_sources WHERE user_id = ? AND provider = ?",
);

export function getListenHistory(userId: number) {
  const history: ListenHistory = { lastfm: null, listenbrainz: null, koito: null };
  for (const { provider, account } of selectStmt.all(userId)) {
    if (isOwnKey(history, provider)) history[provider] = account;
  }
  return history;
}

function normalizeAccount(provider: ListenHistoryProvider, value: string | null | undefined) {
  const trimmed = value?.trim();
  if (!trimmed) return null;
  if (provider !== "koito") return trimmed;
  const validation = validateExternalUrl(trimmed);
  if (!validation.valid) throw new ListenHistoryError(validation.error || "Invalid Koito URL");
  return normalizeKoitoBaseUrl(validation.url);
}

const writeListenHistory = db.transaction((userId: number, next: Partial<ListenHistory>) => {
  for (const [provider, account] of Object.entries(next)) {
    if (account) upsertStmt.run(userId, provider, account);
    else deleteStmt.run(userId, provider);
  }
});

export function updateListenHistory(userId: number, updates: Partial<ListenHistory>) {
  const current = getListenHistory(userId);
  const changes = Object.fromEntries(
    LISTEN_HISTORY_PROVIDERS.filter((provider) => provider in updates)
      .map((provider) => [provider, normalizeAccount(provider, updates[provider])] as const)
      .filter(([provider, account]) => current[provider] !== account),
  );
  if (Object.keys(changes).length > 0) writeListenHistory(userId, changes);
  return { history: { ...current, ...changes }, changed: Object.keys(changes).length > 0 };
}
