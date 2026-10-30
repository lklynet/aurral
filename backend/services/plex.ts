import * as v from "valibot";
import axios from "../../lib/axiosFetch.ts";
import { asAppError } from "../../lib/errors.ts";
import crypto from "crypto";
import { XMLParser } from "fast-xml-parser";
import { AURRAL_FLOWS_DIR } from "./downloadPaths.ts";
import { readMany, readOne } from "./integrationData.ts";
import { readPlaylistPages, requirePlaylistPath } from "./playback/playlistUsage.ts";

const PLEX_TV = "https://plex.tv";
const PLEX_AUTH_APP = "https://app.plex.tv";
const PLEX_PRODUCT = "Aurral";
// Plex music libraries use the "artist" section type with these defaults.
export const MUSIC_SECTION_TYPE = "artist";
const MUSIC_AGENT = "tv.plex.agents.music";
const MUSIC_SCANNER = "Plex Music";
const TRACK_TYPE = 10; // Plex metadata type for audio tracks
const READ_TIMEOUT_MS = 30_000;

const mediaContainer = <Entries extends v.ObjectEntries>(entries: Entries) =>
  v.looseObject({ MediaContainer: v.looseObject(entries) });

const pinSchema = v.looseObject({
  id: v.number(),
  code: v.string(),
  authToken: v.nullish(v.string()),
});

const identitySchema = mediaContainer({
  machineIdentifier: v.string(),
  version: v.optional(v.string()),
});

const sectionsSchema = mediaContainer({ Directory: v.optional(v.array(v.unknown())) });

const librarySchema = v.looseObject({
  key: v.string(),
  type: v.string(),
  title: v.string(),
  Location: v.optional(v.array(v.looseObject({ path: v.string() }))),
});

const pageSchema = mediaContainer({
  size: v.number(),
  totalSize: v.optional(v.number()),
  Metadata: v.optional(v.array(v.unknown())),
});

const metadataSchema = v.looseObject({
  ratingKey: v.string(),
  title: v.optional(v.string()),
  grandparentTitle: v.optional(v.string()),
  originalTitle: v.optional(v.string()),
  addedAt: v.optional(v.number()),
  Media: v.optional(
    v.array(
      v.looseObject({
        Part: v.optional(v.array(v.looseObject({ file: v.optional(v.string()) }))),
      }),
    ),
  ),
});

const playlistSchema = v.looseObject({
  ratingKey: v.string(),
  title: v.string(),
  leafCount: v.optional(v.number()),
});

const playlistItemSchema = v.looseObject({
  ratingKey: v.string(),
  playlistItemID: v.number(),
});

const trackFiles = (track: v.InferOutput<typeof metadataSchema>) =>
  (track.Media ?? []).flatMap((media) =>
    (media.Part ?? []).flatMap((part) => (part.file ? [part.file] : [])),
  );

type PlexConnection = { uri?: string; local?: unknown; address?: string; port?: number | string };
type PlexResource = {
  name?: string;
  clientIdentifier?: string;
  provides?: string;
  owned?: unknown;
  accessToken?: string;
  connections?: PlexConnection | PlexConnection[];
  Connection?: PlexConnection | PlexConnection[];
};
type PlexUserRecord = {
  id: string | number;
  uuid?: string | null;
  title?: string;
  username?: string;
  friendlyName?: string;
  email?: string;
  restricted?: unknown;
  admin?: unknown;
  guest?: unknown;
  authenticationToken?: string;
  authToken?: string;
};
type PlexQueryParams = Record<string, string | number | boolean | null | undefined>;
type PlexRequestOptions = {
  params?: PlexQueryParams;
  method?: "GET" | "POST" | "PUT" | "DELETE";
  data?: unknown;
  timeout?: number;
};

const xmlParser = new XMLParser({
  ignoreAttributes: false,
  attributeNamePrefix: "",
  htmlEntities: true,
});

function findPlexXmlElements(xml: string, name: string) {
  const found: PlexUserRecord[] = [];
  const visit = (node: unknown) => {
    if (!node || typeof node !== "object") return;
    for (const [key, value] of Object.entries(node)) {
      if (key.toLowerCase() === name) found.push(...[value].flat());
      else [value].flat().forEach(visit);
    }
  };
  visit(xmlParser.parse(xml));
  return found;
}

