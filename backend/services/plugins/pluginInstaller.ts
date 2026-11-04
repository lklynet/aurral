import { randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { resolveAurralDataDir } from "../../config/data-dir.ts";
import { logger } from "../logger.ts";
import { extractZipEntry, readZipEntries, ZipFormatError } from "../zip.ts";
import { stopPlugin } from "./pluginHost.ts";
import { pluginFolder, readPluginManifestAt, type PluginManifest } from "./pluginManifest.ts";
import { PluginRequestError, refreshInstalledPlugins } from "./pluginService.ts";
import { readPlugin, savePluginSourceUrl } from "./pluginStore.ts";

const MAX_ARCHIVE_BYTES = 20 * 1024 * 1024;
const MAX_EXTRACTED_BYTES = 50 * 1024 * 1024;
const MAX_FILES = 500;
const DOWNLOAD_TIMEOUT_MS = 60_000;
const INSPECT_TTL_MS = 15 * 60_000;

type Inspected = {
  url: string;
  root: string;
  folder: string;
  manifest: PluginManifest;
  expiresAt: number;
};

const inspected = new Map<string, Inspected>();
const installsDir = () => path.join(resolveAurralDataDir(), "_staging", "plugin-installs");

async function downloadArchive(url: string, file: string) {
  const response = await fetch(url, { signal: AbortSignal.timeout(DOWNLOAD_TIMEOUT_MS) }).catch(
    (error: unknown) => {
      throw new PluginRequestError(400, `Couldn't download the plugin: ${String(error)}`);
    },
  );
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

export async function unpackPluginArchive(file: string, target: string) {
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
  const read = await readPluginManifestAt(target);
  if (!read.manifest) throw new PluginRequestError(400, `This plugin can't load: ${read.error}`);
  return read.manifest;
}

function forgetExpired() {
  const now = Date.now();
  for (const [token, entry] of inspected) {
    if (entry.expiresAt > now) continue;
    inspected.delete(token);
    void fs.rm(entry.root, { recursive: true, force: true });
  }
}

export async function inspectPluginLink(url: string) {
  forgetExpired();
  const token = randomUUID();
  const root = path.join(installsDir(), token);
  const folder = path.join(root, "plugin");
  await fs.mkdir(folder, { recursive: true });
  try {
    const archive = path.join(root, "plugin.zip");
    await downloadArchive(url, archive);
    const manifest = await unpackPluginArchive(archive, folder);
    inspected.set(token, { url, root, folder, manifest, expiresAt: Date.now() + INSPECT_TTL_MS });
    const current = readPlugin(manifest.id)?.manifest ?? null;
    return { token, manifest, installedVersion: current?.version ?? null };
  } catch (error) {
    await fs.rm(root, { recursive: true, force: true });
    throw error;
  }
}

async function moveIntoPlace(entry: Inspected) {
  const target = pluginFolder(entry.manifest.id);
  const previous = `${target}.previous`;
  stopPlugin(entry.manifest.id);
  await fs.rm(previous, { recursive: true, force: true });
  const replacing = await fs.stat(target).then(
    () => true,
    () => false,
  );
  if (replacing) await fs.rename(target, previous);
  await fs.mkdir(path.dirname(target), { recursive: true });
  await fs.rename(entry.folder, target);
  await fs.rm(previous, { recursive: true, force: true });
  await fs.rm(entry.root, { recursive: true, force: true });
  await refreshInstalledPlugins();
  savePluginSourceUrl(entry.manifest.id, entry.url);
  logger.info(`plugin:${entry.manifest.id}`, replacing ? "Plugin updated" : "Plugin installed", {
    version: entry.manifest.version,
    url: entry.url,
  });
}

export async function installPluginLink(token: string) {
  forgetExpired();
  const entry = inspected.get(token);
  if (!entry) throw new PluginRequestError(404, "Check the link again before installing");
  inspected.delete(token);
  await moveIntoPlace(entry);
  return { id: entry.manifest.id, version: entry.manifest.version };
}

export async function updatePluginFromSource(id: string) {
  const url = readPlugin(id)?.sourceUrl;
  if (!url) throw new PluginRequestError(404, "This plugin wasn't installed from a link");
  const { token, manifest } = await inspectPluginLink(url);
  if (manifest.id !== id) {
    const entry = inspected.get(token);
    inspected.delete(token);
    if (entry) await fs.rm(entry.root, { recursive: true, force: true });
    throw new PluginRequestError(400, `The link now has the plugin ${manifest.id}`);
  }
  return installPluginLink(token);
}
