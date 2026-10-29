import fs from "fs";

const BROAD_LASTFM_GENRES = ["alternative", "indie", "rap", "rnb"];

export const genreKey = (value: unknown) =>
  String(value || "")
    .toLowerCase()
    .replace(/[\s_-]+/g, "");

const musicbrainzGenres = fs
  .readFileSync(new URL("./musicbrainzGenres.txt", import.meta.url), "utf8")
  .split("\n")
  .map((genre) => genre.trim())
  .filter(Boolean);

const knownGenreKeys = new Set(
  [...musicbrainzGenres, ...BROAD_LASTFM_GENRES].map(genreKey).filter(Boolean),
);

export const isKnownGenre = (value: string | null | undefined) =>
  knownGenreKeys.has(genreKey(value));

export const listMusicbrainzGenres = () => musicbrainzGenres;
