import fs from "node:fs/promises";
import * as v from "valibot";
import type { RequestUser } from "../../middleware/requestUser.ts";
import { logger } from "../logger.ts";
import { websocketService } from "../websocketService.ts";
import {
  actionTarget,
  PluginTargetMissing,
  type PluginActionTargetInput,
} from "./pluginContext.ts";
import { callPlugin, PluginError, stopPlugin } from "./pluginHost.ts";
import {
  pluginCapabilities,
  pluginDataFolder,
  pluginFolder,
  pluginsDir,
  scanPluginFolders,
  type PluginManifest,
} from "./pluginManifest.ts";
import {
  activePlugin,
  activePlugins,
  forgetPlugin,
  isCapabilityOn,
  whilePluginTests,
  isPluginReady,
  isSafeMode,
  isSafeModeForced,
  pluginUpdatesCheckedAt,
  pluginInput,
  readPlugin,
  readPlugins,
  recordInstalledPlugins,
  savePlugin,
  type InstalledPlugin,
  type PluginSettingValues,
} from "./pluginStore.ts";

const ACTION_TIMEOUT_MS = 2 * 60_000;
const BACKGROUND_ACTION_TIMEOUT_MS = 30 * 60_000;
const TEST_TIMEOUT_MS = 30_000;
const MAX_TEXT_SETTING = 2000;
export const DEFAULT_PLUGIN_PRIORITY = 30;

export const messageResult = v.nullish(
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
    updatesCheckedAt: pluginUpdatesCheckedAt(),
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
        sourceUrl: plugin?.sourceUrl ?? null,
        update:
          installed && plugin?.update
            ? {
                version: plugin.update.version,
                adds: pluginCapabilities(plugin.update).filter(
                  (capability) =>
                    !pluginCapabilities(installed.manifest).some(
                      (current) => current.key === capability.key,
                    ),
                ),
              }
            : null,
        capabilities: installed
          ? pluginCapabilities(installed.manifest).map((capability) => ({
              ...capability,
              enabled: isCapabilityOn(installed, capability.key),
            }))
          : [],
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

function readCapabilitiesInput(plugin: InstalledPlugin, input: Record<string, boolean>): string[] {
  const keys = new Set(pluginCapabilities(plugin.manifest).map((capability) => capability.key));
  const disabled = new Set(plugin.disabled.filter((key) => keys.has(key)));
  for (const [key, on] of Object.entries(input)) {
    if (!keys.has(key))
      throw new PluginRequestError(400, `${key} isn't one of this plugin's capabilities`);
    if (on) disabled.delete(key);
    else disabled.add(key);
  }
  return [...disabled];
}

function installedPlugin(id: string) {
  const plugin = readPlugin(id);
  if (!plugin?.manifest) throw new PluginRequestError(404, "Plugin not found");
  return { ...plugin, manifest: plugin.manifest };
}

export function updatePlugin(
  id: string,
  patch: {
    enabled?: boolean;
    settings?: Record<string, unknown>;
    priority?: number;
    capabilities?: Record<string, boolean>;
  },
) {
  const plugin = installedPlugin(id);
  savePlugin(plugin, {
    ...(patch.enabled === undefined ? {} : { enabled: patch.enabled }),
    ...(patch.priority === undefined ? {} : { priority: patch.priority }),
    ...(patch.settings
      ? { settings: readSettingsInput(plugin.manifest, { ...plugin.settings, ...patch.settings }) }
      : {}),
    ...(patch.capabilities ? { disabled: readCapabilitiesInput(plugin, patch.capabilities) } : {}),
  });
  if (patch.enabled === false) stopPlugin(id);
  logger.info(
    `plugin:${id}`,
    patch.enabled === undefined
      ? "Plugin settings saved"
      : `Plugin turned ${patch.enabled ? "on" : "off"}`,
  );
}

export async function removePlugin(id: string) {
  if (!(await scanPluginFolders()).some((folder) => folder.id === id))
    throw new PluginRequestError(404, "Plugin not found");
  stopPlugin(id);
  await fs.rm(pluginFolder(id), { recursive: true, force: true });
  await fs.rm(pluginDataFolder(id), { recursive: true, force: true });
  forgetPlugin(id);
  logger.info(`plugin:${id}`, "Plugin removed");
}

export async function testPlugin(id: string, { countFailures = true } = {}) {
  const plugin = installedPlugin(id);
  if (!plugin.manifest.test) throw new PluginRequestError(400, "This plugin has no test");
  try {
    const result = await whilePluginTests(id, () =>
      callPlugin(
        plugin,
        { path: "test", input: pluginInput(plugin) },
        messageResult,
        TEST_TIMEOUT_MS,
        { countFailures },
      ),
    );
    return { message: result?.message?.trim() || "Connected" };
  } catch (error) {
    if (!(error instanceof PluginError)) throw error;
    throw new PluginRequestError(502, error.message);
  }
}

const canUse = (action: PluginManifest["actions"][number], user: RequestUser) =>
  !action.admin || user.role === "admin";

export function listPluginActions(user: RequestUser) {
  return activePlugins().flatMap((plugin) =>
    plugin.manifest.actions
      .filter((action) => canUse(action, user) && isCapabilityOn(plugin, `action:${action.id}`))
      .map((action) => ({
        pluginId: plugin.id,
        pluginName: plugin.manifest.name,
        id: action.id,
        label: action.label,
        target: action.target,
      })),
  );
}

async function invokeAction(
  plugin: InstalledPlugin,
  action: PluginManifest["actions"][number],
  input: object,
  timeoutMs: number,
) {
  try {
    const result = await callPlugin(
      plugin,
      { path: `actions.${action.id}`, input },
      messageResult,
      timeoutMs,
    );
    return result?.message?.trim() || `${action.label} finished`;
  } catch (error) {
    if (!(error instanceof PluginError)) throw error;
    throw new PluginRequestError(502, `${plugin.manifest.name}: ${error.message}`);
  }
}

export async function runPluginAction(
  user: RequestUser,
  pluginId: string,
  actionId: string,
  target: PluginActionTargetInput,
) {
  const plugin = activePlugin(pluginId);
  const action = plugin?.manifest.actions.find((entry) => entry.id === actionId);
  if (!plugin || !action || !isCapabilityOn(plugin, `action:${action.id}`))
    throw new PluginRequestError(404, "Plugin action not found");
  if (!canUse(action, user)) throw new PluginRequestError(403, "Only admins can run this action");
  let context;
  try {
    context = await actionTarget(user, action.target, target);
  } catch (error) {
    if (error instanceof PluginTargetMissing) throw new PluginRequestError(404, error.message);
    throw error;
  }
  const input = {
    ...pluginInput(plugin),
    user: { id: user.id, username: user.username, role: user.role },
    ...context,
  };
  if (!action.background)
    return { message: await invokeAction(plugin, action, input, ACTION_TIMEOUT_MS) };
  invokeAction(plugin, action, input, BACKGROUND_ACTION_TIMEOUT_MS).then(
    (message) => finishBackgroundAction(user, true, message),
    (error: unknown) =>
      finishBackgroundAction(
        user,
        false,
        error instanceof Error ? error.message : `${action.label} failed`,
      ),
  );
  return { message: `${action.label} started` };
}

function finishBackgroundAction(user: RequestUser, ok: boolean, message: string) {
  websocketService.broadcast(
    "plugins",
    { type: "plugin_action_finished", ok, message },
    { userId: user.id },
  );
}
