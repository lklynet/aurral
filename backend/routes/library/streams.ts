import { Hono } from "hono";
import { asAppError } from "../../../lib/errors.ts";
import { requireStreamAuth } from "../../middleware/guards.ts";
import { noCache } from "../../middleware/cacheHeaders.ts";
import type { AppEnv } from "../../middleware/requestUser.ts";
import { sendAudioFile } from "../../services/audioFileStream.ts";
import { libraryManager } from "../../services/libraryManager.ts";
import { resolveLibraryTrackPath } from "../../services/libraryReadModel.ts";
import { sendViaNode } from "../shared/sendViaNode.ts";

const trackFileMissing = { error: "Track file missing" };

export default new Hono<AppEnv>()
  .basePath("/library")
  .get("/canonical-stream/:albumId/:trackId", noCache, requireStreamAuth, async (c) => {
    const filePath = resolveLibraryTrackPath(c.req.param("albumId"), c.req.param("trackId"));
    const sent = filePath && (await sendViaNode(c, sendAudioFile, filePath));
    return sent || c.json(trackFileMissing, 404);
  })
  .get("/file-stream/:albumId/:trackId", noCache, requireStreamAuth, async (c) => {
    const trackId = c.req.param("trackId");
    const tracks = await libraryManager.getTracks(c.req.param("albumId"));
    const track = tracks.find((item) => String(item.id) === trackId);
    const sent = track?.hasFile && track.path && (await sendViaNode(c, sendAudioFile, track.path));
    return sent || c.json(trackFileMissing, 404);
  })
  .onError((error, c) =>
    c.json({ error: "Stream failed", message: asAppError(error)?.message }, 500),
  );
