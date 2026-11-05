import { foldDiacritics } from "./providers/brainzmashRanking.ts";

export function searchWords(value: unknown) {
  return foldDiacritics(String(value ?? "").normalize("NFKD"))
    .toLowerCase()
    .replace(/&/g, " and ")
    .replace(/['’`]/g, "")
    .split(/[^\p{L}\p{N}]+/u)
    .filter(Boolean);
}

export const searchKey = (value: unknown) => searchWords(value).join("");

export function searchDocument(...values: unknown[]) {
  const keys = values
    .flatMap((value) => String(value ?? "").split("\u001f"))
    .map(searchKey)
    .filter(Boolean);
  return [...new Set(keys)].join(" ");
}

export type SearchQuery = { key: string; bare: string; words: string[]; terms: string[] };

// Short words join their neighbours so "ac dc" searches for "acdc" and "as
// long as you" for "aslongas you". Keys drop spaces, so a term still matches
// wherever the words sit next to each other.
export function parseSearchQuery(value: unknown): SearchQuery | null {
  const words = searchWords(value);
  if (!words.length) return null;
  const terms: string[] = [];
  let pending = "";
  for (const word of words) {
    if (word.length >= 3) {
      terms.push(pending + word);
      pending = "";
    } else if (terms.length) {
      terms[terms.length - 1] += word;
    } else {
      pending += word;
    }
  }
  if (pending) terms.push(pending);
  const key = words.join("");
  return { key, bare: withoutArticle(words), words, terms };
}

function withoutArticle(words: string[]) {
  return (words[0] === "the" && words.length > 1 ? words.slice(1) : words).join("");
}

export const MATCH = { none: 0, words: 1, prefix: 2, exact: 3 } as const;
export type MatchQuality = (typeof MATCH)[keyof typeof MATCH];

export function matchQuality(query: SearchQuery, text: unknown): MatchQuality {
  const words = searchWords(text);
  if (!words.length) return MATCH.none;
  const key = words.join("");
  const bare = withoutArticle(words);
  if (key === query.key || bare === query.bare || key === query.bare || bare === query.key) {
    return MATCH.exact;
  }
  if (key.startsWith(query.key) || bare.startsWith(query.key)) return MATCH.prefix;
  if (query.terms.every((term) => key.includes(term))) return MATCH.words;
  const coversQuery = key.length * 5 >= query.key.length * 2;
  if (coversQuery && words.every((word) => query.words.includes(word))) return MATCH.words;
  return MATCH.none;
}

export function bestMatch(query: SearchQuery, ...texts: unknown[]): MatchQuality {
  let best: MatchQuality = MATCH.none;
  for (const text of texts) {
    const quality = matchQuality(query, text);
    if (quality > best) best = quality;
  }
  return best;
}

export function rankByMatch<T>(
  query: SearchQuery | null,
  items: T[],
  texts: (item: T) => unknown[],
) {
  if (!query) return items;
  return items
    .map((item, index) => ({ item, index, quality: bestMatch(query, ...texts(item)) }))
    .sort((left, right) => right.quality - left.quality || left.index - right.index)
    .map(({ item }) => item);
}

export const albumSearchTexts = (album: { title?: unknown; artistName?: unknown }) => [
  album.title,
  `${album.artistName ?? ""} ${album.title ?? ""}`,
  `${album.title ?? ""} ${album.artistName ?? ""}`,
];
