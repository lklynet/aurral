import { getData, postData } from "../core.js";

export const getLibraryNews = (limit = 60, mode = "matched", offset = 0, { signal } = {}) =>
  getData("/news", { params: { limit, mode, offset }, signal });

export const disableNewsFeed = (sourceUrl) =>
  postData("/news/feeds/disable", { sourceUrl });
