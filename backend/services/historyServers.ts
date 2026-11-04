import * as v from "valibot";
import axios from "../../lib/axiosFetch.ts";
import { asAppError } from "../../lib/errors.ts";
import { db } from "../config/db-sqlite.ts";
import { decryptWithKey, encryptWithKey } from "../config/encryption.ts";
import { getSettingsEncryptionKey } from "../db/helpers/settings.ts";
import type { HistoryServersRow } from "../db/rows.ts";
import { getPlexServer } from "./plex.ts";

export const HISTORY_SERVER_PROVIDERS = ["navidrome", "plex", "jellyfin"] as const;
export type HistoryServerProvider = (typeof HISTORY_SERVER_PROVIDERS)[number];
export const LOGIN_HISTORY_SERVERS = ["navidrome", "jellyfin"] as const;
type LoginHistoryServer = (typeof LOGIN_HISTORY_SERVERS)[number];

type Connection = { url: string; username: string; secret: string; accountId: string | null };
export type ImportedPlay = {
  id: string;
  trackId: string;
  playedAt: number;
  title: string;
  artist: string;
  album?: string;
  trackMbid?: string;
  artistMbid?: string;
  durationMs?: number;
};
type Reader = (
  connection: Connection,
  since: number,
  until: number,
) => AsyncGenerator<ImportedPlay[]>;
type Provider = {
  connect: (connection: Connection) => Promise<{ accountId: string | null }>;
  read: Reader;
};

const PAGE_SIZE = 500;
const TIMEOUT_MS = 30_000;
const OVERLAP_MS = 24 * 60 * 60 * 1000;

const record = v.record(v.string(), v.unknown());
const object = (value: unknown) => (v.is(record, value) ? value : {});
const list = (value: unknown): unknown[] => (Array.isArray(value) ? value : []);
const text = (value: unknown) => (typeof value === "string" ? value.trim() : "");
const number = (value: unknown) => (Number.isFinite(Number(value)) ? Number(value) : 0);
const sameName = (left: unknown, right: string) => text(left).toLowerCase() === right.toLowerCase();

export class HistoryServerError extends Error {}

async function navidromeToken({ url, username, secret }: Connection) {
  try {
    const { data } = await axios.post(
      `${url}/auth/login`,
      { username, password: secret },
      { timeout: TIMEOUT_MS },
    );
    const token = text(object(data).token);
    if (!token) throw new HistoryServerError("Navidrome did not accept the login");
    return token;
  } catch (error) {
    if (Number(asAppError(error)?.response?.status) === 401)
      throw new HistoryServerError("Wrong Navidrome username or password");
    throw error;
  }
}

const navidrome: Provider = {
  async connect(connection) {
    await navidromeToken(connection);
    return { accountId: null };
  },
  async *read(connection, since, until) {
    const headers = { "x-nd-authorization": `Bearer ${await navidromeToken(connection)}` };
    const songs = new Map<string, Record<string, unknown>>();
    for (let start = 0; ; start += PAGE_SIZE) {
      const query = new URLSearchParams({
        from: String(Math.floor(since / 1000)),
        to: String(Math.ceil(until / 1000)),
        _start: String(start),
        _end: String(start + PAGE_SIZE),
        _sort: "submission_time",
        _order: "ASC",
      });
      const { data } = await axios.get(`${connection.url}/api/scrobble?${query}`, {
        headers,
        timeout: TIMEOUT_MS,
      });
      if (!Array.isArray(data)) throw new HistoryServerError("Navidrome history is unavailable");
      const rows = data.map(object);
      const missing = [...new Set(rows.map((row) => text(row.mediaFileId)))].filter(
        (id) => id && !songs.has(id),
      );
      for (let offset = 0; offset < missing.length; offset += 100) {
        const ids = new URLSearchParams(
          missing.slice(offset, offset + 100).map((id) => ["id", id]),
        );
        const found = await axios.get(`${connection.url}/api/song?${ids}`, {
          headers,
          timeout: TIMEOUT_MS,
        });
        for (const song of list(found.data).map(object)) songs.set(text(song.id), song);
      }
      yield rows.map((row) => {
        const song = songs.get(text(row.mediaFileId)) ?? {};
        return {
          id: String(row.id),
          trackId: text(row.mediaFileId),
          playedAt: number(row.submissionTime) * 1000,
          title: text(song.title),
          artist: text(song.artist),
          album: text(song.album),
          trackMbid: text(song.mbzRecordingID),
          artistMbid: text(song.mbzArtistId),
          durationMs: number(song.duration) * 1000 || undefined,
        };
      });
      if (rows.length < PAGE_SIZE) return;
    }
  },
};

