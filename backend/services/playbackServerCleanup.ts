import * as v from "valibot";
import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import axios from "../../lib/axiosFetch.ts";
import { asAppError } from "../../lib/errors.ts";
import { db } from "../config/db-sqlite.ts";
import { decryptWithKey } from "../config/encryption.ts";
import { dbOps } from "../db/helpers/index.ts";
import { getSettingsEncryptionKey } from "../db/helpers/settings.ts";
import { isPathInsideRoot, resolveDownloadRoot } from "./downloadPaths.ts";
import { logger } from "./logger.ts";
import { getPlaylistFileSettings, savePlaylistFileSettings } from "./playlists/playlistFiles.ts";

// Aurral used to publish playlists to Navidrome, Plex, and Jellyfin through
// their APIs. Playlist files replace them, so this removes the old copies once
// and forgets the connections.

const SERVERS = ["navidrome", "plex", "jellyfin"] as const;
const POINTER_KEYS = {
  navidrome: "navidromePlaylistPointers",
  plex: "plexPlaylistPointers",
  jellyfin: "jellyfinPlaylistPointers",
} as const;
const LEGACY_KEYS = [...Object.values(POINTER_KEYS), "plexConnections", "playbackRetainedFiles"];
const ATTEMPTS_KEY = "playbackServerCleanup";
const MAX_ATTEMPTS = 5;
const TIMEOUT_MS = 20_000;

const text = v.fallback(v.string(), "");
const navidromeSchema = v.looseObject({ url: text, username: text, password: text });
const plexSchema = v.looseObject({ url: text, token: text, clientId: text });
const jellyfinSchema = v.looseObject({ url: text, apiKey: text });
const prefixSchema = v.looseObject({ prefixOwnerUsername: v.optional(v.boolean()) });
const recordSchema = v.record(v.string(), v.unknown());
const pointerSchema = v.looseObject({
  playlistId: v.optional(v.nullable(v.union([v.string(), v.number()]))),
  ratingKey: v.optional(v.nullable(v.union([v.string(), v.number()]))),
  location: v.optional(v.string()),
});
const plexConnectionSchema = v.looseObject({ token: v.string(), clientId: v.optional(v.string()) });
const attemptsSchema = v.looseObject({ attempts: v.number() });

type Outcome = "done" | "retry";
type Pointer = v.InferOutput<typeof pointerSchema> & { targetKey: string };

const settingRow = db.prepare<[string], { value: string | null }>(
  "SELECT value FROM settings WHERE key = ?",
);
const deleteSetting = db.prepare<[string]>("DELETE FROM settings WHERE key = ?");
const plexIdentity = db.prepare(
  "SELECT 1 FROM user_identities WHERE provider_type = 'plex' LIMIT 1",
);
const deletePlexIdentities = db.prepare("DELETE FROM user_identities WHERE provider_type = 'plex'");

const readSetting = <Schema extends v.GenericSchema>(key: string, schema: Schema) => {
  const value = settingRow.get(key)?.value;
  if (!value) return null;
  try {
    const parsed: unknown = JSON.parse(value);
    return v.is(schema, parsed) ? parsed : null;
  } catch {
    return null;
  }
};

const decrypt = (value: string) => decryptWithKey(value, getSettingsEncryptionKey()) || "";
const baseUrl = (url: string) => url.trim().replace(/\/+$/, "");

function legacyIntegrations() {
  const integrations: Record<string, unknown> = dbOps.getSettings().integrations;
  return {
    navidrome: v.is(navidromeSchema, integrations.navidrome) ? integrations.navidrome : null,
    plex: v.is(plexSchema, integrations.plex) ? integrations.plex : null,
    jellyfin: v.is(jellyfinSchema, integrations.jellyfin) ? integrations.jellyfin : null,
  };
}

export function hasLegacyPlaybackServerData() {
  const integrations: Record<string, unknown> = dbOps.getSettings().integrations;
  return (
    SERVERS.some((server) => integrations[server] !== undefined) ||
    LEGACY_KEYS.some((key) => settingRow.get(key) !== undefined) ||
    plexIdentity.get() !== undefined
  );
}

function pointersOf(key: string) {
  const store = readSetting(key, recordSchema) ?? {};
  return Object.values(store).flatMap((targets) =>
    Object.entries(v.is(recordSchema, targets) ? targets : {}).flatMap(([targetKey, raw]) =>
      v.is(pointerSchema, raw) ? [{ ...raw, targetKey }] : [],
    ),
  );
}

const statusOf = (error: unknown) => Number(asAppError(error)?.response?.status);

// A playlist that is already gone, or a server that rejects the old login,
// can never be cleaned up, so neither is worth retrying. A server that does
// not answer is tried again on the next start.
async function deleteAll(requests: (() => Promise<unknown>)[]): Promise<Outcome> {
  for (const request of requests) {
    try {
      await request();
    } catch (error) {
      if (![401, 403, 404].includes(statusOf(error))) return "retry";
    }
  }
  return "done";
}

