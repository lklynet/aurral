import { Hono } from "hono";
import { asAppError } from "../../../lib/errors.ts";
import { dbOps } from "../../db/helpers/index.ts";
import { requireStreamAuth } from "../../middleware/guards.ts";
import { noCache } from "../../middleware/noCache.ts";
import type { AppEnv } from "../../middleware/requestUser.ts";
import { sendAudioFile } from "../../services/audioFileStream.ts";
import { libraryManager } from "../../services/libraryManager.ts";
import { resolveLibraryTrackPath } from "../../services/libraryReadModel.ts";
import { isErrorStatus } from "../shared/errorStatus.ts";
import { sendViaNode } from "../shared/sendViaNode.ts";

const trackFileMissing = { error: "Track file missing" };

export default new Hono<AppEnv>()
  .basePath("/library")
  .use(noCache, requireStreamAuth)
  .get("/canonical-stream/:albumId/:trackId", async (c) => {
    const filePath = resolveLibraryTrackPath(c.req.param("albumId"), c.req.param("trackId"));
    const sent = filePath && (await sendViaNode(c, sendAudioFile, filePath));
    return sent || c.json(trackFileMissing, 404);
  })
  .get("/file-stream/:albumId/:trackId", async (c) => {
    const trackId = c.req.param("trackId");
    const tracks = await libraryManager.getTracks(c.req.param("albumId"));
    const track = tracks.find((item) => String(item.id) === trackId);
    const sent = track?.hasFile && track.path && (await sendViaNode(c, sendAudioFile, track.path));
    return sent || c.json(trackFileMissing, 404);
  })
  .get("/stream/:songId", async (c) => {
    const navidrome = dbOps.getSettings().integrations?.navidrome;
    if (!navidrome?.url || !navidrome.username || !navidrome.password) {
      return c.json({ error: "Navidrome not configured" }, 503);
    }
    const { NavidromeClient } = await import("../../services/navidrome.ts");
    const client = new NavidromeClient(navidrome.url, navidrome.username, navidrome.password);
    const timeout = new AbortController();
    const timer = setTimeout(() => timeout.abort(), 30000);
    const upstream = await fetch(client.getStreamUrl(c.req.param("songId")), {
      signal: AbortSignal.any([c.req.raw.signal, timeout.signal]),
    }).finally(() => clearTimeout(timer));
    if (!upstream.ok) {
      await upstream.body?.cancel();
      return c.json(
        { error: "Stream failed", message: `Request failed with status code ${upstream.status}` },
        isErrorStatus(upstream.status) ? upstream.status : 500,
      );
    }
    const headers = new Headers(
      ["content-type", "content-length"].flatMap((name) => {
        const value = upstream.headers.get(name);
        return value ? [[name, value]] : [];
      }),
    );
    if (c.req.method === "HEAD") {
      await upstream.body?.cancel();
      return c.newResponse(null, { headers });
    }
    return c.newResponse(upstream.body, { headers });
  })
  .onError((error, c) =>
    c.json({ error: "Stream failed", message: asAppError(error)?.message }, 500),
  );
