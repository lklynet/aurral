import { Hono, type Context, type Input } from "hono";
import * as v from "valibot";
import { requireAdmin, requireAuth } from "../middleware/guards.ts";
import type { AppEnv } from "../middleware/requestUser.ts";
import { validate } from "../middleware/validate.ts";
import { stopAllPlugins } from "../services/plugins/pluginHost.ts";
import {
  createPluginDevKey,
  listPluginDevKeys,
  revokePluginDevKey,
} from "../services/plugins/pluginDevKeys.ts";
import {
  discardPluginLink,
  inspectPluginLink,
  installPluginLink,
  updateAllPlugins,
  updatePluginFromSource,
} from "../services/plugins/pluginInstaller.ts";
import {
  listPluginActions,
  listPlugins,
  PluginRequestError,
  removePlugin,
  runPluginAction,
  testPlugin,
  updatePlugin,
} from "../services/plugins/pluginService.ts";
import { setSafeMode } from "../services/plugins/pluginStore.ts";
import {
  fetchPluginPlaylist,
  listPluginImportLists,
  pluginImportProvider,
  PluginImportError,
} from "../services/plugins/pluginImportList.ts";
import { enqueueImportedPlaylist } from "../services/importLists/importPlaylist.ts";
import { asAppError } from "../../lib/errors.ts";
import { importSettings, requirePlaylistAccess } from "./playlists/handlers/utils.ts";

const pluginParam = v.object({ id: v.string() });
const reference = v.union([v.pipe(v.string(), v.minLength(1)), v.number()]);
const httpsUrl = v.pipe(v.string(), v.trim(), v.url(), v.startsWith("https://"));

async function importAnswer<Env extends AppEnv, Path extends string, In extends Input, Result>(
  c: Context<Env, Path, In>,
  run: () => Promise<Result>,
) {
  try {
    return c.json(await run(), 200);
  } catch (error) {
    if (error instanceof PluginImportError)
      return c.json({ error: error.message }, error.statusCode);
    if (asAppError(error)?.code === "STATIC_PLAYLIST_NAME_CONFLICT")
      return c.json({ error: "Playlist name already exists" }, 409);
    throw error;
  }
}

async function answer<Env extends AppEnv, Path extends string, In extends Input, Result>(
  c: Context<Env, Path, In>,
  run: () => Result | Promise<Result>,
) {
  try {
    return c.json(await run(), 200);
  } catch (error) {
    if (error instanceof PluginRequestError) return c.json({ error: error.message }, error.status);
    throw error;
  }
}

