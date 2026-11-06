import crypto from "node:crypto";
import * as v from "valibot";
import axios from "../../lib/axiosFetch.ts";
import { asAppError } from "../../lib/errors.ts";
import { decryptWithKey, encryptWithKey } from "../config/encryption.ts";
import { dbOps } from "../db/helpers/index.ts";
import { getSettingsEncryptionKey } from "../db/helpers/settings.ts";

const PLEX_TV = "https://plex.tv";
const SERVER_KEY = "plexServer";
const PLAYLIST_STATUS_KEY = "plexPlaylistStatus";
const PENDING_REMOVALS_KEY = "plexPendingRemovals";
const TIMEOUT_MS = 30_000;
const SIGN_IN_TTL_MS = 10 * 60 * 1000;
const OWNER_ACCOUNT_ID = "1";

const plexServerSchema = v.object({
  url: v.string(),
  token: v.string(),
  sendPlaylists: v.boolean(),
});
const serverSchema = v.nullable(plexServerSchema);
const playlistStatusSchema = v.nullable(v.object({ error: v.nullable(v.string()) }));
const pendingRemovalsSchema = v.nullable(v.array(v.string()));
const record = v.record(v.string(), v.unknown());
const object = (value: unknown) => (v.is(record, value) ? value : {});
const list = (value: unknown): unknown[] => (Array.isArray(value) ? value : []);
const text = (value: unknown) =>
  typeof value === "string" ? value.trim() : typeof value === "number" ? String(value) : "";

export type PlexServer = v.InferOutput<typeof plexServerSchema>;
export class PlexError extends Error {}

const plexHeaders = (token?: string, clientId = "aurral") => ({
  Accept: "application/json",
  "X-Plex-Client-Identifier": clientId,
  "X-Plex-Product": "Aurral",
  ...(token && { "X-Plex-Token": token }),
});

export function getPlexServer(): PlexServer | null {
  const stored = dbOps.getJSONSetting(SERVER_KEY, serverSchema);
  if (!stored) return null;
  return { ...stored, token: decryptWithKey(stored.token, getSettingsEncryptionKey()) || "" };
}

export function savePlexServer(server: PlexServer) {
  dbOps.setJSONSetting(SERVER_KEY, {
    ...server,
    token: encryptWithKey(server.token, getSettingsEncryptionKey()),
  });
  if (!server.sendPlaylists) setPlaylistError(null);
}

export function removePlexServer() {
  dbOps.setJSONSetting(SERVER_KEY, null);
  setPlaylistError(null);
  setPendingRemovals([]);
}

export function plexPlaylistError() {
  return dbOps.getJSONSetting(PLAYLIST_STATUS_KEY, playlistStatusSchema)?.error ?? null;
}

function setPlaylistError(error: string | null) {
  dbOps.setJSONSetting(PLAYLIST_STATUS_KEY, { error });
}

const pendingRemovals = () =>
  dbOps.getJSONSetting(PENDING_REMOVALS_KEY, pendingRemovalsSchema) ?? [];
const setPendingRemovals = (titles: string[]) => dbOps.setJSONSetting(PENDING_REMOVALS_KEY, titles);

const pendingSignIns = new Map<
  string,
  { userId: number; code: string; clientId: string; expiresAt: number }
>();

export async function startPlexSignIn(userId: number) {
  const now = Date.now();
  for (const [id, pending] of pendingSignIns)
    if (pending.expiresAt <= now) pendingSignIns.delete(id);
  const clientId = crypto.randomUUID();
  const { data } = await axios.post(`${PLEX_TV}/api/v2/pins`, null, {
    params: { strong: true },
    headers: plexHeaders(undefined, clientId),
    timeout: TIMEOUT_MS,
  });
  const pin = object(data);
  const id = text(pin.id);
  const code = text(pin.code);
  if (!id || !code) throw new PlexError("Plex didn't start the sign-in");
  pendingSignIns.set(id, { userId, code, clientId, expiresAt: now + SIGN_IN_TTL_MS });
  const query = new URLSearchParams({
    clientID: clientId,
    code,
    "context[device][product]": "Aurral",
  });
  return { id, authUrl: `https://app.plex.tv/auth#?${query}` };
}

export async function finishPlexSignIn(userId: number, id: string) {
  const pending = pendingSignIns.get(id);
  if (!pending || pending.userId !== userId || pending.expiresAt <= Date.now())
    throw new PlexError("The Plex sign-in expired. Try again.");
  const { data } = await axios.get(`${PLEX_TV}/api/v2/pins/${encodeURIComponent(id)}`, {
    params: { code: pending.code },
    headers: plexHeaders(undefined, pending.clientId),
    timeout: TIMEOUT_MS,
  });
  const token = text(object(data).authToken);
  if (token) pendingSignIns.delete(id);
  return token || null;
}

async function plexTvUser(token: string) {
  const { data } = await axios.get(`${PLEX_TV}/api/v2/user`, {
    headers: plexHeaders(token),
    timeout: TIMEOUT_MS,
  });
  const user = object(data);
  const id = text(user.id);
  if (!id) throw new PlexError("Plex didn't return the account");
  return { id, username: text(user.username) || text(user.title) || id };
}

