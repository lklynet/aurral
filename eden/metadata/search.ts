import type { Catalogue, CatalogueAlbum, CatalogueArtist } from "../catalogue/catalogue.ts";

export const searchKey = (value: string | null | undefined) =>
  (value ?? "")
    .normalize("NFKD")
    .replace(/\p{Diacritic}/gu, "")
    .toLowerCase()
    .replace(/[‐-―]/g, "-")
    .replace(/[‘’]/g, "'")
    .replace(/\s+/g, " ")
    .trim();

function matchScore(candidate: string, query: string) {
  if (!candidate || !query) return 0;
  if (candidate === query) return 100;
  if (candidate.startsWith(query)) return 80;
  if (candidate.includes(query)) return 60;
  const words = query.split(" ");
  return words.every((word) => candidate.includes(word)) ? 40 : 0;
}

const votes = (entry: { rating?: { Count?: number | null } | null }) => entry.rating?.Count ?? 0;

function ranked<Entry extends { id: string; rating?: { Count?: number | null } | null }>(
  entries: Iterable<Entry>,
  score: (entry: Entry) => number,
  limit: number,
) {
  return [...entries]
    .map((entry) => ({ entry, score: score(entry) }))
    .filter((hit) => hit.score > 0)
    .toSorted(
      (left, right) =>
        right.score - left.score ||
        votes(right.entry) - votes(left.entry) ||
        left.entry.id.localeCompare(right.entry.id),
    )
    .slice(0, limit)
    .map((hit) => hit.entry);
}

export function searchArtists(catalogue: Catalogue, query: string, limit: number) {
  const key = searchKey(query);
  return ranked(
    catalogue.artists.values(),
    (artist) =>
      Math.max(
        matchScore(searchKey(artist.artistname), key),
        ...(artist.artistaliases ?? []).map((alias) => matchScore(searchKey(alias), key) - 5),
      ),
    limit,
  ).map(({ Albums: _albums, ...artist }): Omit<CatalogueArtist, "Albums"> => artist);
}

export function searchAlbums(
  catalogue: Catalogue,
  query: string,
  artistName: string,
  limit: number,
) {
  const key = searchKey(query);
  const artistKey = searchKey(artistName);
  const creditedTo = (album: CatalogueAlbum) =>
    (album.artists ?? []).some((artist) => searchKey(artist.artistname).includes(artistKey));
  return ranked(
    catalogue.albums.values(),
    (album) => (artistKey && !creditedTo(album) ? 0 : matchScore(searchKey(album.title), key)),
    limit,
  ).map((album): CatalogueAlbum => ({ ...album, releases: [] }));
}
