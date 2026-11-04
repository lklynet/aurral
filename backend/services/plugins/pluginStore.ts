import { createHmac, timingSafeEqual } from "node:crypto";
import * as v from "valibot";
import { db, dbHelpers } from "../../config/db-sqlite.ts";
import { decryptWithKey, encryptWithKey } from "../../config/encryption.ts";
import { dbOps } from "../../db/helpers/index.ts";
import { getSettingsEncryptionKey } from "../../db/helpers/settings.ts";
import type { PluginsRow } from "../../db/rows.ts";
import { resolveDownloadRoot } from "../downloadPaths.ts";
import {
  pluginDataFolder,
  pluginManifestSchema,
  type PluginEvent,
  type PluginFolder,
  type PluginManifest,
} from "./pluginManifest.ts";

const SAFE_MODE_KEY = "pluginSafeMode";
const UPDATES_CHECKED_KEY = "pluginUpdatesCheckedAt";
const API_KEY_PREFIX = "aurral_plugin_";
const settingValue = v.union([v.string(), v.number(), v.boolean()]);
const settingValues = v.record(v.string(), settingValue);
const capabilityKeys = v.array(v.string());

export type PluginSettingValues = v.InferOutput<typeof settingValues>;
export type InstalledPlugin = ReturnType<typeof readRow> & { manifest: PluginManifest };

const selectAll = db.prepare<[], PluginsRow>("SELECT * FROM plugins ORDER BY id");
const selectOne = db.prepare<[string], PluginsRow>("SELECT * FROM plugins WHERE id = ?");
const upsertManifest = db.prepare<[string, string, number]>(`
  INSERT INTO plugins (id, manifest, updated_at) VALUES (?, ?, ?)
  ON CONFLICT(id) DO UPDATE SET manifest = excluded.manifest, updated_at = excluded.updated_at
`);
const clearManifest = db.prepare<[number, string]>(
  "UPDATE plugins SET manifest = NULL, updated_at = ? WHERE id = ?",
);
const updateRow = db.prepare<[number, string, number, string, number, string]>(
  "UPDATE plugins SET enabled = ?, settings = ?, priority = ?, disabled = ?, updated_at = ? WHERE id = ?",
);
const updateSourceUrl = db.prepare<[string | null, string]>(
  "UPDATE plugins SET source_url = ? WHERE id = ?",
);
const updateScheduledAt = db.prepare<[number, string]>(
  "UPDATE plugins SET scheduled_at = ? WHERE id = ?",
);
const updateAvailable = db.prepare<[string | null, string]>(
  "UPDATE plugins SET update_manifest = ? WHERE id = ?",
);
const deleteRow = db.prepare<[string]>("DELETE FROM plugins WHERE id = ?");
const updateError = db.prepare<[string | null, string]>(
  "UPDATE plugins SET last_error = ? WHERE id = ?",
);
const disableRow = db.prepare<[string, number, string]>(
  "UPDATE plugins SET enabled = 0, last_error = ?, broken_in_a_row = 0, updated_at = ? WHERE id = ?",
);
const countBroken = db
  .prepare<[string], number>(
    "UPDATE plugins SET broken_in_a_row = broken_in_a_row + 1 WHERE id = ? RETURNING broken_in_a_row",
  )
  .pluck();
const clearBroken = db.prepare<[string]>(
  "UPDATE plugins SET broken_in_a_row = 0 WHERE id = ? AND broken_in_a_row > 0",
);

function readSettings(stored: string) {
  if (!stored) return {};
  const json = decryptWithKey(stored, getSettingsEncryptionKey());
  return dbHelpers.readJSON(settingValues, json, "plugin settings") ?? {};
}

