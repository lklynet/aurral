import { wrappedSeason } from "../../lib/wrapped.ts";
import { APP_VERSION } from "./constants.ts";

export const isWrappedEnabled = () => wrappedSeason(APP_VERSION) !== null;

export const API_CONTRACT = {
  version: 1,
  features: [
    "discover",
    "flows",
    "playlistCoverTemplates",
    "activity",
    "review",
    "trackDownloads",
    "linkSearch",
    "downloadCancel",
    "shareImports",
    "trending",
  ],
};
