import { Hono } from "hono";
import * as v from "valibot";
import { UUID_REGEX } from "../../../../lib/uuid.ts";
import { getArtistByMbid } from "../../../services/providers/metadataProvider.ts";
import { listedReleaseGroup, toAppearsOnReleaseGroup } from "../shared/transform.ts";
import type { AppEnv } from "../../../middleware/requestUser.ts";
import { validate } from "../../../middleware/validate.ts";
import { asAppError } from "../../../../lib/errors.ts";
import { withCoverUrls } from "../../../services/releaseGroupCoverService.ts";
import { dbOps } from "../../../db/helpers/index.ts";

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
    const routeMbid = c.req.param("mbid");
    if (!UUID_REGEX.test(routeMbid)) {
      return c.json({ error: "Invalid MBID format" }, 400);
    }
    const mbid = dbOps.getArtistOverride(routeMbid)?.musicbrainzId || routeMbid;

    const { limit, offset, excludeIds } = c.req.valid("json");
    const excluded = new Set(excludeIds.map((id) => id.trim()).filter((id) => UUID_REGEX.test(id)));
    const { signal } = c.req.raw;

    try {
      const metadataArtist = await getArtistByMbid(mbid, { signal }).catch(() => null);
      const unseen = (metadataArtist?.appearsOn ?? [])
        .filter((item) => !excluded.has(item.id))
        .map(toAppearsOnReleaseGroup);
      const items = withCoverUrls(unseen.slice(0, limit), listedReleaseGroup);
      return c.json(
        {
          items,
          offset,
          hasMore: unseen.length > items.length,
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
