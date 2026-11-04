import * as v from "valibot";
import { normalizePlaylistTrack } from "../playlists/playlistTracks.ts";
import { callPlugin, PluginError } from "./pluginHost.ts";
import {
  activePlugins,
  activePluginWith,
  isCapabilityOn,
  pluginIdFromSource,
  pluginInput,
  PLUGIN_SOURCE_PREFIX,
} from "./pluginStore.ts";

const FETCH_TIMEOUT_MS = 2 * 60_000;
const MAX_TRACKS = 5000;

const optionalText = v.nullish(v.pipe(v.string(), v.maxLength(500)));
export const playlistResult = v.object({
  name: v.pipe(v.string(), v.trim(), v.minLength(1), v.maxLength(200)),
  artworkUrl: v.nullish(v.pipe(v.string(), v.url(), v.startsWith("https://"))),
  tracks: v.pipe(
    v.array(
      v.object({
        artist: v.pipe(v.string(), v.maxLength(500)),
        title: v.pipe(v.string(), v.maxLength(500)),
        album: optionalText,
        durationMs: v.nullish(v.pipe(v.number(), v.minValue(0))),
        mbid: optionalText,
      }),
    ),
    v.maxLength(MAX_TRACKS),
  ),
});

export class PluginImportError extends Error {
  declare statusCode: 400 | 404 | 502;
  constructor(message: string, statusCode: PluginImportError["statusCode"] = 502) {
    super(message);
    this.statusCode = statusCode;
  }
}

const hostMatches = (host: string, allowed: string) =>
  host === allowed || host.endsWith(`.${allowed}`);

export function listPluginImportLists() {
  return activePlugins()
    .filter((plugin) => plugin.manifest.importList && isCapabilityOn(plugin, "importList"))
    .map((plugin) => ({
      pluginId: plugin.id,
      label: plugin.manifest.importList?.label ?? plugin.manifest.name,
      hosts: plugin.manifest.importList?.hosts ?? [],
    }));
}

export const pluginImportProvider = (pluginId: string) => `${PLUGIN_SOURCE_PREFIX}${pluginId}`;

export async function fetchPluginPlaylist(provider: string, url: string) {
  const pluginId = pluginIdFromSource(provider);
  const plugin = pluginId ? activePluginWith(pluginId, "importList") : null;
  if (!plugin?.manifest.importList)
    throw new PluginImportError("The import plugin is turned off", 404);
  const host = URL.parse(url)?.hostname.toLowerCase() ?? "";
  if (!plugin.manifest.importList.hosts.some((allowed) => hostMatches(host, allowed)))
    throw new PluginImportError(
      `${plugin.manifest.name} doesn't import links from ${host || "there"}`,
      400,
    );
  try {
    const playlist = await callPlugin(
      plugin,
      { path: "importList.fetch", input: { ...pluginInput(plugin), url } },
      playlistResult,
      FETCH_TIMEOUT_MS,
    );
    const tracks = playlist.tracks.flatMap((track) => normalizePlaylistTrack(track) ?? []);
    return {
      id: url,
      label: plugin.manifest.importList.label,
      name: playlist.name,
      artworkUrl: playlist.artworkUrl ?? null,
      tracks,
      stats: {
        sourceItems: playlist.tracks.length,
        incomplete: playlist.tracks.length - tracks.length,
        duplicate: 0,
      },
    };
  } catch (error) {
    if (!(error instanceof PluginError)) throw error;
    throw new PluginImportError(`${plugin.manifest.name}: ${error.message}`);
  }
}
