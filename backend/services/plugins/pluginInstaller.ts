import { randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import * as v from "valibot";
import { resolveAurralDataDir } from "../../config/data-dir.ts";
import { logger } from "../logger.ts";
import { extractZipEntry, readZipEntries, ZipFormatError } from "../zip.ts";
import { stopPlugin } from "./pluginHost.ts";
import {
  pluginCapabilities,
  pluginFolder,
  readPluginManifestAt,
  type PluginManifest,
} from "./pluginManifest.ts";
import { PluginRequestError, refreshInstalledPlugins } from "./pluginService.ts";
import { readPlugin, savePluginSourceUrl } from "./pluginStore.ts";

const MAX_ARCHIVE_BYTES = 20 * 1024 * 1024;
const MAX_EXTRACTED_BYTES = 50 * 1024 * 1024;
const MAX_FILES = 500;
const MAX_SEARCH_DEPTH = 2;
const DOWNLOAD_TIMEOUT_MS = 60_000;
const INSPECT_TTL_MS = 15 * 60_000;
const GITHUB_API = "https://api.github.com";
const GITHUB_REPO = /^https:\/\/github\.com\/([\w.-]+)\/([\w.-]+?)(?:\.git)?\/?$/;
const HEADERS = { "User-Agent": "Aurral" };

type Found = { folder: string; manifest: PluginManifest };
type Problem = { folder: string; error: string };
type Inspected = { url: string; root: string; plugins: Found[]; expiresAt: number };

const inspected = new Map<string, Inspected>();
const installsDir = () => path.join(resolveAurralDataDir(), "_staging", "plugin-installs");

const latestRelease = v.object({
  tag_name: v.string(),
  assets: v.array(v.object({ name: v.string(), browser_download_url: v.string() })),
});

async function archiveUrl(url: string) {
  const match = GITHUB_REPO.exec(url);
  if (!match) return url;
  const repo = `${GITHUB_API}/repos/${match[1]}/${match[2]}`;
  const response = await fetch(`${repo}/releases/latest`, {
    headers: { ...HEADERS, Accept: "application/vnd.github+json" },
    signal: AbortSignal.timeout(DOWNLOAD_TIMEOUT_MS),
  }).catch((error: unknown) => {
    throw new PluginRequestError(400, `Couldn't reach GitHub: ${String(error)}`);
  });
  if (response.status === 404) return `${repo}/zipball`;
  if (!response.ok) throw new PluginRequestError(400, `GitHub answered HTTP ${response.status}`);
  const release = v.safeParse(latestRelease, await response.json());
  if (!release.success) return `${repo}/zipball`;
  const asset = release.output.assets.find((entry) => entry.name.endsWith(".zip"));
  return (
    asset?.browser_download_url ?? `${repo}/zipball/${encodeURIComponent(release.output.tag_name)}`
  );
}

async function downloadArchive(url: string, file: string) {
  const response = await fetch(url, {
    headers: HEADERS,
    signal: AbortSignal.timeout(DOWNLOAD_TIMEOUT_MS),
  }).catch((error: unknown) => {
    throw new PluginRequestError(400, `Couldn't download the plugin: ${String(error)}`);
  });
  if (!response.ok || !response.body)
    throw new PluginRequestError(400, `Couldn't download the plugin: HTTP ${response.status}`);
  if (Number(response.headers.get("content-length") || 0) > MAX_ARCHIVE_BYTES)
    throw new PluginRequestError(400, "The plugin is larger than 20 MB");
  const handle = await fs.open(file, "w");
  let received = 0;
  try {
    for await (const chunk of response.body) {
      received += chunk.length;
      if (received > MAX_ARCHIVE_BYTES)
        throw new PluginRequestError(400, "The plugin is larger than 20 MB");
      await handle.write(chunk);
    }
  } finally {
    await handle.close();
  }
}

function safeName(name: string) {
  const normalized = path.posix.normalize(name);
  return !path.posix.isAbsolute(normalized) && !normalized.startsWith("..") && !name.includes("\\");
}

async function extractArchive(file: string, target: string) {
  let entries;
  try {
    entries = (await readZipEntries(file)).filter((entry) => !entry.name.endsWith("/"));
  } catch (error) {
    if (error instanceof ZipFormatError) throw new PluginRequestError(400, error.message);
    throw error;
  }
  if (entries.length === 0) throw new PluginRequestError(400, "The zip file is empty");
  if (entries.length > MAX_FILES)
    throw new PluginRequestError(400, "The plugin has too many files");
  if (entries.reduce((total, entry) => total + entry.size, 0) > MAX_EXTRACTED_BYTES)
    throw new PluginRequestError(400, "The plugin is larger than 50 MB unpacked");
  if (!entries.every((entry) => safeName(entry.name)))
    throw new PluginRequestError(400, "The zip file has a path outside its folder");
  const tops = new Set(entries.map((entry) => entry.name.split("/")[0]));
  const nested = !entries.some((entry) => entry.name === "manifest.json") && tops.size === 1;
  const strip = nested ? `${[...tops][0]}/` : "";
  for (const entry of entries) {
    const destination = path.join(target, entry.name.slice(strip.length));
    await fs.mkdir(path.dirname(destination), { recursive: true });
    try {
      await extractZipEntry(file, entry, destination, { allowDeflate: true });
    } catch (error) {
      if (error instanceof ZipFormatError) throw new PluginRequestError(400, error.message);
      throw error;
    }
  }
}

async function pluginFolders(dir: string, depth = 0): Promise<string[]> {
  if (
    await fs.access(path.join(dir, "manifest.json")).then(
      () => true,
      () => false,
    )
  )
    return [dir];
  if (depth >= MAX_SEARCH_DEPTH) return [];
  const entries = await fs.readdir(dir, { withFileTypes: true });
  const children = entries.filter(
    (entry) => entry.isDirectory() && !entry.name.startsWith(".") && entry.name !== "node_modules",
  );
  const found = await Promise.all(
    children.map((entry) => pluginFolders(path.join(dir, entry.name), depth + 1)),
  );
  return found.flat().sort();
}

export async function unpackPluginArchive(file: string, target: string) {
  await extractArchive(file, target);
  const plugins: Found[] = [];
  const problems: Problem[] = [];
  for (const folder of await pluginFolders(target)) {
    const name = path.relative(target, folder) || ".";
    const read = await readPluginManifestAt(folder);
    if (!read.manifest) problems.push({ folder: name, error: read.error });
    else if (plugins.some((plugin) => plugin.manifest.id === read.manifest.id))
      problems.push({ folder: name, error: `Another folder has the id ${read.manifest.id}` });
    else plugins.push({ folder, manifest: read.manifest });
  }
  if (plugins.length) return { plugins, problems };
  const [problem] = problems;
  if (!problem)
    throw new PluginRequestError(
      400,
      "No plugins found. A plugin is a folder with manifest.json and index.js.",
    );
  const where = problem.folder === "." ? "This plugin" : problem.folder;
  throw new PluginRequestError(400, `${where} can't load: ${problem.error}`);
}

export async function discardPluginLink(token: string) {
  const entry = inspected.get(token);
  inspected.delete(token);
  if (entry) await fs.rm(entry.root, { recursive: true, force: true });
}

function forgetExpired() {
  const now = Date.now();
  for (const [token, entry] of inspected) if (entry.expiresAt <= now) void discardPluginLink(token);
}

export async function inspectPluginLink(url: string) {
  forgetExpired();
  const token = randomUUID();
  const root = path.join(installsDir(), token);
  const folder = path.join(root, "plugins");
  await fs.mkdir(folder, { recursive: true });
  try {
    const archive = path.join(root, "plugins.zip");
    await downloadArchive(await archiveUrl(url), archive);
    const { plugins, problems } = await unpackPluginArchive(archive, folder);
    inspected.set(token, { url, root, plugins, expiresAt: Date.now() + INSPECT_TTL_MS });
    return {
      token,
      plugins: plugins.map(({ manifest }) => ({
        manifest,
        capabilities: pluginCapabilities(manifest),
        installedVersion: readPlugin(manifest.id)?.manifest?.version ?? null,
      })),
      problems,
    };
  } catch (error) {
    await fs.rm(root, { recursive: true, force: true });
    throw error;
  }
}

async function moveIntoPlace({ folder, manifest }: Found) {
  const target = pluginFolder(manifest.id);
  const previous = `${target}.previous`;
  stopPlugin(manifest.id);
  await fs.rm(previous, { recursive: true, force: true });
  const replacing = await fs.stat(target).then(
    () => true,
    () => false,
  );
  if (replacing) await fs.rename(target, previous);
  await fs.mkdir(path.dirname(target), { recursive: true });
  await fs.rename(folder, target);
  await fs.rm(previous, { recursive: true, force: true });
  return replacing;
}

export async function installPluginLink(token: string, ids: string[]) {
  forgetExpired();
  const entry = inspected.get(token);
  if (!entry) throw new PluginRequestError(404, "Check the link again before installing");
  const chosen = entry.plugins.filter((plugin) => ids.includes(plugin.manifest.id));
  if (!chosen.length || chosen.length !== new Set(ids).size)
    throw new PluginRequestError(400, "Choose plugins from this link");
  entry.plugins = entry.plugins.filter((plugin) => !chosen.includes(plugin));
  if (!entry.plugins.length) inspected.delete(token);
  const replaced = [];
  try {
    for (const plugin of chosen) replaced.push(await moveIntoPlace(plugin));
  } finally {
    if (!entry.plugins.length) await fs.rm(entry.root, { recursive: true, force: true });
  }
  await refreshInstalledPlugins();
  for (const [index, { manifest }] of chosen.entries()) {
    savePluginSourceUrl(manifest.id, entry.url);
    logger.info(`plugin:${manifest.id}`, replaced[index] ? "Plugin updated" : "Plugin installed", {
      version: manifest.version,
      url: entry.url,
    });
  }
  return {
    installed: chosen.map(({ manifest }) => ({ id: manifest.id, version: manifest.version })),
  };
}

export async function updatePluginFromSource(id: string) {
  const url = readPlugin(id)?.sourceUrl;
  if (!url) throw new PluginRequestError(404, "This plugin wasn't installed from a link");
  const { token, plugins } = await inspectPluginLink(url);
  try {
    if (!plugins.some((plugin) => plugin.manifest.id === id))
      throw new PluginRequestError(400, `The link no longer has ${id}`);
    return await installPluginLink(token, [id]);
  } finally {
    await discardPluginLink(token);
  }
}
