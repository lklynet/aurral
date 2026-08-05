import { getData, patchData } from "../core.js";

export const getLibraryNews = (limit = 60) =>
  getData("/news", { params: { limit } });

export const updateNewsPreferences = (blockedPublishers) =>
  patchData("/news/preferences", { blockedPublishers });
