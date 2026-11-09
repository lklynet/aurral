import { Hono } from "hono";
import * as v from "valibot";
import { requireAuth } from "../middleware/guards.ts";
import type { AppEnv } from "../middleware/requestUser.ts";
import { validate } from "../middleware/validate.ts";
import { recordAlbumImportCompleted } from "../services/aurralHistoryService.ts";

const loose = <Schema extends v.GenericSchema>(schema: Schema) =>
  v.fallback(v.optional(schema), undefined);

const text = loose(v.string());
const lidarrEvent = v.fallback(
  v.looseObject({
    eventType: text,
    artist: loose(v.looseObject({ name: text, mbId: text })),
    album: loose(v.looseObject({ id: loose(v.number()), title: text })),
  }),
  {},
);

export default new Hono<AppEnv>()
  .basePath("/webhooks/lidarr")
  .post("/", requireAuth, validate("json", lidarrEvent), (c) => {
    const { eventType, artist, album } = c.req.valid("json");
    if (eventType?.trim().toLowerCase() !== "download") return c.body(null, 204);

    const entry = recordAlbumImportCompleted({
      albumId: album?.id,
      albumName: album?.title,
      artistName: artist?.name,
      artistMbid: artist?.mbId,
    });

    return c.json({ handled: Boolean(entry) }, 200);
  });
