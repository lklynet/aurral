import { Hono } from "hono";
import * as v from "valibot";
import { asAppError } from "../../lib/errors.ts";
import { requireAdmin, requireAuth, requireUserAccount } from "../middleware/guards.ts";
import type { AppEnv } from "../middleware/requestUser.ts";
import { validateExternalUrl } from "../middleware/urlValidator.ts";
import { validate } from "../middleware/validate.ts";
import {
  connectPlexHistory,
  forgetPlexHistoryServer,
  HistoryServerError,
} from "../services/historyServers.ts";
import { enqueueSystemTask } from "../services/jobs/queues.ts";
import { logger } from "../services/logger.ts";
import {
  connectPlexServer,
  finishPlexSignIn,
  getPlexServer,
  plexHistoryAccount,
  plexPlaylistError,
  PlexError,
  removePlexServer,
  savePlexServer,
  startPlexSignIn,
} from "../services/plex.ts";
import { playlistManager } from "../services/playlists/playlistManager.ts";

const queueHistorySync = (userId: number) =>
  enqueueSystemTask({ kind: "history-server-sync", userId, provider: "plex" });

async function finishSignIn(userId: number, token: string, serverUrl: string | undefined) {
  if (serverUrl) {
    const owner = await connectPlexServer(serverUrl, token);
    forgetPlexHistoryServer();
    await connectPlexHistory(userId, { url: serverUrl, ...owner });
    playlistManager.requestPlexUpload();
  } else {
    const server = getPlexServer();
    if (!server) throw new PlexError("An admin has to connect the Plex server first");
    await connectPlexHistory(userId, {
      url: server.url,
      ...(await plexHistoryAccount(server, token)),
    });
  }
  queueHistorySync(userId);
}

export default new Hono<AppEnv>()
  .basePath("/plex")
  .get("/", requireAuth, requireUserAccount, (c) => {
    const server = getPlexServer();
    return c.json(
      {
        connected: Boolean(server),
        server:
          server && c.var.user.role === "admin"
            ? {
                url: server.url,
                sendPlaylists: server.sendPlaylists,
                playlistError: plexPlaylistError(),
              }
            : null,
      },
      200,
    );
  })
  .post("/sign-in", requireAuth, requireUserAccount, async (c) => {
    try {
      return c.json(await startPlexSignIn(c.var.user.id), 200);
    } catch {
      return c.json({ error: "Couldn't reach Plex" }, 502);
    }
  })
  .post(
    "/sign-in/:id",
    requireAuth,
    requireUserAccount,
    validate("param", v.object({ id: v.string() })),
    validate("json", v.object({ serverUrl: v.optional(v.string()) })),
    async (c) => {
      const { serverUrl } = c.req.valid("json");
      if (serverUrl !== undefined && c.var.user.role !== "admin")
        return c.json({ error: "Only admins can connect the Plex server" }, 403);
      const url = serverUrl === undefined ? null : validateExternalUrl(serverUrl);
      if (url && !url.valid) return c.json({ error: url.error }, 400);
      try {
        const token = await finishPlexSignIn(c.var.user.id, c.req.valid("param").id);
        if (!token) return c.json({ done: false }, 200);
        await finishSignIn(c.var.user.id, token, url?.url);
        return c.json({ done: true }, 200);
      } catch (error) {
        if (error instanceof PlexError || error instanceof HistoryServerError)
          return c.json({ error: error.message }, 400);
        logger.warn("listening", "Plex sign-in failed", { message: asAppError(error)?.message });
        return c.json({ error: "Couldn't reach Plex" }, 502);
      }
    },
  )
  .patch(
    "/",
    requireAdmin,
    validate("json", v.object({ sendPlaylists: v.boolean() })),
    async (c) => {
      const server = getPlexServer();
      if (!server) return c.json({ error: "Plex isn't connected" }, 404);
      const { sendPlaylists } = c.req.valid("json");
      savePlexServer({ ...server, sendPlaylists });
      if (sendPlaylists) playlistManager.requestPlexUpload();
      else if (server.sendPlaylists) await playlistManager.removePlaylistsFromPlex();
      return c.body(null, 204);
    },
  )
  .delete("/", requireAdmin, async (c) => {
    if (getPlexServer()?.sendPlaylists) await playlistManager.removePlaylistsFromPlex();
    removePlexServer();
    forgetPlexHistoryServer();
    return c.body(null, 204);
  });
