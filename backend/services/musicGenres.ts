import fs from "fs";
import { genreKey } from "../../lib/genreKey.ts";

const BROAD_TAG_GENRES = ["alternative", "indie", "rap", "rnb"];

const musicbrainzGenres = fs
  .readFileSync(new URL("./musicbrainzGenres.txt", import.meta.url), "utf8")
  .split("\n")
  .map((genre) => genre.trim())
  .filter(Boolean);

const knownGenreKeys = new Set(
  [...musicbrainzGenres, ...BROAD_TAG_GENRES].map(genreKey).filter(Boolean),
);

export const isKnownGenre = (value: string | null | undefined) =>
  knownGenreKeys.has(genreKey(value));

export const listMusicbrainzGenres = () => musicbrainzGenres;
