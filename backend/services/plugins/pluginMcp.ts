import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import * as v from "valibot";
import { APP_VERSION } from "../../config/constants.ts";
import { resolveAurralDataDir } from "../../config/data-dir.ts";
import { getLibraryTrackSample } from "../libraryQueryService.ts";
import { logger } from "../logger.ts";
import { queryLogs } from "../logs.ts";
import { flowPlaylistConfig } from "../playlists/flowPlaylistConfig.ts";
import { albumTarget, artistTarget, playlistSnapshot, tracksTarget } from "./pluginContext.ts";
import {
  albumDownloadResult,
  albumResults,
  searchResults,
  statusResult,
  trackDownloadResult,
} from "./pluginDownloadSource.ts";
import { callPlugin, PluginError, stopPlugin, watchPluginLogs } from "./pluginHost.ts";
import { playlistResult } from "./pluginImportList.ts";
import {
  PLUGIN_API_VERSION,
  PLUGIN_MAIN,
  pluginFolder,
  pluginManifestSchema,
} from "./pluginManifest.ts";
import { listPlugins, messageResult, refreshInstalledPlugins } from "./pluginService.ts";
import { isSafeMode, pluginInput, readPlugin, whilePluginTests } from "./pluginStore.ts";

const GUIDE_FILE = fileURLToPath(new URL("./plugin-api.md", import.meta.url));
const TYPES_FILE = fileURLToPath(new URL("./aurral-plugin.d.ts", import.meta.url));
const TEST_TIMEOUT_MS = 2 * 60_000;
const MAX_CODE_BYTES = 5 * 1024 * 1024;
const MAX_EXTRA_FILES = 20;
const MAX_TEST_LOG_LINES = 200;
const SAMPLE_USER = { id: 0, username: "agent", role: "admin" };

const id = v.pipe(v.string(), v.regex(/^[a-z0-9][a-z0-9-]{0,62}$/));
const toolInputs = {
  plugin_docs: v.object({}),
  list_plugins: v.object({}),
  sample_data: v.object({}),
  write_plugin: v.object({
    id,
    manifest: v.record(v.string(), v.unknown()),
    code: v.pipe(v.string(), v.minLength(1), v.maxBytes(MAX_CODE_BYTES)),
    files: v.optional(
      v.pipe(
        v.record(v.string(), v.pipe(v.string(), v.maxBytes(MAX_CODE_BYTES))),
        v.check(
          (files) => Object.keys(files).length <= MAX_EXTRA_FILES,
          `at most ${MAX_EXTRA_FILES} extra files`,
        ),
      ),
    ),
  }),
  test_plugin: v.object({
    id,
    path: v.pipe(v.string(), v.minLength(1)),
    input: v.optional(v.record(v.string(), v.unknown()), {}),
  }),
  plugin_logs: v.object({
    id,
    limit: v.optional(v.pipe(v.number(), v.integer(), v.minValue(1), v.maxValue(200)), 50),
  }),
};

type ToolName = keyof typeof toolInputs;

const objectSchema = (properties: Record<string, object>, required: string[] = []) => ({
  type: "object",
  properties,
  required,
  additionalProperties: false,
});

