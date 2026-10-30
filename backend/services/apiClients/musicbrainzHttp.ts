import * as v from "valibot";
import axios from "../../../lib/axiosFetch.ts";
import { asAppError } from "../../../lib/errors.ts";
import { APP_NAME, APP_VERSION, MUSICBRAINZ_API } from "../../config/constants.ts";
import { dbOps } from "../../db/helpers/index.ts";
import { readOne } from "../integrationData.ts";
import createRateLimiter from "./rateLimiter.ts";

const MUSICBRAINZ_BUSY_BACKOFF_MS = 2000;
const musicbrainzLimiter = createRateLimiter(1000);

export const releaseGroupSchema = v.looseObject({
  id: v.string(),
  title: v.optional(v.string()),
  "primary-type": v.nullish(v.string()),
  "secondary-types": v.optional(v.array(v.string())),
  "first-release-date": v.optional(v.string()),
  "artist-credit": v.optional(
    v.array(
      v.looseObject({
        name: v.optional(v.string()),
        artist: v.optional(
          v.looseObject({ id: v.optional(v.string()), name: v.optional(v.string()) }),
        ),
      }),
    ),
  ),
});

const userAgent = () => {
  const contact =
    dbOps.getSettings().integrations?.musicbrainz?.email?.trim() ||
    process.env.CONTACT_EMAIL?.trim() ||
    "https://github.com/lklynet/aurral";
  return `${APP_NAME}/${APP_VERSION} ( ${contact} )`;
};

const request = (
  path: string,
  params: Record<string, string | number>,
  signal: AbortSignal | undefined,
) =>
  musicbrainzLimiter.schedule(
    async (): Promise<unknown> => {
      signal?.throwIfAborted();
      const response = await axios.get(`${MUSICBRAINZ_API}${path}`, {
        params: { fmt: "json", ...params },
        headers: { "User-Agent": userAgent() },
        timeout: 8000,
        signal,
      });
      return response.data;
    },
    { signal },
  );

export async function musicbrainzGet<Schema extends v.GenericSchema>(
  schema: Schema,
  path: string,
  params: Record<string, string | number>,
  { signal }: { signal?: AbortSignal } = {},
) {
  const data = await request(path, params, signal).catch((error: unknown) => {
    if (asAppError(error)?.response?.status !== 503) throw error;
    musicbrainzLimiter.pauseFor(MUSICBRAINZ_BUSY_BACKOFF_MS);
    return request(path, params, signal);
  });
  return readOne(schema, data, { service: "MusicBrainz", endpoint: path });
}
