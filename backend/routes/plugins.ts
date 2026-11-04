import { Hono } from "hono";
import * as v from "valibot";
import { requireAdmin, requireAuth, requirePermission } from "../middleware/guards.ts";
import type { AppEnv } from "../middleware/requestUser.ts";
import { validate } from "../middleware/validate.ts";
import { stopAllPlugins } from "../services/plugins/pluginHost.ts";
import {
  listPluginActions,
  listPlugins,
  PluginRequestError,
  runPluginAction,
  updatePlugin,
} from "../services/plugins/pluginService.ts";
import { setSafeMode } from "../services/plugins/pluginStore.ts";

const pluginParam = v.object({ id: v.string() });

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
      }),
    ),
    (c) => {
      try {
        updatePlugin(c.req.valid("param").id, c.req.valid("json"));
        return c.json({ ok: true }, 200);
      } catch (error) {
        if (error instanceof PluginRequestError)
          return c.json({ error: error.message }, error.status);
        throw error;
      }
    },
  )
  .post(
    "/:id/actions/:action",
    requireAuth,
    requirePermission("accessFlow"),
    validate("param", v.object({ id: v.string(), action: v.string() })),
    validate("json", v.object({ playlistId: v.pipe(v.string(), v.minLength(1)) })),
    async (c) => {
      const { id, action } = c.req.valid("param");
      try {
        return c.json(await runPluginAction(c.var.user, id, action, c.req.valid("json")), 200);
      } catch (error) {
        if (error instanceof PluginRequestError)
          return c.json({ error: error.message }, error.status);
        throw error;
      }
    },
  );
