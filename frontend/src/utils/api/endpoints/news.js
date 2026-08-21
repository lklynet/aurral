import { getData, patchData, postData } from "../core.js";

export const getLibraryNews = (limit = 60, mode = "matched", offset = 0, { signal } = {}) =>
  getData("/news", { params: { limit, mode, offset }, signal });

export const updateNewsPreferences = (blockedPublishers) =>
  patchData("/news/preferences", { blockedPublishers });

export const disableNewsFeed = (sourceUrl, sourceName) =>
  postData("/news/feeds/disable", { sourceUrl, sourceName });