const plexHeaders = (token: string) => ({
  Accept: "application/json",
  "X-Plex-Token": token,
  "X-Plex-Client-Identifier": "aurral",
  "X-Plex-Product": "Aurral",
});

const readPlex: Reader = async function* ({ url, secret, accountId }, since, until) {
  for (let start = 0; ; start += PAGE_SIZE) {
    const { data } = await axios.get(`${url}/status/sessions/history/all`, {
      params: {
        "viewedAt>": Math.floor(since / 1000) - 1,
        "viewedAt<": Math.ceil(until / 1000),
        accountID: accountId,
        sort: "viewedAt:asc",
        "X-Plex-Container-Start": start,
        "X-Plex-Container-Size": PAGE_SIZE,
      },
      headers: plexHeaders(secret),
      timeout: TIMEOUT_MS,
    });
    const container = object(object(data).MediaContainer);
    if (!Array.isArray(container.Metadata) && container.size !== 0)
      throw new HistoryServerError("Plex history is unavailable");
    const rows = list(container.Metadata).map(object);
    yield rows
      .filter((row) => row.type === "track")
      .map((row) => ({
        id: text(row.historyKey) || `${text(row.ratingKey)}:${number(row.viewedAt)}`,
        trackId: text(row.ratingKey),
        playedAt: number(row.viewedAt) * 1000,
        title: text(row.title),
        artist: text(row.originalTitle) || text(row.grandparentTitle),
        album: text(row.parentTitle),
      }));
    if (rows.length < PAGE_SIZE) return;
  }
};

const jellyfinHeaders = (apiKey: string) => ({
  Authorization: `MediaBrowser Client="Aurral", Device="Aurral", DeviceId="aurral", Version="1", Token="${apiKey}"`,
});

async function playbackReporting({ url, secret }: Connection, sql: string) {
  try {
    const { data } = await axios.post(
      `${url}/user_usage_stats/submit_custom_query`,
      { CustomQueryString: sql, ReplaceUserId: false },
      { headers: jellyfinHeaders(secret), timeout: TIMEOUT_MS },
    );
    const result = object(data);
    if (!Array.isArray(result.results)) throw new Error(text(result.message));
    return result.results.map(list);
  } catch (error) {
    if (Number(asAppError(error)?.response?.status) === 404)
      throw new HistoryServerError("Install the Playback Reporting plugin in Jellyfin");
    throw error;
  }
}

// Playback Reporting stores times in the server's local time. The date range
// uses today's offset, which the sync overlap absorbs, and each play converts
// with the offset of its own date.
async function jellyfinOffsetMs(connection: Connection) {
  const [row] = await playbackReporting(
    connection,
    "SELECT CAST(strftime('%s','now','localtime') AS INTEGER) - CAST(strftime('%s','now') AS INTEGER)",
  );
  return number(row?.[0]) * 1000;
}

const jellyfin: Provider = {
  async connect(connection) {
    const { data } = await axios.get(`${connection.url}/Users`, {
      headers: jellyfinHeaders(connection.secret),
      timeout: TIMEOUT_MS,
    });
    const user = list(data)
      .map(object)
      .find((candidate) => sameName(candidate.Name, connection.username));
    if (!user) throw new HistoryServerError(`Jellyfin has no user named ${connection.username}`);
    await jellyfinOffsetMs(connection);
    return { accountId: text(user.Id) };
  },
  async *read(connection, since, until) {
    const offset = await jellyfinOffsetMs(connection);
    const local = (time: number) =>
      new Date(time + offset).toISOString().slice(0, 19).replace("T", " ");
    const user = String(connection.accountId).replaceAll("-", "").replaceAll("'", "''");
    for (let start = 0; ; start += PAGE_SIZE) {
      const rows = await playbackReporting(
        connection,
        `SELECT DateCreated, ItemId, CAST(strftime('%s', substr(DateCreated, 1, 19), 'utc') AS INTEGER) FROM PlaybackActivity WHERE REPLACE(UserId, '-', '') = '${user}' AND ItemType = 'Audio' AND DateCreated >= '${local(since)}' AND DateCreated < '${local(until)}' ORDER BY DateCreated LIMIT ${PAGE_SIZE} OFFSET ${start}`,
      );
      const items = new Map<string, Record<string, unknown>>();
      const ids = [...new Set(rows.map((row) => text(row[1])).filter(Boolean))];
      for (let index = 0; index < ids.length; index += 100) {
        const { data } = await axios.get(`${connection.url}/Items`, {
          params: {
            ids: ids.slice(index, index + 100).join(","),
            userId: connection.accountId,
            enableImages: false,
          },
          headers: jellyfinHeaders(connection.secret),
          timeout: TIMEOUT_MS,
        });
        for (const item of list(object(data).Items).map(object)) items.set(text(item.Id), item);
      }
      yield rows.map((row) => {
        const item = items.get(text(row[1])) ?? {};
        const date = text(row[0]).slice(0, 19).replace(" ", "T");
        return {
          id: `${date}:${text(row[1])}`,
          trackId: text(row[1]),
          playedAt: number(row[2]) * 1000,
          title: text(item.Name),
          artist: text(list(item.Artists)[0]),
          album: text(item.Album),
          durationMs: number(item.RunTimeTicks) / 10_000 || undefined,
        };
      });
      if (rows.length < PAGE_SIZE) return;
    }
  },
};

