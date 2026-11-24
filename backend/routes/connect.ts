import { Hono } from "hono";
import * as v from "valibot";
import { requireAdmin, requireAuth, requireUserAccount } from "../middleware/guards.ts";
import type { AppEnv } from "../middleware/requestUser.ts";
import { validate } from "../middleware/validate.ts";
import {
  ConnectServiceError,
  disableConnect,
  enableConnect,
  getConnectAccount,
  getConnectStatus,
  reconnectConnect,
  updateConnect,
} from "../services/connect/connectClient.ts";

const enableBody = v.object({
  slug: v.pipe(v.string(), v.trim(), v.minLength(3), v.maxLength(32)),
  name: v.pipe(v.string(), v.trim(), v.minLength(1), v.maxLength(64)),
  startTrial: v.optional(v.boolean()),
  allowHubSignIn: v.optional(v.boolean()),
});

const updateBody = v.object({
  slug: v.optional(v.pipe(v.string(), v.trim(), v.minLength(3), v.maxLength(32))),
  name: v.optional(v.pipe(v.string(), v.trim(), v.minLength(1), v.maxLength(64))),
  allowHubSignIn: v.optional(v.boolean()),
});

export default new Hono<AppEnv>()
  .basePath("/connect")
  .use(requireAuth, requireAdmin)
  .get("/", (c) => c.json(getConnectStatus()))
  .get("/account", requireUserAccount, async (c) =>
    c.json({ account: await getConnectAccount(c.var.user.id) }),
  )
  .post("/reconnect", requireUserAccount, async (c) => {
    try {
      return c.json(await reconnectConnect(), 200);
    } catch (error) {
      if (error instanceof ConnectServiceError) {
        return c.json({ error: error.code, message: error.message }, error.status);
      }
      throw error;
    }
  })
  .post("/enable", requireUserAccount, validate("json", enableBody), async (c) => {
    try {
      return c.json(
        await enableConnect(c.var.user.id, {
          ...c.req.valid("json"),
          deferTransportChange: c.var.viaConnect === true,
        }),
        200,
      );
    } catch (error) {
      if (error instanceof ConnectServiceError) {
        return c.json({ error: error.code, message: error.message }, error.status);
      }
      throw error;
    }
  })
  .patch("/", requireUserAccount, validate("json", updateBody), async (c) => {
    try {
      return c.json(
        await updateConnect(c.var.user.id, {
          ...c.req.valid("json"),
          deferTransportChange: c.var.viaConnect === true,
        }),
        200,
      );
    } catch (error) {
      if (error instanceof ConnectServiceError) {
        return c.json({ error: error.code, message: error.message }, error.status);
      }
      throw error;
    }
  })
  .post("/disable", requireUserAccount, async (c) =>
    c.json(
      await disableConnect(c.var.user.id, { deferTransportChange: c.var.viaConnect === true }),
      200,
    ),
  );
