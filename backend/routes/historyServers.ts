import { Hono } from "hono";
import * as v from "valibot";
import { requireAuth, requirePermission, requireUserAccount } from "../middleware/guards.ts";
import type { AppEnv } from "../middleware/requestUser.ts";
import { validate } from "../middleware/validate.ts";
import { validateExternalUrl } from "../middleware/urlValidator.ts";
import { enqueueSystemTaskJob } from "../services/honkerDb.ts";
import {
  connectHistoryServer,
  disconnectHistoryServer,
  HISTORY_SERVER_PROVIDERS,
  HistoryServerError,
  listHistoryServers,
  LOGIN_HISTORY_SERVERS,
} from "../services/historyServers.ts";
import { logger } from "../services/logger.ts";
import { asAppError } from "../../lib/errors.ts";

const providerParam = v.object({ provider: v.picklist(HISTORY_SERVER_PROVIDERS) });
const loginProviderParam = v.object({ provider: v.picklist(LOGIN_HISTORY_SERVERS) });
const connectBody = v.object({
  url: v.string(),
  username: v.string(),
  secret: v.optional(v.string()),
});

const queueSync = (userId: number, provider: string) =>
  enqueueSystemTaskJob({ kind: "history-server-sync", userId, provider });

export default new Hono<AppEnv>()
  .basePath("/history-servers")
  .get("/", requireAuth, requireUserAccount, (c) =>
    c.json({ servers: listHistoryServers(c.var.user.id) }, 200),
  )
  .put(
    "/:provider",
    requirePermission("accessSettings"),
    requireUserAccount,
    validate("param", loginProviderParam),
    validate("json", connectBody),
    async (c) => {
      const { provider } = c.req.valid("param");
      const body = c.req.valid("json");
      const url = validateExternalUrl(body.url);
      const username = body.username.trim();
      if (!url.valid) return c.json({ error: url.error }, 400);
      if (!username) return c.json({ error: "Enter a username" }, 400);
      try {
        const server = await connectHistoryServer(c.var.user.id, provider, {
          url: url.url,
          username,
          secret: body.secret?.trim() || null,
        });
        queueSync(c.var.user.id, provider);
        return c.json({ server }, 200);
      } catch (error) {
        if (error instanceof HistoryServerError) return c.json({ error: error.message }, 400);
        const failure = asAppError(error);
        logger.warn("listening", "Could not connect a listening history server", {
          provider,
          message: failure?.message,
          status: failure?.response?.status ?? null,
        });
        const status = Number(failure?.response?.status);
        return c.json(
          {
            error:
              status === 401 || status === 403
                ? "The server rejected that login"
                : "Couldn't reach the server",
          },
          400,
        );
      }
    },
  )
  .post(
    "/:provider/sync",
    requireAuth,
    requireUserAccount,
    validate("param", providerParam),
    (c) => {
      queueSync(c.var.user.id, c.req.valid("param").provider);
      return c.body(null, 202);
    },
  )
  .delete(
    "/:provider",
    requireAuth,
    requireUserAccount,
    validate("param", providerParam),
    async (c) => {
      await disconnectHistoryServer(c.var.user.id, c.req.valid("param").provider);
      return c.body(null, 204);
    },
  );