function readRow(row: PluginsRow) {
  const manifest = row.manifest
    ? dbHelpers.readJSON(pluginManifestSchema, row.manifest, `plugin ${row.id} manifest`)
    : null;
  const update = row.update_manifest
    ? dbHelpers.readJSON(pluginManifestSchema, row.update_manifest, `plugin ${row.id} update`)
    : null;
  return {
    id: row.id,
    manifest,
    enabled: row.enabled === 1,
    settings: readSettings(row.settings),
    priority: row.priority,
    lastError: row.last_error,
    disabled: dbHelpers.readJSON(capabilityKeys, row.disabled, "plugin capabilities") ?? [],
    sourceUrl: row.source_url,
    scheduledAt: row.scheduled_at,
    update: update && update.version !== manifest?.version ? update : null,
  };
}

const isInstalled = (plugin: ReturnType<typeof readRow>): plugin is InstalledPlugin =>
  plugin.manifest !== null;

export function isSafeModeForced() {
  return ["1", "true"].includes(String(process.env.AURRAL_SAFE_MODE || "").toLowerCase());
}

export function isSafeMode() {
  return isSafeModeForced() || dbOps.getJSONSetting(SAFE_MODE_KEY, v.boolean()) === true;
}

export function setSafeMode(enabled: boolean) {
  dbOps.setJSONSetting(SAFE_MODE_KEY, enabled);
}

export function readPlugins() {
  return selectAll.all().map(readRow);
}

export function readPlugin(id: string) {
  const row = selectOne.get(id);
  return row ? readRow(row) : null;
}

export function isPluginReady(plugin: InstalledPlugin) {
  return plugin.manifest.settings.every(
    (setting) =>
      !setting.required ||
      (setting.type === "boolean"
        ? typeof plugin.settings[setting.key] === "boolean"
        : String(plugin.settings[setting.key] ?? "").trim() !== ""),
  );
}

export function activePlugins() {
  if (isSafeMode()) return [];
  return readPlugins().filter(
    (plugin): plugin is InstalledPlugin =>
      isInstalled(plugin) && plugin.enabled && isPluginReady(plugin),
  );
}

export function activePlugin(id: string) {
  return activePlugins().find((plugin) => plugin.id === id) ?? null;
}

export const isCapabilityOn = (plugin: InstalledPlugin, key: string) =>
  !plugin.disabled.includes(key);

const apiKeyFor = (id: string) =>
  `${API_KEY_PREFIX}${id}_${createHmac("sha256", getSettingsEncryptionKey())
    .update(`plugin-api:${id}`)
    .digest("base64url")}`;

const hasApiAccess = (plugin: InstalledPlugin) =>
  plugin.manifest.apiAccess && isCapabilityOn(plugin, "api");

export function pluginInput(plugin: InstalledPlugin) {
  return {
    settings: plugin.settings,
    libraryFolder: resolveDownloadRoot(),
    dataFolder: pluginDataFolder(plugin.id),
    ...(hasApiAccess(plugin)
      ? {
          api: {
            url: `http://127.0.0.1:${process.env.PORT || 3001}/api`,
            key: apiKeyFor(plugin.id),
          },
        }
      : {}),
  };
}

export const isPluginApiKey = (key: string) => key.startsWith(API_KEY_PREFIX);

const testing = new Map<string, number>();

export async function whilePluginTests<Result>(id: string, run: () => Promise<Result>) {
  testing.set(id, (testing.get(id) ?? 0) + 1);
  try {
    return await run();
  } finally {
    const left = (testing.get(id) ?? 1) - 1;
    if (left) testing.set(id, left);
    else testing.delete(id);
  }
}

export function pluginForApiKey(key: string) {
  if (isSafeMode()) return null;
  const given = Buffer.from(key);
  const plugin = readPlugins()
    .filter(isInstalled)
    .find((candidate) => {
      const expected = Buffer.from(apiKeyFor(candidate.id));
      return expected.length === given.length && timingSafeEqual(expected, given);
    });
  if (!plugin) return null;
  const running = (plugin.enabled && isPluginReady(plugin)) || testing.has(plugin.id);
  return running && hasApiAccess(plugin) ? plugin.id : null;
}

