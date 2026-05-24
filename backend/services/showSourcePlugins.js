import { readdir } from "fs/promises";
import { join } from "path";
import { pathToFileURL } from "url";

const plugins = [];

export function registerShowSourcePlugin(plugin) {
  if (!plugin?.id || typeof plugin.fetchEvents !== "function") {
    throw new Error(
      `Show source plugin must have an "id" string and a fetchEvents() function`,
    );
  }
  plugins.push(plugin);
  console.log(`[plugins] Registered show source: ${plugin.name || plugin.id}`);
}

export function getShowSourcePlugins() {
  return [...plugins];
}

export async function loadShowSourcePluginsFromDir(dir) {
  let files;
  try {
    files = await readdir(dir);
  } catch {
    return;
  }
  const jsFiles = files.filter((f) => f.endsWith(".js"));
  for (const file of jsFiles) {
    try {
      const mod = await import(pathToFileURL(join(dir, file)).href);
      const plugin = mod.default ?? mod;
      registerShowSourcePlugin(plugin);
    } catch (err) {
      console.warn(`[plugins] Failed to load ${file}:`, err.message);
    }
  }
}
