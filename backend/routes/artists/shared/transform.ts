import { buildImageProxyUrl } from "../../../services/imageProxyService.ts";
import { getSimilarArtists } from "../../../services/musicDataSource/index.ts";
import { guessArtistMbid } from "../../../services/artistMatch.ts";
import { mapWithConcurrency } from "../../../services/discovery/helpers.ts";
import type {
  NormalizedAppearsOnAlbum,
  NormalizedArtist,
  NormalizedArtistAlbum,
} from "../../../services/providers/metadataMappers.ts";

export function toArtistReleaseGroup(
  album: NormalizedArtistAlbum,
  artist: Pick<NormalizedArtist, "id" | "name">,
) {
  return {
    id: album.id,
    title: album.title || "",
    "first-release-date": album.firstReleaseDate || null,
    "primary-type": album.type || "Album",
    "secondary-types": Array.isArray(album.secondaryTypes) ? album.secondaryTypes : [],
    rating: album.rating || null,
    listenerCount: album.listeners > 0 ? album.listeners : null,
    coverUrl: buildImageProxyUrl(album.cover),
    "artist-credit": artist.name
      ? [
          {
            name: artist.name,
            artist: artist.id ? { id: artist.id, name: artist.name } : { name: artist.name },
          },
        ]
      : [],
  };
}

export type AppearsOnReleaseGroup = {
  id: string;
  title: string;
  "first-release-date": string | null;
  "primary-type": string;
  "secondary-types": string[];
  rating: { count: number; value: number } | null;
  listenerCount?: number | null;
  coverUrl?: string | null;
  "artist-credit": { name?: string; artist?: { id?: string; name?: string } }[];
  releases: { id: string; status: string | null; date: string | null; title: string }[];
};

export function toAppearsOnReleaseGroup(album: NormalizedAppearsOnAlbum): AppearsOnReleaseGroup {
  const artistName = album.artistName || "";
  return {
    id: album.id,
    title: album.title || "Untitled release",
    "first-release-date": album.firstReleaseDate || null,
    "primary-type": album.type || "Album",
    "secondary-types": Array.isArray(album.secondaryTypes) ? album.secondaryTypes : [],
    rating: album.rating || null,
    listenerCount: album.listeners > 0 ? album.listeners : null,
    coverUrl: buildImageProxyUrl(album.cover),
    "artist-credit": artistName
      ? [
          {
            name: artistName,
            artist: album.artistId
              ? { id: album.artistId, name: artistName }
              : { name: artistName },
          },
        ]
      : [],
    releases: [],
  };
}

export function toLegacyRelations(metadataArtist: NormalizedArtist | null) {
  return Array.isArray(metadataArtist?.links)
    ? metadataArtist.links
        .filter((link): link is NonNullable<typeof link> => Boolean(link?.target))
        .map((link) => ({
          type: link.type || "external",
          url: { resource: link.target },
        }))
    : [];
}

export function getArtistTagPayload(metadataArtist: NormalizedArtist | null = null) {
  const genres = Array.isArray(metadataArtist?.genres) ? metadataArtist.genres.filter(Boolean) : [];
  return {
    tags: genres.map((genre) => ({ name: genre, count: 0 })),
    genres,
  };
}

export async function getSimilarArtistCards(
  mbid: string,
  {
    artistName = "",
    limit = 10,
    resolveArtistName,
  }: {
    artistName?: string;
    limit?: number;
    resolveArtistName?: () => Promise<string | null>;
  } = {},
) {
  let artists = await getSimilarArtists({ mbid, name: artistName }, { limit });
  if (artists.length === 0 && !artistName && resolveArtistName) {
    const name = await resolveArtistName().catch(() => null);
    if (name) artists = await getSimilarArtists({ name }, { limit });
  }
  const cards = await mapWithConcurrency(artists.slice(0, limit), 4, async (artist) => ({
    id: artist.mbid || (await guessArtistMbid(artist.name)),
    name: artist.name,
    image: buildImageProxyUrl(artist.image),
    match: Math.round(artist.match * 100),
  }));
  return cards.filter((card) => card.id);
}

export function buildArtistBase(
  name: string,
  resolvedMbid: string,
  metadataArtist: NormalizedArtist | null = null,
) {
  return {
    id: resolvedMbid,
    name: metadataArtist?.name || name,
    "sort-name": metadataArtist?.sortName || metadataArtist?.name || name,
    disambiguation: metadataArtist?.disambiguation || "",
    "type-id": null,
    type: metadataArtist?.type || null,
    country: null,
    "life-span": { begin: null, end: null, ended: false },
    genres: Array.isArray(metadataArtist?.genres) ? metadataArtist.genres : [],
    links: Array.isArray(metadataArtist?.links) ? metadataArtist.links : [],
    relations: toLegacyRelations(metadataArtist),
    rating: metadataArtist?.rating || null,
    ...(metadataArtist?.overview && { bio: metadataArtist.overview }),
  };
}