export const PLUGIN_MCP_TOOLS: { name: ToolName; description: string; inputSchema: object }[] = [
  {
    name: "plugin_docs",
    description:
      "Read this first. Returns the Aurral plugin API reference and its TypeScript types for this Aurral.",
    inputSchema: objectSchema({}),
  },
  {
    name: "list_plugins",
    description: "Lists installed plugins with their status, capabilities, and last error.",
    inputSchema: objectSchema({}),
  },
  {
    name: "sample_data",
    description:
      "Returns a real playlist, album, and tracks from this Aurral in the shapes plugins receive. Use them as test input.",
    inputSchema: objectSchema({}),
  },
  {
    name: "write_plugin",
    description:
      "Writes a plugin's manifest.json and index.js (an ES module with every package bundled in), plus optional extra files. Returns whether Aurral can load it. A plugin stays off until an admin turns it on.",
    inputSchema: objectSchema(
      {
        id: { type: "string", description: "The plugin id. It must match manifest.id." },
        manifest: { type: "object", description: "The contents of manifest.json." },
        code: { type: "string", description: "The contents of index.js." },
        files: {
          type: "object",
          description: "Optional extra files, keyed by path relative to the plugin folder.",
          additionalProperties: { type: "string" },
        },
      },
      ["id", "manifest", "code"],
    ),
  },
  {
    name: "test_plugin",
    description:
      "Calls one exported function, such as actions.send, events.track.played, downloadSource.search, importList.fetch, scheduled, or test. Aurral adds settings, libraryFolder, dataFolder, api when the manifest asks for it, and a directory for downloads. Works while the plugin is off. Returns the answer, or the error Aurral would show, plus the plugin's log lines.",
    inputSchema: objectSchema(
      {
        id: { type: "string" },
        path: { type: "string", description: "The exported function, like actions.send." },
        input: {
          type: "object",
          description:
            "The rest of the input, like { playlist } from sample_data. A settings object here replaces the saved settings for this call, so you can test values the admin hasn't saved.",
        },
      },
      ["id", "path"],
    ),
  },
  {
    name: "plugin_logs",
    description:
      "Returns the plugin's recent log lines, newest first, including its console output.",
    inputSchema: objectSchema(
      { id: { type: "string" }, limit: { type: "number", minimum: 1, maximum: 200 } },
      ["id"],
    ),
  },
];

export class PluginToolError extends Error {}

const pluginReference = (guide: string, types: string) =>
  `# Aurral plugin API ${PLUGIN_API_VERSION}\n\n${guide}\n## Types\n\n\`\`\`ts\n${types}\`\`\`\n`;

const answerSchema = (call: string) => {
  if (call.startsWith("actions.") || call === "test") return messageResult;
  if (call === "downloadSource.search") return searchResults;
  if (call === "downloadSource.searchAlbum") return albumResults;
  if (call === "downloadSource.download") return trackDownloadResult;
  if (call === "downloadSource.downloadAlbum") return albumDownloadResult;
  if (call === "downloadSource.status") return statusResult;
  if (call === "importList.fetch") return playlistResult;
  return v.unknown();
};

function safeRelative(file: string) {
  const normalized = path.posix.normalize(file);
  if (path.posix.isAbsolute(normalized) || normalized.startsWith("..") || file.includes("\\"))
    throw new PluginToolError(`${file} is outside the plugin folder`);
  if (["manifest.json", PLUGIN_MAIN].includes(normalized))
    throw new PluginToolError(`Pass ${normalized} as manifest or code`);
  return normalized;
}

async function writePlugin(input: v.InferOutput<(typeof toolInputs)["write_plugin"]>) {
  if (readPlugin(input.id)?.enabled)
    throw new PluginToolError(
      `${input.id} is on. Turn it off in Settings > Plugins before changing it.`,
    );
  const parsed = v.safeParse(pluginManifestSchema, input.manifest);
  if (parsed.success && parsed.output.id !== input.id)
    throw new PluginToolError(`manifest.id is ${parsed.output.id}, but id is ${input.id}`);
  const files = Object.entries(input.files ?? {}).map(
    ([file, content]) => [safeRelative(file), content] as const,
  );
  const folder = pluginFolder(input.id);
  await fs.mkdir(folder, { recursive: true });
  await fs.writeFile(
    path.join(folder, "manifest.json"),
    `${JSON.stringify(input.manifest, null, 2)}\n`,
  );
  await fs.writeFile(path.join(folder, PLUGIN_MAIN), input.code);
  for (const [file, content] of files) {
    const target = path.join(folder, file);
    await fs.mkdir(path.dirname(target), { recursive: true });
    await fs.writeFile(target, content);
  }
  stopPlugin(input.id);
  const folders = await refreshInstalledPlugins();
  const written = folders.find((entry) => entry.id === input.id);
  logger.info(`plugin:${input.id}`, "Plugin written by a developer key");
  return written?.manifest
    ? { loads: true, message: "Aurral can load it. Test it with test_plugin." }
    : { loads: false, error: written?.error ?? "Aurral couldn't read the folder" };
}

async function pluginLogs(pluginId: string, limit: number) {
  const entries = await queryLogs({ cat: `plugin:${pluginId}`, limit });
  return entries.map((entry) => ({
    at: entry.ts,
    level: entry.level,
    message: entry.msg,
    ...(!!entry.data && { data: entry.data }),
  }));
}

