import * as v from "valibot";
import {
  albumDownloadResult,
  albumResults,
  DownloadSourceError,
  fileResults,
  searchResults,
  statusResult,
  trackDownloadResult,
  type DownloadSource,
} from "../download/downloadSource.ts";
import {
  processSourcePipelinePayload,
  type SourceHelpers,
  type SourcePayload,
} from "../download/sourcePipeline.ts";
import { downloadTracker } from "../downloadJobs/downloadTracker.ts";
import { callPlugin, PluginError } from "./pluginHost.ts";
import {
  activePluginWith,
  pluginIdFromSource,
  pluginInput,
  PLUGIN_SOURCE_PREFIX,
  type InstalledPlugin,
} from "./pluginStore.ts";

const SEARCH_TIMEOUT_MS = 60_000;
const DOWNLOAD_TIMEOUT_MS = 30 * 60_000;
const STATUS_TIMEOUT_MS = 60_000;

function pluginSource(plugin: InstalledPlugin): DownloadSource {
  const call = async <Schema extends v.GenericSchema>(
    path: string,
    input: Record<string, unknown>,
    output: Schema,
    timeoutMs: number,
  ) => {
    try {
      return await callPlugin(
        plugin,
        { path, input: { ...pluginInput(plugin), ...input } },
        output,
        timeoutMs,
      );
    } catch (error) {
      if (error instanceof PluginError) throw new DownloadSourceError(error.message);
      throw error;
    }
  };
  const manifest = plugin.manifest.downloadSource;
  return {
    id: `${PLUGIN_SOURCE_PREFIX}${plugin.id}`,
    staging: `plugins/${plugin.id}`,
    ...(manifest?.tracks !== false && {
      tracks: {
        search: (track, upgrade) =>
          call("downloadSource.search", { track, upgrade }, searchResults, SEARCH_TIMEOUT_MS),
        download: (input) =>
          call("downloadSource.download", input, trackDownloadResult, DOWNLOAD_TIMEOUT_MS),
      },
    }),
    ...(manifest?.albums === true && {
      albums: {
        search: (album, upgrade) =>
          call("downloadSource.searchAlbum", { album, upgrade }, albumResults, SEARCH_TIMEOUT_MS),
        download: (input) =>
          call("downloadSource.downloadAlbum", input, albumDownloadResult, DOWNLOAD_TIMEOUT_MS),
        ...(manifest.files && {
          files: {
            list: (id) => call("downloadSource.listFiles", { id }, fileResults, STATUS_TIMEOUT_MS),
            keep: async (input) => {
              await call("downloadSource.keepFile", input, v.unknown(), STATUS_TIMEOUT_MS);
            },
          },
        }),
      },
    }),
    status: (input) => call("downloadSource.status", input, statusResult, STATUS_TIMEOUT_MS),
    discard: async (id) => {
      await call("downloadSource.discard", { id }, v.unknown(), STATUS_TIMEOUT_MS);
    },
  };
}

export async function processPluginPipelinePayload(payload: SourcePayload, helpers: SourceHelpers) {
  const id = pluginIdFromSource(payload.source);
  const plugin = id ? activePluginWith(id, "downloadSource") : null;
  if (!plugin?.manifest.downloadSource) {
    const job = downloadTracker.getJob(payload.jobId);
    return job ? helpers.failOrTryNextSource(payload, job, "The plugin is turned off") : null;
  }
  return processSourcePipelinePayload(payload, pluginSource(plugin), helpers);
}
