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
  trackQuery,
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
    options?: { logFailures: boolean },
  ) => {
    try {
      return await callPlugin(
        plugin,
        { path, input: { ...pluginInput(plugin), ...input } },
        output,
        timeoutMs,
        options,
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
        search: (track, { upgrade }) =>
          call(
            "downloadSource.search",
            { track: trackQuery(track), upgrade },
            searchResults,
            SEARCH_TIMEOUT_MS,
          ),
        download: ({ result, directory }) =>
          call(
            "downloadSource.download",
            { result, directory },
            trackDownloadResult,
            DOWNLOAD_TIMEOUT_MS,
            { logFailures: false },
          ),
      },
    }),
    ...(manifest?.albums === true && {
      albums: {
        search: (album, upgrade) =>
          call("downloadSource.searchAlbum", { album, upgrade }, albumResults, SEARCH_TIMEOUT_MS),
        download: ({ result, album, directory }) =>
          call(
            "downloadSource.downloadAlbum",
            { result, album, directory },
            albumDownloadResult,
            DOWNLOAD_TIMEOUT_MS,
            { logFailures: false },
          ),
        ...(manifest.files && {
          files: {
            list: (id) => call("downloadSource.listFiles", { id }, fileResults, STATUS_TIMEOUT_MS),
            keep: async (input) => {
              await call("downloadSource.keepFiles", input, v.unknown(), STATUS_TIMEOUT_MS);
            },
          },
        }),
      },
    }),
    status: (input) =>
      call("downloadSource.status", input, statusResult, STATUS_TIMEOUT_MS, { logFailures: false }),
    discard: async (id) => {
      await call("downloadSource.discard", { id }, v.unknown(), STATUS_TIMEOUT_MS);
    },
  };
}

export function pluginDownloadSource(sourceId: string | null | undefined) {
  const id = pluginIdFromSource(sourceId);
  const plugin = id ? activePluginWith(id, "downloadSource") : null;
  return plugin?.manifest.downloadSource ? pluginSource(plugin) : null;
}

export async function processPluginPipelinePayload(payload: SourcePayload, helpers: SourceHelpers) {
  const source = pluginDownloadSource(payload.source);
  if (!source) {
    const job = downloadTracker.getJob(payload.jobId);
    return job ? helpers.failOrTryNextSource(payload, job, "The plugin is turned off") : null;
  }
  return processSourcePipelinePayload(payload, source, helpers);
}