async function testPlugin(input: v.InferOutput<(typeof toolInputs)["test_plugin"]>) {
  const plugin = readPlugin(input.id);
  if (!plugin?.manifest) throw new PluginToolError("Write the plugin with write_plugin first");
  if (isSafeMode())
    throw new PluginToolError("Safe mode is on, so no plugin runs. Ask the admin to turn it off.");
  const installed = { ...plugin, manifest: plugin.manifest };
  const downloads = input.path.startsWith("downloadSource.");
  const directory = path.join(resolveAurralDataDir(), "_staging", "plugins", plugin.id, "test");
  if (input.path === "downloadSource.download" || input.path === "downloadSource.downloadAlbum")
    await fs.rm(directory, { recursive: true, force: true });
  if (downloads) await fs.mkdir(directory, { recursive: true });
  const call = {
    ...pluginInput(installed),
    ...(input.path.startsWith("actions.") && { user: SAMPLE_USER }),
    ...(downloads && { directory }),
    ...input.input,
  };
  let result: { ok: true; answer: unknown } | { ok: false; error: string };
  const logs: { level: string; message: string }[] = [];
  const stopWatching = watchPluginLogs(plugin.id, (line) => {
    if (logs.length < MAX_TEST_LOG_LINES) logs.push(line);
  });
  try {
    const answer = await whilePluginTests(plugin.id, () =>
      callPlugin(
        installed,
        { path: input.path, input: call },
        answerSchema(input.path),
        TEST_TIMEOUT_MS,
        { countFailures: false },
      ),
    );
    result = { ok: true, answer };
  } catch (error) {
    if (!(error instanceof PluginError)) throw error;
    result = { ok: false, error: error.message };
  } finally {
    stopWatching();
  }
  const files = downloads
    ? (await fs.readdir(directory, { recursive: true }).catch(() => [])).map(String)
    : undefined;
  return {
    ...result,
    ...(files && { directory, files }),
    logs,
  };
}

async function sampleData() {
  const [first] = flowPlaylistConfig.getStaticPlaylists();
  const playlist = first ? await playlistSnapshot(first.id, first.name, "playlist") : null;
  const sample = getLibraryTrackSample({ availableOnly: true, limit: 5 });
  return {
    playlist: playlist ? { ...playlist, tracks: playlist.tracks.slice(0, 10) } : null,
    album: sample.albums[0] ? albumTarget(sample.albums[0].id) : null,
    artist: sample.artists[0] ? artistTarget(sample.artists[0].id) : null,
    tracks: sample.tracks.length ? tracksTarget(sample.tracks.map((track) => track.id)) : [],
  };
}

async function runTool(name: ToolName, raw: unknown) {
  if (name === "plugin_docs") {
    const [guide, types] = await Promise.all([
      fs.readFile(GUIDE_FILE, "utf8"),
      fs.readFile(TYPES_FILE, "utf8"),
    ]);
    return pluginReference(guide, types);
  }
  if (name === "list_plugins") return listPlugins();
  if (name === "sample_data") return sampleData();
  if (name === "write_plugin") return writePlugin(v.parse(toolInputs.write_plugin, raw));
  if (name === "test_plugin") return testPlugin(v.parse(toolInputs.test_plugin, raw));
  const { id: pluginId, limit } = v.parse(toolInputs.plugin_logs, raw);
  return pluginLogs(pluginId, limit);
}

const isToolName = (name: string): name is ToolName => Object.hasOwn(toolInputs, name);

export async function callPluginTool(name: string, args: unknown) {
  if (!isToolName(name)) throw new PluginToolError(`Unknown tool ${name}`);
  const input = v.safeParse(toolInputs[name], args ?? {});
  if (!input.success) {
    const [issue] = input.issues;
    const at = v.getDotPath(issue);
    throw new PluginToolError(`${at ? `${at}: ` : ""}${issue.message}`);
  }
  const result = await runTool(name, input.output);
  return typeof result === "string" ? result : JSON.stringify(result, null, 2);
}

export const PLUGIN_MCP_SERVER = {
  name: "aurral-plugins",
  version: APP_VERSION,
  instructions:
    "Builds Aurral plugins. Call plugin_docs first. Write the plugin with write_plugin, then call test_plugin with input from sample_data until every capability answers correctly. Tell the user to turn it on in Settings > Plugins.",
};
