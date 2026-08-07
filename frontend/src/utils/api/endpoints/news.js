import { getData, patchData, postData } from "../core.js";

export const getLibraryNews = (limit = 60, mode = "matched", offset = 0) =>
  getData("/news", { params: { limit, mode, offset } });

export const updateNewsPreferences = (blockedPublishers) =>
  patchData("/news/preferences", { blockedPublishers });

export const disableNewsFeed = (sourceUrl, sourceName) =>
  postData("/news/feeds/disable", { sourceUrl, sourceName });