function toBool(value: unknown) {
  return value === true || value === "1" || value === 1;
}

type PlexHomeUser = {
  id: string | number;
  uuid?: string | null;
  title?: string;
  username: string | null;
  email: string | null;
  restricted: boolean;
  admin: boolean;
  guest: boolean;
};

export class PlexClient {
  declare url: string | null;
  declare token: string | null;
  declare clientId: string | null;
  declare _machineIdentifier: string | null;

  constructor(
    url: string | null | undefined,
    token: string | null | undefined,
    clientId: string | null | undefined,
  ) {
    this.url = url ? url.replace(/\/+$/, "") : null;
    this.token = token || null;
    this.clientId = clientId || null;
    this._machineIdentifier = null;
  }

  isConfigured() {
    return !!(this.url && this.token);
  }

  static plexHeaders(
    clientId: string | null | undefined,
    { token }: { token?: string | null } = {},
  ) {
    const headers: Record<string, string> = {
      Accept: "application/json",
      "X-Plex-Product": PLEX_PRODUCT,
      "X-Plex-Client-Identifier": String(clientId),
      "X-Plex-Version": "1.0",
      "X-Plex-Platform": "Node.js",
      "X-Plex-Platform-Version": process.version,
      "X-Plex-Device": "Server",
      "X-Plex-Device-Name": PLEX_PRODUCT,
    };
    if (token) headers["X-Plex-Token"] = token;
    return headers;
  }

  static generateClientId() {
    return crypto.randomUUID();
  }

  static async generatePin(clientId: string | null | undefined) {
    const { data } = await axios.post(`${PLEX_TV}/api/v2/pins`, null, {
      params: { strong: true },
      headers: PlexClient.plexHeaders(clientId),
    });
    const pin = readOne(pinSchema, data, { service: "Plex", endpoint: "/api/v2/pins" });
    return { id: pin.id, code: pin.code };
  }

  static buildAuthUrl(clientId: string, code: string, forwardUrl?: string | null) {
    const params = new URLSearchParams({
      clientID: clientId,
      code,
      "context[device][product]": PLEX_PRODUCT,
    });
    if (forwardUrl) params.set("forwardUrl", forwardUrl);
    return `${PLEX_AUTH_APP}/auth#?${params.toString()}`;
  }

  static async checkPin(pinId: string | number, code: string, clientId: string | null | undefined) {
    const { data } = await axios.get(`${PLEX_TV}/api/v2/pins/${pinId}`, {
      params: { code },
      headers: PlexClient.plexHeaders(clientId),
    });
    return (
      readOne(pinSchema, data, { service: "Plex", endpoint: "/api/v2/pins" }).authToken || null
    );
  }

  static async validateToken(
    token: string | null | undefined,
    clientId: string | null | undefined,
    { throwOnTransient = false }: { throwOnTransient?: boolean } = {},
  ) {
    try {
      const { data } = await axios.get(`${PLEX_TV}/api/v2/user`, {
        headers: PlexClient.plexHeaders(clientId, { token }),
      });
      return data || null;
    } catch (error) {
      const status = Number(asAppError(error)?.response?.status) || null;
      if (throwOnTransient && (!status || status === 429 || status >= 500)) throw error;
      return null;
    }
  }

  static async getResources(token: string | null | undefined, clientId: string | null | undefined) {
    const { data } = await axios.get(`${PLEX_TV}/api/v2/resources`, {
      params: { includeHttps: 1, includeRelay: 1 },
      headers: PlexClient.plexHeaders(clientId, { token }),
    });
    // v2 returns a JSON array; tolerate XML-shaped responses too.
    let list: PlexResource[] = [];
    if (Array.isArray(data)) list = data;
    else if (Array.isArray(data?.MediaContainer?.Device)) list = data.MediaContainer.Device;
    else if (data?.MediaContainer?.Device) list = [data.MediaContainer.Device];

    const servers = list
      .filter((r) => String(r.provides || "").includes("server"))
      .map((r) => {
        const rawConns = r.connections || r.Connection || [];
        const conns = Array.isArray(rawConns) ? rawConns : [rawConns];
        return {
          name: r.name,
          clientIdentifier: r.clientIdentifier,
          owned: r.owned === true || r.owned === "1" || r.owned === 1,
          accessToken: r.accessToken || null,
          connections: conns.map((c) => ({
            uri: c.uri,
            local: c.local === true || c.local === "1" || c.local === 1,
            address: c.address,
            port: c.port,
          })),
        };
      });
    console.log(
      `[Plex] getResources: ${list.length} device(s) returned, ${servers.length} provide "server"`,
    );
    return { servers, total: list.length };
  }

