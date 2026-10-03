import fs from "fs";

const BROAD_LASTFM_GENRES = ["alternative", "indie", "rap", "rnb"];

const genreKey = (value) =>
  String(value || "")
    .toLowerCase()
    .replace(/[\s_-]+/g, "");

const knownGenreKeys = new Set(
  [
    ...fs
      .readFileSync(new URL("./musicbrainzGenres.txt", import.meta.url), "utf8")
      .split("\n"),
    ...BROAD_LASTFM_GENRES,
  ]
    .map(genreKey)
    .filter(Boolean),
);

export const isKnownGenre = (value) => knownGenreKeys.has(genreKey(value));