const PROVIDERS: Record<LoginHistoryServer, Provider> = { navidrome, jellyfin };
const READERS: Record<HistoryServerProvider, Reader> = {
  navidrome: navidrome.read,
  plex: readPlex,
  jellyfin: jellyfin.read,
};

const selectServer = db.prepare<[number, string], HistoryServersRow>(
  "SELECT * FROM history_servers WHERE user_id = ? AND provider = ?",
);
const selectUserServers = db.prepare<[number], HistoryServersRow>(
  "SELECT * FROM history_servers WHERE user_id = ? ORDER BY provider",
);
const selectAllServers = db.prepare<[], Pick<HistoryServersRow, "user_id" | "provider">>(
  "SELECT user_id, provider FROM history_servers ORDER BY user_id, provider",
);
const upsertServer = db.prepare<[number, string, string, string, string, string | null, number]>(`
  INSERT INTO history_servers (user_id, provider, url, username, secret, account_id, connected_at)
  VALUES (?, ?, ?, ?, ?, ?, ?)
  ON CONFLICT (user_id, provider) DO UPDATE SET
    url = excluded.url,
    username = excluded.username,
    secret = excluded.secret,
    account_id = excluded.account_id,
    last_error = NULL
`);
const recordSync = db.prepare<[number | null, number, string | null, number, string, number]>(`
  UPDATE history_servers
  SET synced_until = COALESCE(?, synced_until), last_synced_at = ?, last_error = ?
  WHERE user_id = ? AND provider = ? AND connected_at = ?
`);
const deleteServer = db.prepare<[number, string]>(
  "DELETE FROM history_servers WHERE user_id = ? AND provider = ?",
);
const deleteImportedPlays = db.prepare<[number, string]>(
  "DELETE FROM play_events WHERE user_id = ? AND source = ? AND external_id IS NOT NULL",
);
const countImportedPlays = db.prepare<[number, string], { plays: number }>(
  "SELECT COUNT(*) AS plays FROM play_events WHERE user_id = ? AND source = ? AND external_id IS NOT NULL",
);
const insertPlay = db.prepare<
  [
    number,
    string,
    string,
    string,
    string | null,
    string | null,
    string | null,
    number | null,
    number,
    string,
    number,
    string,
  ]
>(`
  INSERT OR IGNORE INTO play_events
    (user_id, track_id, title, artist, album, artist_mbid, track_mbid, duration_ms,
     played_at, source, created_at, external_id)
  VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
`);

// A disconnect or account change during an import makes the rest of it stale.
const insertPlays = db.transaction(
  (userId: number, provider: HistoryServerProvider, connectedAt: number, plays: ImportedPlay[]) => {
    if (selectServer.get(userId, provider)?.connected_at !== connectedAt) return null;
    const now = Date.now();
    let inserted = 0;
    for (const play of plays) {
      if (!play.title || !play.artist || !play.id || !Number.isFinite(play.playedAt)) continue;
      inserted += insertPlay.run(
        userId,
        `${provider}:${play.trackId || play.id}`,
        play.title,
        play.artist,
        play.album || null,
        play.artistMbid || null,
        play.trackMbid || null,
        play.durationMs ? Math.round(play.durationMs) : null,
        play.playedAt,
        provider,
        now,
        play.id,
      ).changes;
    }
    return inserted;
  },
);

