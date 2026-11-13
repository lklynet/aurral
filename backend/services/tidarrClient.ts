import * as v from "valibot";
import { XMLParser } from "fast-xml-parser";
import { http } from "../../lib/http.ts";
import { SabnzbdClient } from "./sabnzbdClient.ts";
import { readMany, readOne } from "./integrationData.ts";

export const tidarrSettings = Object.freeze({
  key: "tidarr",
  label: "Tidarr",
  subtitle: "Tidal",
  enabledDefault: false,
  testRequiresEnabled: true,
  fields: Object.freeze([
    Object.freeze({ key: "enabled", label: "Enable Tidarr", type: "toggle" }),
    Object.freeze({
      key: "url",
      label: "Server URL",
      type: "url",
      required: true,
      section: "Connection",
      placeholder: "http://localhost:8484",
    }),
    Object.freeze({
      key: "apiKey",
      label: "API key",
      type: "password",
      required: true,
      secret: true,
      section: "Connection",
    }),
    Object.freeze({
      key: "priority",
      label: "Track priority",
      type: "number",
      min: 1,
      max: 1000,
      advanced: true,
    }),
    Object.freeze({
      key: "albumPriority",
      label: "Album priority",
      type: "number",
      min: 1,
      max: 1000,
      advanced: true,
      hint: "Empty uses track priority.",
    }),
  ]),
  defaults: Object.freeze({
    enabled: false,
    url: "",
    apiKey: "",
    priority: 20,
  }),
  validation: Object.freeze({ required: ["url", "apiKey"], url: ["url"] }),
  testConnection: true,
});

const RELEASE_GUID = /^(\d+)-(hires_lossless|lossless|high|low)$/;
const SEARCH_PATH = "/api/lidarr";

// Tidarr lists an album once per quality, and every listing downloads as the same item.
export function releaseIdentity(guid: string | null | undefined) {
  const id = String(guid || "")
    .trim()
    .toLowerCase();
  const tidalAlbum = RELEASE_GUID.exec(id)?.[1];
  return tidalAlbum ? `tidarr:${tidalAlbum}` : id;
}

const feedParser = new XMLParser({
  ignoreAttributes: false,
  attributeNamePrefix: "",
  parseTagValue: false,
  parseAttributeValue: false,
  isArray: (name) => name === "item" || name === "newznab:attr",
});

const feedSchema = v.looseObject({
  rss: v.looseObject({
    channel: v.looseObject({ item: v.optional(v.array(v.unknown()), []) }),
  }),
});

const itemSchema = v.looseObject({
  title: v.string(),
  guid: v.union([
    v.string(),
    v.pipe(
      v.looseObject({ "#text": v.string() }),
      v.transform((node) => node["#text"]),
    ),
  ]),
  "newznab:attr": v.optional(v.array(v.looseObject({ name: v.string(), value: v.string() })), []),
});

const settingsSchema = v.looseObject({ noToken: v.optional(v.boolean()) });

export class TidarrClient extends SabnzbdClient {
  constructor(config: ConstructorParameters<typeof SabnzbdClient>[0] = null) {
    super(config, "tidarr");
  }

  _get(path: string, query: Record<string, string> = {}, responseType?: "buffer") {
    const { url, apiKey } = this._getSettings();
    return http.get(`${url}${path}`, {
      query: { ...query, apikey: apiKey },
      timeoutMs: 45000,
      responseType,
    });
  }

  async search(query: string) {
    const { url } = this._getSettings();
    const response = await this._get(SEARCH_PATH, { t: "search", q: query });
    const source = { service: "Tidarr", endpoint: SEARCH_PATH };
    const feed = readOne(feedSchema, feedParser.parse(String(response.data ?? "")), source);
    return readMany(itemSchema, feed.rss.channel.item, source).flatMap((item) => {
      const guid = item.guid.trim();
      const [, album, quality] = RELEASE_GUID.exec(guid) ?? [];
      if (!album || !quality) return [];
      const attrs = new Map(item["newznab:attr"].map((attr) => [attr.name, attr.value]));
      return [
        {
          guid,
          title: item.title.trim(),
          size: Number(attrs.get("size")) || 0,
          downloadUrl: `${url}${SEARCH_PATH}/download/${album}/${quality}`,
          indexerId: null,
          indexer: "Tidarr",
          protocol: "usenet",
          categories: [Number(attrs.get("category"))].filter(Number.isFinite),
          tracks: Number(attrs.get("tracks")) || null,
        },
      ];
    });
  }

  async fetchNzb(guid: string | null | undefined) {
    const [, album, quality] = RELEASE_GUID.exec(String(guid || "").trim()) ?? [];
    if (!album || !quality) throw new Error("This is not a Tidarr release");
    const response = await this._get(`${SEARCH_PATH}/download/${album}/${quality}`, {}, "buffer");
    const content = Buffer.isBuffer(response.data) ? response.data : Buffer.alloc(0);
    if (!/<nzb[\s>]/u.test(content.subarray(0, 65536).toString("utf8"))) {
      throw new Error("Tidarr did not return an NZB file");
    }
    return content;
  }

  async testConnection(options: { force?: boolean } = {}) {
    const result = await super.testConnection(options);
    if (!result.ok) return result;
    const settings = await this._get("/api/settings").catch(() => null);
    const parsed = v.safeParse(settingsSchema, settings?.data);
    if (!parsed.success || parsed.output.noToken !== true) return result;
    return {
      ...result,
      warning: true,
      message: "Tidarr is connected, but it is not signed in to Tidal. Sign in from Tidarr.",
    };
  }
}

export const tidarrClient = new TidarrClient();
