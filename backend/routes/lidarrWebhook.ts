import { Hono } from "hono";
import * as v from "valibot";
import { requireAuth } from "../middleware/guards.ts";
import type { AppEnv } from "../middleware/requestUser.ts";
import { validate } from "../middleware/validate.ts";
import { recordAlbumImportCompleted } from "../services/aurralHistoryService.ts";

const loose = <Schema extends v.GenericSchema>(schema: Schema) =>
  v.fallback(v.optional(schema), undefined);

const id = loose(v.union([v.string(), v.number()]));
const text = loose(v.string());
const artist = loose(
  v.object({
    artistName: text,
    ArtistName: text,
    foreignArtistId: text,
    ForeignArtistId: text,
  }),
);
const album = loose(v.object({ id, Id: id, title: text, Title: text, artist, Artist: artist }));
const lidarrEvent = v.fallback(v.object({ eventType: id, EventType: id, album, Album: album }), {});

export default new Hono<AppEnv>()
  .basePath("/webhooks/lidarr")
  .post("/", requireAuth, validate("json", lidarrEvent), (c) => {
    const event = c.req.valid("json");
    const eventType = String(event.eventType || event.EventType || "")
      .trim()
      .toLowerCase();
    if (eventType !== "download") return c.body(null, 204);

    const { artist, Artist, ...albumRef } = event.album || event.Album || {};
    const artistRef = artist || Artist || {};
    const entry = recordAlbumImportCompleted({
      albumId: albumRef.id ?? albumRef.Id,
      albumName: albumRef.title ?? albumRef.Title,
      artistName: artistRef.artistName ?? artistRef.ArtistName,
      artistMbid: artistRef.foreignArtistId ?? artistRef.ForeignArtistId,
    });

    return c.json({ handled: Boolean(entry) }, 200);
  });
