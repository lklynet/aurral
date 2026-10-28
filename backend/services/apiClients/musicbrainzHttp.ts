import axios from "../../../lib/axiosFetch.ts";
import { asAppError } from "../../../lib/errors.ts";
import { APP_NAME, APP_VERSION, MUSICBRAINZ_API } from "../../config/constants.ts";
import { dbOps } from "../../db/helpers/index.ts";
import createRateLimiter from "./rateLimiter.ts";

const MUSICBRAINZ_BUSY_BACKOFF_MS = 2000;
const musicbrainzLimiter = createRateLimiter(1000);

const userAgent = () => {
  const contact =
    dbOps.getSettings().integrations?.musicbrainz?.email?.trim() ||
    process.env.CONTACT_EMAIL?.trim() ||
    "https://github.com/lklynet/aurral";
  return `${APP_NAME}/${APP_VERSION} ( ${contact} )`;
};

const request = <T>(
  path: string,
  params: Record<string, string | number>,
  signal: AbortSignal | undefined,
) =>
  musicbrainzLimiter.schedule(
    async (): Promise<T> => {
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

export async function musicbrainzGet<T>(
  path: string,
  params: Record<string, string | number>,
  { signal }: { signal?: AbortSignal } = {},
) {
  try {
    return await request<T>(path, params, signal);
  } catch (error) {
    if (asAppError(error)?.response?.status !== 503) throw error;
    musicbrainzLimiter.pauseFor(MUSICBRAINZ_BUSY_BACKOFF_MS);
    return request<T>(path, params, signal);
  }
}