  static async getHomeUsers(
    adminToken: string | null | undefined,
    adminClientId: string | null | undefined,
  ): Promise<PlexHomeUser[]> {
    const { data } = await axios.get(`${PLEX_TV}/api/v2/home/users`, {
      headers: PlexClient.plexHeaders(adminClientId, { token: adminToken }),
    });

    let rawUsers: PlexUserRecord[] = [];
    if (typeof data === "string") {
      rawUsers = findPlexXmlElements(data, "user");
    } else if (Array.isArray(data?.users)) {
      rawUsers = data.users;
    } else if (Array.isArray(data?.MediaContainer?.User)) {
      rawUsers = data.MediaContainer.User;
    } else if (data?.MediaContainer?.User) {
      rawUsers = [data.MediaContainer.User];
    } else if (Array.isArray(data)) {
      rawUsers = data;
    }

    return rawUsers.map((u) => ({
      id: u.id,
      uuid: u.uuid,
      title: u.title || u.username || u.friendlyName,
      username: u.username || null,
      email: u.email || null,
      restricted: toBool(u.restricted),
      admin: toBool(u.admin),
      guest: toBool(u.guest),
    }));
  }

  static async switchHomeUser(
    homeUserId: string | number,
    adminToken: string | null | undefined,
    adminClientId: string | null | undefined,
    targetClientId: string | null | undefined,
    pin: string | number | null = null,
  ) {
    const headers = PlexClient.plexHeaders(targetClientId, { token: adminToken });
    const params = pin ? { pin } : {};
    const paths = [
      `${PLEX_TV}/api/v2/home/users/${homeUserId}/switch`,
      `${PLEX_TV}/api/home/users/${homeUserId}/switch`,
    ];

    let lastError: unknown = null;
    for (const path of paths) {
      try {
        const { data } = await axios.post(path, null, { params, headers });
        if (typeof data === "string") {
          const [tag] = findPlexXmlElements(data, "user");
          const token = tag?.authenticationToken || tag?.authToken;
          if (token) return token;
        } else {
          const token =
            data?.authToken || data?.authenticationToken || data?.user?.authToken || null;
          if (token) return token;
        }
        return null;
      } catch (error) {
        lastError = error;
        if (asAppError(error)?.response?.status !== 404) throw error;
      }
    }
    throw lastError || new Error("Plex switch-user request failed");
  }

  async request(
    path: string,
    { params = {}, method = "GET", data = null, timeout = 0 }: PlexRequestOptions = {},
  ) {
    if (!this.isConfigured()) throw new Error("Plex not configured");
    try {
      const response: { data: unknown } = await axios({
        method,
        url: `${this.url}${path}`,
        params,
        data,
        timeout,
        headers: PlexClient.plexHeaders(this.clientId, { token: this.token }),
      });
      return response.data;
    } catch (error) {
      const failure = asAppError(error);
      const detail = failure?.response?.data || failure?.message;
      console.error(
        `Plex Error [${method} ${path}]:`,
        typeof detail === "string" ? detail.slice(0, 200) : failure?.message,
        "| status:",
        failure?.response?.status,
        "| clientId:",
        this.clientId,
        "| headers:",
        JSON.stringify(
          Object.fromEntries(
            Object.entries(failure?.response?.headers || {}).filter(
              ([key]) => !/^(set-cookie|authorization|x-plex-token)$/i.test(key),
            ),
          ),
        ),
      );
      throw error;
    }
  }

  async read<Schema extends v.GenericSchema>(
    schema: Schema,
    path: string,
    options: PlexRequestOptions = {},
  ) {
    return readOne(schema, await this.request(path, options), { service: "Plex", endpoint: path });
  }

