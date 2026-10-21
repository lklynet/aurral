import { getData, postData } from "../core.ts";
import type {
  disableNewsFeed as disableNewsFeedSettings,
  getNewsForUser,
} from "../../../../../backend/services/newsService.ts";

export const getLibraryNews = (
  limit = 60,
  mode: "matched" | "top" = "matched",
  offset = 0,
  { signal }: { signal?: AbortSignal } = {},
): Promise<Awaited<ReturnType<typeof getNewsForUser>>> =>
  getData("/news", { params: { limit, mode, offset }, signal });

export const disableNewsFeed = (
  sourceUrl: string,
): Promise<ReturnType<typeof disableNewsFeedSettings>> =>
  postData("/news/feeds/disable", { sourceUrl });
