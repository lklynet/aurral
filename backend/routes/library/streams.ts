import { Hono } from "hono";
import { asAppError } from "../../../lib/errors.ts";
import { requireStreamAuth } from "../../middleware/guards.ts";
import { noCache } from "../../middleware/cacheHeaders.ts";
import type { AppEnv } from "../../middleware/requestUser.ts";
import { validate } from "../../middleware/validate.ts";
import { libraryManager } from "../../services/libraryManager.ts";
import { resolveLibraryTrackPath } from "../../services/libraryReadModel.ts";
import { streamQuery, streamSubsonicAudio } from "../../services/subsonicTranscodeService.ts";
import { sendViaNode } from "../shared/sendViaNode.ts";

const trackFileMissing = { error: "Track file missing" };

export default new Hono<AppEnv>()
  .basePath("/library")
  .get(
    "/stream/:albumId/:trackId",
    noCache,
    requireStreamAuth,
    validate("query", streamQuery),
    async (c) => {
      const filePath = resolveLibraryTrackPath(c.req.param("albumId"), c.req.param("trackId"));
      const sent =
        filePath && (await sendViaNode(c, streamSubsonicAudio, filePath, c.req.valid("query")));
      return sent || c.json(trackFileMissing, 404);
    },
  )
  .get(
    "/file-stream/:albumId/:trackId",
    noCache,
    requireStreamAuth,
    validate("query", streamQuery),
    async (c) => {
      const trackId = c.req.param("trackId");
      const tracks = await libraryManager.getTracks(c.req.param("albumId"));
      const track = tracks.find((item) => String(item.id) === trackId);
      const sent =
        track?.hasFile &&
        track.path &&
        (await sendViaNode(c, streamSubsonicAudio, track.path, c.req.valid("query")));
      return sent || c.json(trackFileMissing, 404);
    },
  )
  .onError((error, c) =>
    c.json({ error: "Stream failed", message: asAppError(error)?.message }, 500),
  );