  async ping() {
    const { MediaContainer: identity } = await this.read(identitySchema, "/identity");
    this._machineIdentifier = identity.machineIdentifier;
    return identity;
  }

  async getMachineIdentifier() {
    if (this._machineIdentifier) return this._machineIdentifier;
    await this.ping();
    return this._machineIdentifier;
  }

  async getLibraries() {
    const endpoint = "/library/sections";
    const { MediaContainer } = await this.read(sectionsSchema, endpoint, {
      timeout: READ_TIMEOUT_MS,
    });
    return readOne(v.array(librarySchema), MediaContainer.Directory ?? [], {
      service: "Plex",
      endpoint,
    });
  }

  async ensureAurralLibrary(libraryPath: string) {
    if (!this.isConfigured()) return null;
    const name = "Aurral";
    const flowRoot = libraryPath.replace(/\/+$/, "");
    const locations = [libraryPath, `${flowRoot}/${AURRAL_FLOWS_DIR}`];
    // Also match the legacy "Aurral Flow" name so existing libraries are reused
    // and renamed rather than duplicated.
    const findExisting = (libs: Awaited<ReturnType<PlexClient["getLibraries"]>>) =>
      libs.find(
        (lib) =>
          lib.title === name ||
          lib.title === "Aurral Flow" ||
          (lib.Location || []).some((loc) => locations.includes(loc.path)),
      );

    const existing = findExisting(await this.getLibraries());
    if (existing) {
      // Reconcile name + folder so a rename or a changed downloads-path setting
      // actually takes effect (Plex keeps the originals otherwise).
      const currentLocations = (existing.Location || []).map((loc) => loc.path);
      const locationOk =
        currentLocations.length === locations.length &&
        locations.every((location) => currentLocations.includes(location));
      const nameOk = existing.title === name;
      if (!locationOk || !nameOk) {
        try {
          await this.editLibrary(existing.key, { name, locations });
          return findExisting(await this.getLibraries()) || existing;
        } catch (err) {
          const failure = asAppError(err);
          console.warn(
            "[Plex] Could not update Aurral library:",
            failure?.response?.data || failure?.message,
          );
        }
      }
      return existing;
    }

    // POST /library/sections creates the library. Plex's response shape here
    // is inconsistent across versions, so we create then re-read the section
    // list to resolve the new library (and its `key`) reliably.
    try {
      const params = new URLSearchParams({
        name,
        type: MUSIC_SECTION_TYPE,
        agent: MUSIC_AGENT,
        scanner: MUSIC_SCANNER,
        language: "en-US",
      });
      for (const location of locations) params.append("location", location);
      await this.request(`/library/sections?${params.toString()}`, { method: "POST" });
    } catch (err) {
      const failure = asAppError(err);
      const detail = failure?.response?.data || failure?.message;
      const status = failure?.response?.status;
      throw Object.assign(
        new Error(
          `Plex rejected library creation (${status || "no status"}) for path "${libraryPath}": ${
            typeof detail === "string" ? detail : JSON.stringify(detail)
          }`,
        ),
        { response: failure?.response },
      );
    }

    const created = findExisting(await this.getLibraries());
    if (!created) {
      throw new Error(
        `Plex accepted the request but no "Aurral" library appeared. Verify the Plex server can access the path "${libraryPath}".`,
      );
    }
    return created;
  }

  async scanLibrary(sectionId: string | number | null | undefined, folder: string | null = null) {
    if (!this.isConfigured() || sectionId == null) return null;
    return this.request(
      `/library/sections/${sectionId}/refresh`,
      folder ? { params: { path: folder } } : {},
    );
  }

  /**
   * Rename a library section and/or replace its folder locations. Plex expects
   * repeated `location=` query params (no array brackets), so the query is
   * built by hand. The Plex server must be able to browse each path.
   */
  async editLibrary(
    sectionId: string | number,
    { name, locations }: { name?: string; locations?: string[] } = {},
  ) {
    const qs = new URLSearchParams();
    qs.set("agent", MUSIC_AGENT);
    if (name) qs.set("name", name);
    for (const loc of locations || []) qs.append("location", loc);
    return this.request(`/library/sections/${sectionId}?${qs.toString()}`, {
      method: "PUT",
    });
  }

