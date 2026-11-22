import { selectAlbumCover, selectBestArtistImage } from "../../backend/services/imageRanking.ts";
import {
  toV1Images,
  type Catalogue,
  type CatalogueAlbum,
  type CatalogueArtist,
  shownListeners,
} from "../catalogue/catalogue.ts";

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

export function searchV1Artists(catalogue: Catalogue, query: string, limit: number) {
  const key = searchKey(query);
  return ranked(
    catalogue.artists.values(),
    (artist) =>
      Math.max(
        matchScore(searchKey(artist.artistname), key),
        ...(artist.artistaliases ?? []).map((alias) => matchScore(searchKey(alias), key) - 5),
      ),
    limit,
  ).map((artist) => ({
    id: artist.id,
    name: artist.artistname,
    sortName: artist.sortname ?? artist.artistname,
    type: artist.type ?? null,
    disambiguation: artist.disambiguation ?? "",
    genres: artist.genres ?? [],
    aliases: artist.artistaliases ?? [],
    image: selectBestArtistImage(toV1Images(artist.images))?.url ?? null,
    listeners: shownListeners(artist.rating),
  }));
}

export function searchV1Albums(
  catalogue: Catalogue,
  query: string,
  artistName: string,
  limit: number,
) {
  return searchAlbums(catalogue, query, artistName, limit).map((album) => {
    const credited =
      (album.artists ?? []).find((artist) => artist.id === album.artistid) ?? album.artists?.[0];
    const owner = album.artistid ? catalogue.artists.get(album.artistid) : undefined;
    return {
      id: album.id,
      title: album.title,
      artistId: album.artistid ?? credited?.id ?? null,
      artistName: credited?.artistname ?? owner?.artistname ?? "",
      type: album.type ?? "Album",
      secondaryTypes: album.secondarytypes ?? [],
      releaseDate: album.releasedate ?? null,
      cover: selectAlbumCover(toV1Images(album.images))?.url ?? null,
      listeners: shownListeners(album.rating),
    };
  });
}

export function searchV1Tracks(catalogue: Catalogue, query: string, artist: string, limit: number) {
  const key = searchKey(query);
  const artistKey = searchKey(artist);
  if (!key) return [];
  const hits: {
    score: number;
    listeners: number;
    track: {
      recordingId: string;
      title: string;
      artistId: string | null;
      artistName: string;
      albumId: string;
      albumTitle: string;
      cover: string | null;
      durationMs: number | null;
      listeners: number;
    };
  }[] = [];
  const seen = new Set<string>();
  for (const album of catalogue.albums.values()) {
    const owner = album.artistid ? catalogue.artists.get(album.artistid) : undefined;
    const artistName = album.artists?.[0]?.artistname ?? owner?.artistname ?? "";
    const artistId = album.artistid ?? album.artists?.[0]?.id ?? null;
    if (artistKey && !searchKey(artistName).includes(artistKey)) continue;
    const cover = selectAlbumCover(toV1Images(album.images))?.url ?? null;
    const listeners = (album.rating?.Count ?? 0) * 300;
    for (const track of album.releases?.[0]?.tracks ?? []) {
      const recordingId = track.recordingid ?? track.id ?? "";
      const title = track.trackname ?? "";
      if (!recordingId || !title || seen.has(recordingId)) continue;
      const score = Math.max(
        matchScore(searchKey(title), key),
        matchScore(searchKey(`${artistName} ${title}`), key) - 5,
      );
      if (score <= 0) continue;
      seen.add(recordingId);
      hits.push({
        score,
        listeners,
        track: {
          recordingId,
          title,
          artistId: track.artistid ?? artistId,
          artistName,
          albumId: album.id,
          albumTitle: album.title,
          cover,
          durationMs: track.durationms ?? null,
          listeners,
        },
      });
    }
  }
  return hits
    .toSorted(
      (left, right) =>
        right.score - left.score ||
        right.listeners - left.listeners ||
        left.track.recordingId.localeCompare(right.track.recordingId),
    )
    .slice(0, limit)
    .map((hit) => hit.track);
}