export default new Hono<AppEnv>()
  .basePath("/plugins")
  .get("/", requireAuth, requireAdmin, async (c) => c.json(await listPlugins(), 200))
  .put(
    "/safe-mode",
    requireAuth,
    requireAdmin,
    validate("json", v.object({ enabled: v.boolean() })),
    (c) => {
      const { enabled } = c.req.valid("json");
      setSafeMode(enabled);
      if (enabled) stopAllPlugins();
      return c.json({ safeMode: enabled }, 200);
    },
  )
  .get("/actions", requireAuth, (c) => c.json({ actions: listPluginActions(c.var.user) }, 200))
  .get("/import-lists", requireAuth, (c) => c.json({ importLists: listPluginImportLists() }, 200))
  .post(
    "/install/inspect",
    requireAuth,
    requireAdmin,
    validate("json", v.object({ url: httpsUrl })),
    (c) => answer(c, () => inspectPluginLink(c.req.valid("json").url)),
  )
  .post(
    "/install",
    requireAuth,
    requireAdmin,
    validate(
      "json",
      v.object({
        token: v.pipe(v.string(), v.minLength(1)),
        ids: v.pipe(v.array(v.string()), v.minLength(1), v.maxLength(100)),
      }),
    ),
    (c) => {
      const { token, ids } = c.req.valid("json");
      return answer(c, () => installPluginLink(token, ids));
    },
  )
  .delete(
    "/install/:token",
    requireAuth,
    requireAdmin,
    validate("param", v.object({ token: v.string() })),
    async (c) => {
      await discardPluginLink(c.req.valid("param").token);
      return c.json({ ok: true }, 200);
    },
  )
  .get("/dev-keys", requireAuth, requireAdmin, (c) => c.json({ keys: listPluginDevKeys() }, 200))
  .post("/dev-keys", requireAuth, requireAdmin, (c) => c.json(createPluginDevKey(), 200))
  .delete(
    "/dev-keys/:keyId",
    requireAuth,
    requireAdmin,
    validate("param", v.object({ keyId: v.pipe(v.string(), v.toNumber(), v.integer()) })),
    (c) => {
      revokePluginDevKey(c.req.valid("param").keyId);
      return c.json({ ok: true }, 200);
    },
  )
  .put(
    "/:id",
    requireAuth,
    requireAdmin,
    validate("param", pluginParam),
    validate(
      "json",
      v.object({
        enabled: v.optional(v.boolean()),
        settings: v.optional(v.record(v.string(), v.unknown())),
        priority: v.optional(v.pipe(v.number(), v.integer(), v.minValue(1), v.maxValue(100))),
        capabilities: v.optional(v.record(v.string(), v.boolean())),
      }),
    ),
    (c) =>
      answer(c, () => {
        updatePlugin(c.req.valid("param").id, c.req.valid("json"));
        return { ok: true };
      }),
  )
  .delete("/:id", requireAuth, requireAdmin, validate("param", pluginParam), (c) =>
    answer(c, async () => {
      await removePlugin(c.req.valid("param").id);
      return { ok: true };
    }),
  )
  .post("/:id/test", requireAuth, requireAdmin, validate("param", pluginParam), (c) =>
    answer(c, () => testPlugin(c.req.valid("param").id)),
  )
  .post("/updates", requireAuth, requireAdmin, (c) => answer(c, updateAllPlugins))
  .post("/:id/update", requireAuth, requireAdmin, validate("param", pluginParam), (c) =>
    answer(c, () => updatePluginFromSource(c.req.valid("param").id)),
  )
  .post(
    "/:id/import/preview",
    requireAuth,
    requirePlaylistAccess,
    validate("param", pluginParam),
    validate("json", v.object({ url: httpsUrl })),
    (c) =>
      importAnswer(c, async () => {
        const playlist = await fetchPluginPlaylist(
          pluginImportProvider(c.req.valid("param").id),
          c.req.valid("json").url,
        );
        return {
          playlist: { id: playlist.id, name: playlist.name },
          trackCount: playlist.tracks.length,
          skipped: playlist.stats.incomplete,
          previewTracks: playlist.tracks.slice(0, 3),
        };
      }),
  )
  .post(
    "/:id/import",
    requireAuth,
    requirePlaylistAccess,
    validate("param", pluginParam),
    validate("json", v.object({ ...importSettings, url: httpsUrl })),
    (c) =>
      importAnswer(c, async () => {
        const body = c.req.valid("json");
        const provider = pluginImportProvider(c.req.valid("param").id);
        const playlist = await fetchPluginPlaylist(provider, body.url);
        const syncIntervalHours = playlist.sync
          ? Math.max(0, Number(body.syncIntervalHours ?? 24) || 0)
          : 0;
        const result = await enqueueImportedPlaylist({
          ownerUserId: c.var.user.id,
          name: body.name.trim() || playlist.name,
          sourceName: playlist.label,
          provider,
          externalId: playlist.id,
          externalName: playlist.name,
          tracks: playlist.tracks,
          sourceStats: playlist.stats,
          artworkUrl: playlist.artworkUrl,
          syncEnabled: body.syncEnabled === false ? false : syncIntervalHours > 0,
          syncIntervalHours,
          keepRemovedTracks: body.keepRemovedTracks !== false,
        });
        return {
          success: true,
          tracksQueued: Number(result?.tracksQueued || 0),
          queued: result?.queued === true,
        };
      }),
  )
  .post(
    "/:id/actions/:action",
    requireAuth,
    validate("param", v.object({ id: v.string(), action: v.string() })),
    validate(
      "json",
      v.object({
        playlistId: v.optional(v.pipe(v.string(), v.minLength(1))),
        albumId: v.optional(reference),
        artistId: v.optional(reference),
        trackIds: v.optional(v.pipe(v.array(reference), v.minLength(1), v.maxLength(500))),
      }),
    ),
    (c) => {
      const { id, action } = c.req.valid("param");
      return answer(c, () => runPluginAction(c.var.user, id, action, c.req.valid("json")));
    },
  );