  async getTracks(
    sectionId: string | number,
    { addedSince = null }: { addedSince?: number | null } = {},
  ) {
    const pageSize = 200;
    const endpoint = `/library/sections/${sectionId}/all`;
    const out = [];
    let start = 0;
    for (;;) {
      const { MediaContainer: page } = await this.read(pageSchema, endpoint, {
        timeout: READ_TIMEOUT_MS,
        params: {
          type: TRACK_TYPE,
          ...(addedSince == null ? {} : { "addedAt>": addedSince }),
          "X-Plex-Container-Start": start,
          "X-Plex-Container-Size": pageSize,
        },
      });
      const items = page.Metadata ?? [];
      for (const t of readMany(metadataSchema, items, { service: "Plex", endpoint })) {
        out.push({
          ratingKey: t.ratingKey,
          title: t.title,
          artist: t.grandparentTitle || t.originalTitle,
          addedAt: t.addedAt ?? 0,
          files: trackFiles(t),
        });
      }
      const total = page.totalSize ?? page.size;
      start += items.length;
      if (items.length === 0 || start >= total) break;
    }
    return out;
  }

  async getSampleTrack(sectionId: string | number) {
    const endpoint = `/library/sections/${sectionId}/all`;
    const { MediaContainer: page } = await this.read(pageSchema, endpoint, {
      params: {
        type: TRACK_TYPE,
        "X-Plex-Container-Start": 0,
        "X-Plex-Container-Size": 1,
      },
    });
    const [first] = page.Metadata ?? [];
    if (first === undefined) return null;
    const item = readOne(metadataSchema, first, { service: "Plex", endpoint });
    return { ratingKey: item.ratingKey, title: item.title, files: trackFiles(item) };
  }

  async getPlaylists() {
    const { MediaContainer: page } = await this.read(pageSchema, "/playlists", {
      params: { playlistType: "audio" },
    });
    return readMany(playlistSchema, page.Metadata ?? [], {
      service: "Plex",
      endpoint: "/playlists",
    });
  }

  async getPlaylistTrackPaths(excludedIds = new Set<string>()) {
    const read = (endpoint: string, params: PlexQueryParams = {}) =>
      readPlaylistPages(async (start) => {
        const { MediaContainer: page } = await this.read(pageSchema, endpoint, {
          timeout: 30_000,
          params: {
            ...params,
            "X-Plex-Container-Start": start,
            "X-Plex-Container-Size": 200,
          },
        });
        return {
          items: page.Metadata
            ? readOne(v.array(metadataSchema), page.Metadata, { service: "Plex", endpoint })
            : page.size === 0
              ? []
              : undefined,
          total: page.totalSize,
        };
      });
    const playlists = await read("/playlists", { playlistType: "audio", type: 15 });
    const paths = new Set<string>();
    for (const playlist of playlists) {
      if (!playlist.ratingKey) throw new Error("Plex playlist is missing its ID");
      if (excludedIds.has(String(playlist.ratingKey))) continue;
      const entries = await read(`/playlists/${encodeURIComponent(playlist.ratingKey)}/items`);
      for (const entry of entries) {
        const parts = (entry.Media || []).flatMap((media) => media.Part || []);
        if (!parts.length) throw new Error("Plex playlist track has no media path");
        for (const part of parts) paths.add(requirePlaylistPath(part.file));
      }
    }
    return [...paths];
  }

  async getPlaylistItems(playlistRatingKey: string | number) {
    const endpoint = `/playlists/${playlistRatingKey}/items`;
    const { MediaContainer: page } = await this.read(pageSchema, endpoint);
    return readOne(v.array(playlistItemSchema), page.Metadata ?? [], {
      service: "Plex",
      endpoint,
    }).map((item) => ({ ratingKey: item.ratingKey, playlistItemID: item.playlistItemID }));
  }

  _metadataUri(machineId: string | null, ratingKeys: (string | number) | (string | number)[]) {
    const keys = (Array.isArray(ratingKeys) ? ratingKeys : [ratingKeys]).join(",");
    return `server://${machineId}/com.plexapp.plugins.library/library/metadata/${keys}`;
  }

