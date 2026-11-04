import path from "node:path";
import * as v from "valibot";
import type { RequestUser } from "../../middleware/requestUser.ts";
import { resolveDownloadRoot } from "../downloadPaths.ts";
import { logger } from "../logger.ts";
import { flowPlaylistConfig } from "../playlists/flowPlaylistConfig.ts";
import { collectPlaylistFileTracks } from "../playlists/playlistFileTracks.ts";
import { readWrittenPlaylistFiles } from "../playlists/playlistFiles.ts";
import { playlistManager } from "../playlists/playlistManager.ts";
import { callPlugin, PluginError, stopPlugin } from "./pluginHost.ts";
import { pluginsDir, scanPluginFolders, type PluginManifest } from "./pluginManifest.ts";
import {
  activePlugin,
  activePlugins,
  isPluginReady,
  isSafeMode,
  isSafeModeForced,
  readPlugin,
  readPlugins,
  recordInstalledPlugins,
  savePlugin,
  type PluginSettingValues,
} from "./pluginStore.ts";

const ACTION_TIMEOUT_MS = 2 * 60_000;
const MAX_TEXT_SETTING = 2000;
export const DEFAULT_PLUGIN_PRIORITY = 30;

const actionResult = v.nullish(
  v.looseObject({ message: v.optional(v.pipe(v.string(), v.maxLength(500))) }),
);

export class PluginRequestError extends Error {
  declare status: 400 | 403 | 404 | 409 | 502;
  constructor(status: PluginRequestError["status"], message: string) {
    super(message);
    this.status = status;
  }
}

export async function refreshInstalledPlugins() {
  const folders = await scanPluginFolders();
  for (const id of recordInstalledPlugins(folders)) stopPlugin(id);
  return folders;
}

export async function listPlugins() {
  const folders = await refreshInstalledPlugins();
  const stored = new Map(readPlugins().map((plugin) => [plugin.id, plugin]));
  return {
    folder: pluginsDir(),
    safeMode: isSafeMode(),
    safeModeForced: isSafeModeForced(),
    plugins: folders.map((folder) => {
      const plugin = stored.get(folder.id);
      const installed =
        folder.manifest && plugin?.manifest ? { ...plugin, manifest: folder.manifest } : null;
      return {
        id: folder.id,
        manifest: folder.manifest,
        error: folder.error,
        enabled: installed?.enabled ?? false,
        ready: installed ? isPluginReady(installed) : false,
        settings: installed?.settings ?? {},
        priority: installed?.priority ?? DEFAULT_PLUGIN_PRIORITY,
        lastError: installed?.lastError ?? null,
      };
    }),
  };
}

const SETTING_VALUE = {
  text: v.pipe(v.string(), v.maxLength(MAX_TEXT_SETTING)),
  password: v.pipe(v.string(), v.maxLength(MAX_TEXT_SETTING)),
  number: v.pipe(v.number(), v.finite()),
  boolean: v.boolean(),
};

function readSettingsInput(manifest: PluginManifest, input: Record<string, unknown>) {
  const values: PluginSettingValues = {};
  for (const setting of manifest.settings) {
    const value = input[setting.key];
    if (value === undefined || value === null || value === "") continue;
    const parsed = v.safeParse(SETTING_VALUE[setting.type], value);
    if (!parsed.success)
      throw new PluginRequestError(400, `${setting.label}: ${parsed.issues[0].message}`);
    values[setting.key] = parsed.output;
  }
  return values;
}

export function updatePlugin(
  id: string,
  patch: { enabled?: boolean; settings?: Record<string, unknown>; priority?: number },
) {
  const plugin = readPlugin(id);
  if (!plugin?.manifest) throw new PluginRequestError(404, "Plugin not found");
  savePlugin(plugin, {
    ...(patch.enabled === undefined ? {} : { enabled: patch.enabled }),
    ...(patch.priority === undefined ? {} : { priority: patch.priority }),
    ...(patch.settings
      ? {
          settings: readSettingsInput(plugin.manifest, {
            ...plugin.settings,
            ...patch.settings,
          }),
        }
      : {}),
  });
  if (patch.enabled === false) stopPlugin(id);
  logger.info(
    `plugin:${id}`,
    patch.enabled === undefined
      ? "Plugin settings saved"
      : `Plugin turned ${patch.enabled ? "on" : "off"}`,
  );
}

export function listPluginActions(user: RequestUser) {
  return activePlugins().flatMap((plugin) =>
    plugin.manifest.actions
      .filter((action) => !action.admin || user.role === "admin")
      .map((action) => ({
        pluginId: plugin.id,
        pluginName: plugin.manifest.name,
        id: action.id,
        label: action.label,
        target: action.target,
      })),
  );
}

async function playlistContext(user: RequestUser, playlistId: string) {
  const flow = flowPlaylistConfig.getFlowForUser(user, playlistId);
  const playlist = flow ?? flowPlaylistConfig.getStaticPlaylistForUser(user, playlistId);
  if (!playlist) throw new PluginRequestError(404, "Playlist not found");
  const file = readWrittenPlaylistFiles()[playlist.id];
  return {
    id: playlist.id,
    name: playlist.name,
    kind: flow ? "flow" : "playlist",
    file: file ? path.join(playlistManager.libraryRoot, file) : null,
    tracks: await collectPlaylistFileTracks(playlist.id),
  };
}

export async function runPluginAction(
  user: RequestUser,
  pluginId: string,
  actionId: string,
  target: { playlistId: string },
) {
  const plugin = activePlugin(pluginId);
  const action = plugin?.manifest.actions.find((entry) => entry.id === actionId);
  if (!plugin || !action) throw new PluginRequestError(404, "Plugin action not found");
  if (action.admin && user.role !== "admin")
    throw new PluginRequestError(403, "Only admins can run this action");
  const input = {
    settings: plugin.settings,
    user: { id: user.id, username: user.username, role: user.role },
    libraryFolder: resolveDownloadRoot(),
    playlist: await playlistContext(user, target.playlistId),
  };
  try {
    const result = await callPlugin(
      plugin,
      { method: "action", name: action.id, input },
      actionResult,
      ACTION_TIMEOUT_MS,
    );
    return { message: result?.message?.trim() || `${action.label} finished` };
  } catch (error) {
    if (!(error instanceof PluginError)) throw error;
    throw new PluginRequestError(502, `${plugin.manifest.name}: ${error.message}`);
  }
}
