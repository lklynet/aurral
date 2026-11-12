import * as v from "valibot";
import { OFFICIAL_PLUGINS_URL } from "../../lib/officialPlugins.ts";
import { decryptWithKey } from "../config/encryption.ts";
import {
  LIDARR_CONVERSION_REPORT_KEY,
  lidarrConversionReport,
} from "../config/lidarr-conversion.ts";
import { dbOps } from "../db/helpers/index.ts";
import { getSettingsEncryptionKey } from "../db/helpers/settings.ts";
import {
  discardPluginLink,
  inspectPluginLink,
  installPluginLink,
} from "./plugins/pluginInstaller.ts";
import { PluginRequestError, testPlugin, updatePlugin } from "./plugins/pluginService.ts";
import { readPlugin } from "./plugins/pluginStore.ts";

const LIDARR_PLUGIN = "lidarr";

const storedReport = () =>
  dbOps.getJSONSetting(LIDARR_CONVERSION_REPORT_KEY, lidarrConversionReport);

const describe = (report: v.InferOutput<typeof lidarrConversionReport> | null) =>
  report && { folders: report.folders, connected: Boolean(report.connection) };

// The conversion writes its report before the server starts and only a
// dismissal removes it, so the app shell reads it from memory.
let pending = describe(storedReport());

export const pendingLidarrConversion = () => pending;

export function dismissLidarrConversionReport() {
  dbOps.setJSONSetting(LIDARR_CONVERSION_REPORT_KEY, null);
  pending = null;
}

async function installOfficialPlugin(id: string) {
  const { token, plugins } = await inspectPluginLink(OFFICIAL_PLUGINS_URL);
  try {
    if (!plugins.some((plugin) => plugin.manifest.id === id))
      throw new PluginRequestError(502, `The official plugins have no ${id} plugin`);
    await installPluginLink(token, [id]);
  } finally {
    await discardPluginLink(token);
  }
}

export async function setUpLidarrPlugin() {
  const connection = storedReport()?.connection;
  if (!connection) throw new PluginRequestError(409, "Aurral has no Lidarr connection to set up");
  if (!readPlugin(LIDARR_PLUGIN)?.manifest) await installOfficialPlugin(LIDARR_PLUGIN);
  const saved = {
    url: connection.url || process.env.LIDARR_URL?.trim() || "http://localhost:8686",
    apiKey:
      decryptWithKey(connection.apiKey, getSettingsEncryptionKey()) ||
      process.env.LIDARR_API_KEY?.trim(),
    rootFolder: connection.rootFolder,
  };
  updatePlugin(LIDARR_PLUGIN, {
    settings: { ...saved, ...readPlugin(LIDARR_PLUGIN)?.settings },
  });
  const { message } = await testPlugin(LIDARR_PLUGIN);
  updatePlugin(LIDARR_PLUGIN, { enabled: true });
  dismissLidarrConversionReport();
  return { message };
}
