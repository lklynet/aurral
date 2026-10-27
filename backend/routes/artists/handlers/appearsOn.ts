import { Hono } from "hono";
import * as v from "valibot";
import { UUID_REGEX } from "../../../../lib/uuid.ts";
import {
  getMusicbrainzAppearsOnScanState,
  musicbrainzGetArtistAppearsOnReleaseGroups,
} from "../../../services/apiClients/index.ts";
import type { AppEnv } from "../../../middleware/requestUser.ts";
import { validate } from "../../../middleware/validate.ts";
import { asAppError } from "../../../../lib/errors.ts";

const clamped = (min: number, max: number, fallback: number) =>
  v.optional(
    v.pipe(
      v.number(),
      v.transform((value) => Math.min(max, Math.max(min, Math.trunc(value) || fallback))),
    ),
    fallback,
  );

const appearsOnBody = v.object({
  limit: clamped(1, 24, 24),
  offset: clamped(0, 250, 0),
  excludeIds: v.optional(v.array(v.string()), []),
});

export default new Hono<AppEnv>()
  .basePath("/artists")
  .post("/:mbid/appears-on", validate("json", appearsOnBody), async (c) => {
    const mbid = c.req.param("mbid");
    if (!UUID_REGEX.test(mbid)) {
      return c.json({ error: "Invalid MBID format" }, 400);
    }

    const { limit, offset, excludeIds } = c.req.valid("json");
    const excluded = new Set(excludeIds.map((id) => id.trim()).filter((id) => UUID_REGEX.test(id)));
    const { signal } = c.req.raw;

    try {
      let availableItems = await musicbrainzGetArtistAppearsOnReleaseGroups(mbid, {
        limit: 250,
        offset: 0,
        signal,
        scanPageBudget: 0,
      });
      let unseenItems = availableItems.filter((item) => !excluded.has(item.id));
      if (unseenItems.length < limit && !getMusicbrainzAppearsOnScanState(mbid).complete) {
        availableItems = await musicbrainzGetArtistAppearsOnReleaseGroups(mbid, {
          limit: 250,
          offset: 0,
          signal,
          scanPageBudget: 1,
        });
        unseenItems = availableItems.filter((item) => !excluded.has(item.id));
      }
      const items = unseenItems.slice(0, limit);
      return c.json(
        {
          items,
          offset,
          hasMore:
            unseenItems.length > items.length || !getMusicbrainzAppearsOnScanState(mbid).complete,
        },
        200,
      );
    } catch (error) {
      return c.json(
        { error: "Failed to load artist appearances", message: asAppError(error)?.message },
        502,
      );
    }
  });