export function activePluginWith(id: string, capability: string) {
  const plugin = activePlugin(id);
  return plugin && isCapabilityOn(plugin, capability) ? plugin : null;
}

export function pluginsForEvent(event: PluginEvent) {
  return activePlugins().filter(
    (plugin) => plugin.manifest.events.includes(event) && isCapabilityOn(plugin, `event:${event}`),
  );
}

export function recordInstalledPlugins(folders: PluginFolder[]) {
  const now = Date.now();
  const changed: string[] = [];
  db.transaction(() => {
    const stored = new Map(selectAll.all().map((row) => [row.id, row.manifest]));
    for (const folder of folders) {
      if (!folder.manifest) continue;
      const manifest = JSON.stringify(folder.manifest);
      if (stored.get(folder.id) === manifest) continue;
      upsertManifest.run(folder.id, manifest, now);
      changed.push(folder.id);
    }
    const installed = new Set(
      folders.filter((folder) => folder.manifest).map((folder) => folder.id),
    );
    for (const [id, manifest] of stored) {
      if (installed.has(id) || manifest === null) continue;
      clearManifest.run(now, id);
      changed.push(id);
    }
  })();
  return changed;
}

export function savePlugin(
  plugin: Pick<InstalledPlugin, "id" | "enabled" | "settings" | "priority" | "disabled">,
  patch: {
    enabled?: boolean;
    settings?: PluginSettingValues;
    priority?: number;
    disabled?: string[];
  },
) {
  const settings = patch.settings ?? plugin.settings;
  updateRow.run(
    (patch.enabled ?? plugin.enabled) ? 1 : 0,
    encryptWithKey(JSON.stringify(settings), getSettingsEncryptionKey()) ?? "",
    patch.priority ?? plugin.priority,
    JSON.stringify(patch.disabled ?? plugin.disabled),
    Date.now(),
    plugin.id,
  );
  if (patch.enabled === undefined) return;
  updateError.run(null, plugin.id);
  clearBroken.run(plugin.id);
}

export const countBrokenCall = (id: string) => countBroken.get(id) ?? 0;

export function clearBrokenCalls(id: string) {
  clearBroken.run(id);
}

export function recordPluginError(id: string, message: string | null) {
  updateError.run(message, id);
}

export function disablePlugin(id: string, reason: string) {
  disableRow.run(reason, Date.now(), id);
}

export function savePluginSourceUrl(id: string, url: string | null) {
  updateSourceUrl.run(url, id);
}

export function savePluginUpdate(id: string, manifest: PluginManifest | null) {
  updateAvailable.run(manifest ? JSON.stringify(manifest) : null, id);
}

export function pluginUpdatesCheckedAt() {
  return dbOps.getJSONSetting(UPDATES_CHECKED_KEY, v.number());
}

export function markPluginUpdatesChecked(at: number) {
  dbOps.setJSONSetting(UPDATES_CHECKED_KEY, at);
}

export function markPluginScheduled(id: string, at: number) {
  updateScheduledAt.run(at, id);
}

export function forgetPlugin(id: string) {
  deleteRow.run(id);
}

export const PLUGIN_SOURCE_PREFIX = "plugin:";

export function pluginIdFromSource(source: string | null | undefined) {
  return source?.startsWith(PLUGIN_SOURCE_PREFIX)
    ? source.slice(PLUGIN_SOURCE_PREFIX.length)
    : null;
}

export function activePluginSources() {
  return activePlugins()
    .filter((plugin) => plugin.manifest.downloadSource && isCapabilityOn(plugin, "downloadSource"))
    .map((plugin) => ({
      id: `${PLUGIN_SOURCE_PREFIX}${plugin.id}`,
      label: plugin.manifest.name,
      enabled: true,
      configured: true,
      priority: plugin.priority,
      albums: plugin.manifest.downloadSource?.albums === true,
    }));
}

export function pluginSourceLabel(source: string) {
  const id = pluginIdFromSource(source);
  return id ? (readPlugin(id)?.manifest?.name ?? id) : null;
}