const secretKey = () => getSettingsEncryptionKey();

function connectionOf(row: HistoryServersRow): Connection {
  if (row.provider === "plex") {
    const server = getPlexServer();
    if (!server)
      throw new HistoryServerError(
        "Plex isn't connected. An admin can connect it in Settings > Listening > Plex.",
      );
    if (server.url !== row.url)
      throw new HistoryServerError(
        "The Plex server changed. Disconnect, then sign in with Plex again.",
      );
    return {
      url: server.url,
      username: row.username,
      secret: server.token,
      accountId: row.account_id,
    };
  }
  return {
    url: row.url,
    username: row.username,
    secret: decryptWithKey(row.secret, secretKey()) || "",
    accountId: row.account_id,
  };
}

const publicStatus = (row: HistoryServersRow) => ({
  provider: row.provider,
  url: row.url,
  username: row.username,
  connectedAt: row.connected_at,
  lastSyncedAt: row.last_synced_at,
  lastError: row.last_error,
  plays: countImportedPlays.get(row.user_id, row.provider)?.plays ?? 0,
});

export function listHistoryServers(userId: number) {
  return selectUserServers.all(userId).map(publicStatus);
}

export async function connectHistoryServer(
  userId: number,
  provider: LoginHistoryServer,
  input: { url: string; username: string; secret: string | null },
) {
  const existing = selectServer.get(userId, provider);
  const secret = input.secret || (existing ? connectionOf(existing).secret : "");
  if (!secret) throw new HistoryServerError("Enter the password, token, or API key");
  const connection = { url: input.url, username: input.username, secret, accountId: null };
  const { accountId } = await PROVIDERS[provider].connect(connection);
  return saveConnection(userId, provider, { ...connection, accountId });
}

export function connectPlexHistory(
  userId: number,
  account: { url: string; username: string; accountId: string },
) {
  return saveConnection(userId, "plex", { ...account, secret: "" });
}

async function saveConnection(userId: number, provider: HistoryServerProvider, input: Connection) {
  const { accountId, secret } = input;
  const removed = db.transaction(() => {
    const current = selectServer.get(userId, provider);
    const sameAccount =
      current?.url === input.url &&
      current.username === input.username &&
      current.account_id === accountId;
    const removedPlays = current && !sameAccount ? removeConnection(userId, provider) : 0;
    upsertServer.run(
      userId,
      provider,
      input.url,
      input.username,
      encryptWithKey(secret, secretKey()) || "",
      accountId,
      sameAccount ? current.connected_at : Date.now(),
    );
    return removedPlays;
  })();
  if (removed > 0) await refreshDiscovery(userId);
  return publicStatus(selectServer.get(userId, provider)!);
}

const removeConnection = db.transaction((userId: number, provider: HistoryServerProvider) => {
  const { changes } = deleteImportedPlays.run(userId, provider);
  deleteServer.run(userId, provider);
  return changes;
});

async function refreshDiscovery(userId: number) {
  const { requestUserDiscoveryRefresh } = await import("./discovery/index.ts");
  requestUserDiscoveryRefresh(userId, { reason: "listening_history" });
}

export async function disconnectHistoryServer(userId: number, provider: HistoryServerProvider) {
  if (removeConnection(userId, provider) > 0) await refreshDiscovery(userId);
}

export async function syncHistoryServer(userId: number, provider: HistoryServerProvider) {
  const row = selectServer.get(userId, provider);
  if (!row) return { imported: 0 };
  const until = Date.now();
  const since = Math.max(0, (row.synced_until ?? 0) - OVERLAP_MS);
  let imported = 0;
  try {
    for await (const plays of READERS[provider](connectionOf(row), since, until)) {
      const inserted = insertPlays(userId, provider, row.connected_at, plays);
      if (inserted === null) return { imported };
      imported += inserted;
    }
    recordSync.run(until, Date.now(), null, userId, provider, row.connected_at);
  } catch (error) {
    const message = asAppError(error)?.message || "Sync failed";
    recordSync.run(null, Date.now(), message, userId, provider, row.connected_at);
    throw error;
  }
  if (imported > 0) await refreshDiscovery(userId);
  return { imported };
}

export async function syncAllHistoryServers() {
  for (const { user_id, provider } of selectAllServers.all()) {
    if (!v.is(v.picklist(HISTORY_SERVER_PROVIDERS), provider)) continue;
    await syncHistoryServer(user_id, provider).catch(() => {});
  }
}
