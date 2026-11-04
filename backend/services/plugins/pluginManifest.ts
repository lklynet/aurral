import fs from "node:fs/promises";
import path from "node:path";
import * as v from "valibot";
import { resolveAurralDataDir } from "../../config/data-dir.ts";

export const PLUGIN_API_VERSION = 1;
export const PLUGIN_MAIN = "index.js";
export const PLUGIN_ACTION_TARGETS = ["playlist", "album", "artist", "track"] as const;
export const PLUGIN_EVENTS = [
  "playlist.changed",
  "playlist.removed",
  "track.played",
  "download.finished",
  "notification",
] as const;

const text = (max: number) => v.pipe(v.string(), v.trim(), v.minLength(1), v.maxLength(max));
const key = v.pipe(
  v.string(),
  v.regex(/^[a-zA-Z][a-zA-Z0-9_-]{0,39}$/, "use letters, numbers, - or _"),
);

const unique = <Item>(field: keyof Item & string) =>
  v.check<Item[], string>(
    (items) => new Set(items.map((item) => item[field])).size === items.length,
    `each ${field} must be unique`,
  );

const settingSchema = v.object({
  key,
  label: text(60),
  type: v.picklist(["text", "password", "number", "boolean"]),
  required: v.optional(v.boolean(), false),
  help: v.optional(text(300)),
});

const actionSchema = v.object({
  id: key,
  label: text(40),
  target: v.picklist(PLUGIN_ACTION_TARGETS),
  admin: v.optional(v.boolean(), false),
  background: v.optional(v.boolean(), false),
});

const hostname = v.pipe(
  v.string(),
  v.toLowerCase(),
  v.regex(/^[a-z0-9.-]+\.[a-z]{2,}$/, "use a hostname like bandcamp.com"),
);

export const pluginManifestSchema = v.object({
  id: v.pipe(
    v.string(),
    v.regex(/^[a-z0-9][a-z0-9-]{0,62}$/, "use lowercase letters, numbers, or -"),
  ),
  name: text(60),
  version: text(40),
  api: v.pipe(v.number(), v.integer()),
  description: v.optional(text(300)),
  repository: v.optional(v.pipe(v.string(), v.url(), v.startsWith("https://"))),
  settings: v.optional(v.pipe(v.array(settingSchema), v.maxLength(30), unique("key")), []),
  uses: v.optional(v.pipe(v.array(text(80)), v.maxLength(10)), []),
  actions: v.optional(v.pipe(v.array(actionSchema), v.maxLength(20), unique("id")), []),
  events: v.optional(
    v.pipe(
      v.array(v.picklist(PLUGIN_EVENTS)),
      v.check((events) => new Set(events).size === events.length, "each event must be unique"),
    ),
    [],
  ),
  downloadSource: v.optional(
    v.nullable(v.object({ albums: v.optional(v.boolean(), false) })),
    null,
  ),
  importList: v.optional(
    v.nullable(
      v.object({
        label: text(40),
        hosts: v.pipe(v.array(hostname), v.minLength(1), v.maxLength(10)),
      }),
    ),
    null,
  ),
  test: v.optional(v.boolean(), false),
});

export type PluginManifest = v.InferOutput<typeof pluginManifestSchema>;
export type PluginSetting = PluginManifest["settings"][number];
export type PluginEvent = (typeof PLUGIN_EVENTS)[number];
export type PluginActionTarget = (typeof PLUGIN_ACTION_TARGETS)[number];

const ACTION_KINDS: Record<PluginActionTarget, string> = {
  playlist: "Playlist menu",
  album: "Album menu",
  artist: "Artist menu",
  track: "Track menu",
};

export function pluginCapabilities(manifest: PluginManifest) {
  return [
    ...manifest.actions.map((action) => ({
      key: `action:${action.id}`,
      label: action.label,
      kind: ACTION_KINDS[action.target],
    })),
    ...manifest.events.map((event) => ({ key: `event:${event}`, label: event, kind: "Event" })),
    ...(manifest.downloadSource
      ? [
          {
            key: "downloadSource",
            label: manifest.downloadSource.albums ? "Tracks and albums" : "Tracks",
            kind: "Download source",
          },
        ]
      : []),
    ...(manifest.importList
      ? [{ key: "importList", label: manifest.importList.label, kind: "Import list" }]
      : []),
  ];
}
export type PluginFolder =
  | { id: string; manifest: PluginManifest; error: null }
  | { id: string; manifest: null; error: string };

export const pluginsDir = () => path.join(resolveAurralDataDir(), "plugins");
export const pluginFolder = (id: string) => path.join(pluginsDir(), id);

async function isFile(filePath: string) {
  return (await fs.stat(filePath).catch(() => null))?.isFile() === true;
}

function describeIssue(issue: v.BaseIssue<unknown>) {
  const at = v.getDotPath(issue);
  return at ? `${at}: ${issue.message}` : issue.message;
}

export async function readPluginManifestAt(
  folder: string,
): Promise<{ manifest: PluginManifest; error: null } | { manifest: null; error: string }> {
  const raw = await fs.readFile(path.join(folder, "manifest.json"), "utf8").catch(() => null);
  if (raw === null) return { manifest: null, error: "manifest.json is missing" };
  let json: unknown;
  try {
    json = JSON.parse(raw);
  } catch {
    return { manifest: null, error: "manifest.json is not valid JSON" };
  }
  const parsed = v.safeParse(pluginManifestSchema, json);
  if (!parsed.success) {
    const [issue] = parsed.issues;
    return { manifest: null, error: `manifest.json ${describeIssue(issue)}` };
  }
  const manifest = parsed.output;
  if (manifest.api !== PLUGIN_API_VERSION)
    return {
      manifest: null,
      error: `Needs plugin API ${manifest.api}. This Aurral runs plugin API ${PLUGIN_API_VERSION}.`,
    };
  if (!(await isFile(path.join(folder, PLUGIN_MAIN))))
    return { manifest: null, error: `${PLUGIN_MAIN} is missing` };
  return { manifest, error: null };
}

async function readPluginFolder(id: string): Promise<PluginFolder> {
  const read = await readPluginManifestAt(pluginFolder(id));
  if (!read.manifest) return { id, ...read };
  if (read.manifest.id !== id)
    return { id, manifest: null, error: `The folder has to be named ${read.manifest.id}` };
  return { id, ...read };
}

export async function scanPluginFolders() {
  const dir = pluginsDir();
  await fs.mkdir(dir, { recursive: true });
  const entries = await fs.readdir(dir, { withFileTypes: true });
  const ids = entries
    .filter((entry) => entry.isDirectory() && !entry.name.startsWith("."))
    .map((entry) => entry.name)
    .sort();
  return Promise.all(ids.map(readPluginFolder));
}