async function serverAccounts(url: string, token: string) {
  try {
    const { data } = await axios.get(`${url}/accounts`, {
      headers: plexHeaders(token),
      timeout: TIMEOUT_MS,
    });
    return list(object(object(data).MediaContainer).Account).map((account) =>
      text(object(account).id),
    );
  } catch (error) {
    const status = Number(asAppError(error)?.response?.status);
    if (status === 401 || status === 403)
      throw new PlexError("Sign in with the Plex account that owns this server");
    throw error;
  }
}

export async function connectPlexServer(url: string, token: string) {
  await serverAccounts(url, token);
  const owner = await plexTvUser(token);
  savePlexServer({ url, token, sendPlaylists: true });
  setPendingRemovals([]);
  return { username: owner.username, accountId: OWNER_ACCOUNT_ID };
}

// Plex lists the server owner as account 1, and everyone else by their plex.tv ID.
export async function plexHistoryAccount(server: PlexServer, userToken: string) {
  const [user, owner, accounts] = await Promise.all([
    plexTvUser(userToken),
    plexTvUser(server.token),
    serverAccounts(server.url, server.token),
  ]);
  if (user.id === owner.id) return { username: user.username, accountId: OWNER_ACCOUNT_ID };
  if (!accounts.includes(user.id))
    throw new PlexError(`${user.username} doesn't have access to this Plex server`);
  return { username: user.username, accountId: user.id };
}

async function musicSectionFor(server: PlexServer, folder: string) {
  const { data } = await axios.get(`${server.url}/library/sections`, {
    headers: plexHeaders(server.token),
    timeout: TIMEOUT_MS,
  });
  const section = list(object(object(data).MediaContainer).Directory)
    .map(object)
    .find(
      (directory) =>
        directory.type === "artist" &&
        list(directory.Location).some((location) => {
          const root = text(object(location).path).replace(/\/+$/, "");
          return root && (folder === root || folder.startsWith(`${root}/`));
        }),
    );
  if (!section) throw new PlexError(`No Plex music library has ${folder}`);
  return text(section.key);
}

async function plexPlaylistKeys(server: PlexServer, title: string) {
  const { data } = await axios.get(`${server.url}/playlists`, {
    params: { playlistType: "audio" },
    headers: plexHeaders(server.token),
    timeout: TIMEOUT_MS,
  });
  return list(object(object(data).MediaContainer).Metadata)
    .map(object)
    .filter((playlist) => playlist.title === title && playlist.smart !== true)
    .map((playlist) => text(playlist.ratingKey));
}

async function deletePlexPlaylist(server: PlexServer, title: string) {
  for (const key of await plexPlaylistKeys(server, title)) {
    await axios.delete(`${server.url}/playlists/${encodeURIComponent(key)}`, {
      headers: plexHeaders(server.token),
      timeout: TIMEOUT_MS,
    });
  }
}

type PlaylistFile = { title: string; path: string; empty: boolean };

// Plex reads each file from its own disk, so it has to see the Library folder
// at the same path as Aurral. A file with no track Plex knows fails with a 500.
export async function sendPlaylistsToPlex(
  libraryFolder: string,
  { upload, remove }: { upload: PlaylistFile[]; remove: string[] },
) {
  const server = getPlexServer();
  if (!server?.sendPlaylists) return;
  const removals = [...new Set([...pendingRemovals(), ...remove])];
  if (!upload.length && !removals.length) return;
  const stillSending = () => {
    const current = getPlexServer();
    return current?.sendPlaylists === true && current.url === server.url;
  };
  try {
    while (removals[0] !== undefined) {
      await deletePlexPlaylist(server, removals[0]);
      removals.shift();
    }
    const files = upload.filter((file) => !file.empty);
    for (const file of upload) if (file.empty) await deletePlexPlaylist(server, file.title);
    const sectionId = files.length ? await musicSectionFor(server, libraryFolder) : "";
    for (const file of files) {
      if (!stillSending()) return;
      try {
        await axios.post(`${server.url}/playlists/upload`, null, {
          params: { sectionID: sectionId, path: file.path },
          headers: plexHeaders(server.token),
          timeout: TIMEOUT_MS,
        });
      } catch (error) {
        if (Number(asAppError(error)?.response?.status) !== 500) throw error;
        throw new PlexError(
          `Plex found none of the tracks in ${file.title}. Plex has to see the Library folder at ${libraryFolder}.`,
        );
      }
    }
    setPlaylistError(null);
  } catch (error) {
    setPlaylistError(
      error instanceof PlexError ? error.message : "Couldn't send playlists to Plex",
    );
  } finally {
    setPendingRemovals(removals);
  }
}

export async function removePlaylistsFromPlex(titles: string[]) {
  const server = getPlexServer();
  if (!server) return;
  for (const title of new Set([...pendingRemovals(), ...titles]))
    await deletePlexPlaylist(server, title).catch(() => {});
  setPendingRemovals([]);
}