function navidromeDeletes(pointers: Pointer[]) {
  const config = legacyIntegrations().navidrome;
  if (!config?.url || !config.username || !config.password) return [];
  const password = decrypt(config.password);
  return pointers.flatMap((pointer) => {
    if (pointer.playlistId == null) return [];
    return [
      async () => {
        const salt = crypto.randomBytes(6).toString("hex");
        const query = new URLSearchParams({
          u: config.username,
          t: crypto
            .createHash("md5")
            .update(password + salt)
            .digest("hex"),
          s: salt,
          v: "1.16.1",
          c: "aurral",
          f: "json",
          id: String(pointer.playlistId),
        });
        const { data } = await axios.get(
          `${baseUrl(config.url)}/rest/deletePlaylist.view?${query}`,
          {
            timeout: TIMEOUT_MS,
          },
        );
        const response = v.is(recordSchema, data) ? data["subsonic-response"] : null;
        if (!v.is(recordSchema, response) || response.status !== "failed") return;
        const code = v.is(recordSchema, response.error) ? Number(response.error.code) : 0;
        if (![40, 41, 50, 70].includes(code)) throw new Error("Navidrome rejected the delete");
      },
    ];
  });
}

function plexDeletes(pointers: Pointer[]) {
  const config = legacyIntegrations().plex;
  if (!config?.url) return [];
  const connections = readSetting("plexConnections", recordSchema) ?? {};
  return pointers.flatMap((pointer) => {
    const linked = connections[pointer.targetKey];
    const token =
      pointer.location !== "global" && v.is(plexConnectionSchema, linked)
        ? decrypt(linked.token)
        : decrypt(config.token);
    if (pointer.ratingKey == null || !token) return [];
    const url = `${baseUrl(config.url)}/playlists/${encodeURIComponent(String(pointer.ratingKey))}`;
    return [
      () =>
        axios.delete(url, {
          headers: {
            "X-Plex-Token": token,
            "X-Plex-Client-Identifier": config.clientId || "aurral",
          },
          timeout: TIMEOUT_MS,
        }),
    ];
  });
}

function jellyfinDeletes(pointers: Pointer[]) {
  const config = legacyIntegrations().jellyfin;
  if (!config?.url || !config.apiKey) return [];
  const token = decrypt(config.apiKey);
  return pointers.flatMap((pointer) => {
    if (pointer.playlistId == null) return [];
    const url = `${baseUrl(config.url)}/Items/${encodeURIComponent(String(pointer.playlistId))}`;
    return [
      () =>
        axios.delete(url, {
          headers: {
            Authorization: `MediaBrowser Client="Aurral", Device="Aurral", DeviceId="aurral", Version="1", Token="${token}"`,
          },
          timeout: TIMEOUT_MS,
        }),
    ];
  });
}

// These files were already removed from every Aurral playlist, but Aurral kept
// them because a media server playlist still listed them.
async function removeRetainedFiles() {
  const retained = readSetting("playbackRetainedFiles", recordSchema) ?? {};
  const root = path.resolve(resolveDownloadRoot());
  const { downloadTracker } = await import("./downloadJobs/downloadTracker.ts");
  const owned = new Set(
    downloadTracker.getAll().flatMap((job) => (job.finalPath ? [path.resolve(job.finalPath)] : [])),
  );
  const removed: string[] = [];
  for (const file of Object.keys(retained)) {
    const resolved = path.resolve(file);
    if (owned.has(resolved) || !isPathInsideRoot(resolved, root)) continue;
    const stat = await fs.lstat(resolved).catch(() => null);
    if (!stat?.isFile()) continue;
    if (!isPathInsideRoot(await fs.realpath(resolved), await fs.realpath(root))) continue;
    await fs.rm(resolved, { force: true });
    removed.push(resolved);
  }
  return removed;
}

function forgetLegacyData() {
  const integrations: Record<string, unknown> = { ...dbOps.getSettings().integrations };
  for (const server of SERVERS) delete integrations[server];
  dbOps.updateSettings({ integrations });
  for (const key of [...LEGACY_KEYS, ATTEMPTS_KEY]) deleteSetting.run(key);
  deletePlexIdentities.run();
}

function keepOwnerPrefixChoice() {
  if (readSetting("playlistFiles", prefixSchema)) return;
  const navidrome: unknown = dbOps.getSettings().integrations.navidrome;
  const choice = v.is(prefixSchema, navidrome) ? navidrome.prefixOwnerUsername : undefined;
  if (choice === false)
    savePlaylistFileSettings({ ...getPlaylistFileSettings(), prefixOwnerUsername: false });
}

export async function cleanUpPlaybackServers() {
  keepOwnerPrefixChoice();
  const outcomes = {
    navidrome: await deleteAll(navidromeDeletes(pointersOf(POINTER_KEYS.navidrome))),
    plex: await deleteAll(plexDeletes(pointersOf(POINTER_KEYS.plex))),
    jellyfin: await deleteAll(jellyfinDeletes(pointersOf(POINTER_KEYS.jellyfin))),
  };
  const pending = SERVERS.filter((server) => outcomes[server] === "retry");
  const attempts = (readSetting(ATTEMPTS_KEY, attemptsSchema)?.attempts ?? 0) + 1;
  if (pending.length && attempts < MAX_ATTEMPTS) {
    dbOps.setJSONSetting(ATTEMPTS_KEY, { attempts });
    logger.warn("playback", "Could not remove old media server playlists yet", {
      servers: pending.join(", "),
      attempt: attempts,
    });
    return { pending, removedFiles: [] };
  }
  const removedFiles = await removeRetainedFiles();
  forgetLegacyData();
  if (removedFiles.length) {
    const { scheduleLibraryScan } = await import("./libraryScanWorker.ts");
    scheduleLibraryScan({ includeLidarr: false, changedPaths: removedFiles });
  }
  return { pending, removedFiles };
}