  async _createPlaylist(title: string, ratingKeys: (string | number)[]) {
    const machineId = await this.getMachineIdentifier();
    if (!machineId) throw new Error("Could not resolve Plex machineIdentifier");
    const { MediaContainer: page } = await this.read(pageSchema, "/playlists", {
      method: "POST",
      params: {
        type: "audio",
        title,
        smart: 0,
        uri: this._metadataUri(machineId, ratingKeys),
      },
    });
    const [created] = page.Metadata ?? [];
    return created === undefined
      ? null
      : readOne(playlistSchema, created, { service: "Plex", endpoint: "/playlists" });
  }

  async addToPlaylist(playlistRatingKey: string | number, ratingKeys: (string | number)[]) {
    const machineId = await this.getMachineIdentifier();
    return this.request(`/playlists/${playlistRatingKey}/items`, {
      method: "PUT",
      params: { uri: this._metadataUri(machineId, ratingKeys) },
    });
  }

  async removePlaylistItem(playlistRatingKey: string | number, playlistItemID: string | number) {
    return this.request(`/playlists/${playlistRatingKey}/items/${playlistItemID}`, {
      method: "DELETE",
    });
  }

  async updatePlaylistDetails(
    playlistRatingKey: string | number,
    { title, summary }: { title?: string; summary?: string } = {},
  ) {
    const params: { title?: string; summary?: string } = {};
    if (title != null) params.title = title;
    if (summary != null) params.summary = summary;
    if (!Object.keys(params).length) return null;
    return this.request(`/playlists/${playlistRatingKey}`, {
      method: "PUT",
      params,
    });
  }

  async deletePlaylist(playlistRatingKey: string | number) {
    return this.request(`/playlists/${playlistRatingKey}`, {
      method: "DELETE",
    });
  }

  async syncPlaylist({
    ratingKey = null,
    previousTitle = null,
    previousDescription = null,
    title,
    description = null,
    ratingKeys,
  }: {
    ratingKey?: string | number | null;
    previousTitle?: string | null;
    previousDescription?: string | null;
    title: string;
    description?: string | null;
    ratingKeys: (string | number)[] | null | undefined;
  }) {
    let targetRatingKey = ratingKey;
    let items: Awaited<ReturnType<PlexClient["getPlaylistItems"]>> | null = null;
    let needsDetailsUpdate = false;

    if (targetRatingKey) {
      try {
        items = await this.getPlaylistItems(targetRatingKey);
        needsDetailsUpdate = previousTitle !== title || previousDescription !== description;
      } catch (error) {
        if (asAppError(error)?.response?.status !== 404) throw error;
        targetRatingKey = null;
      }
    }

    if (!targetRatingKey) {
      if (!ratingKeys?.length) return null;
      const created = await this._createPlaylist(title, ratingKeys);
      if (!created?.ratingKey) return null;
      if (description) {
        await this.updatePlaylistDetails(created.ratingKey, { summary: description });
      }
      return { ratingKey: created.ratingKey };
    }

    if (!ratingKeys?.length) {
      await this.deletePlaylist(targetRatingKey);
      return null;
    }

    const desiredSet = new Set(ratingKeys.map(String));
    const currentSet = new Set((items || []).map((i) => String(i.ratingKey)));
    const toRemove = (items || []).filter((i) => !desiredSet.has(String(i.ratingKey)));
    const toAdd = ratingKeys.filter((k) => !currentSet.has(String(k)));

    for (const item of toRemove) {
      try {
        await this.removePlaylistItem(targetRatingKey, item.playlistItemID);
      } catch (err) {
        console.warn(
          `[Plex] Failed to remove item ${item.playlistItemID} from playlist ${targetRatingKey}:`,
          asAppError(err)?.message,
        );
      }
    }
    if (toAdd.length) await this.addToPlaylist(targetRatingKey, toAdd);
    if (needsDetailsUpdate) {
      await this.updatePlaylistDetails(targetRatingKey, { title, summary: description || "" });
    }

    return { ratingKey: targetRatingKey };
  }
}
