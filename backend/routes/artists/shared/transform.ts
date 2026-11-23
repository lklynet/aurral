import { buildImageProxyUrl } from "../../../services/imageProxyService.ts";
import { deezerPreviewSearchPath } from "../../../../lib/deezerPreview.ts";
import { getSimilarArtists } from "../../../services/musicDataSource/index.ts";
import { guessArtistMbid } from "../../../services/artistMatch.ts";
import { mapWithConcurrency } from "../../../services/discovery/helpers.ts";
import { releaseGroupCoverImageUrl } from "../../../services/releaseGroupCoverService.ts";
import {
  similarScoreToMatch,
  type NormalizedAppearsOnAlbum,
  type NormalizedArtist,
  type NormalizedArtistAlbum,
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

export const listedReleaseGroup = ({
  title,
  "artist-credit": credits,
}: Pick<AppearsOnReleaseGroup, "title" | "artist-credit">) => ({
  artistName: credits[0]?.name ?? "",
  albumTitle: title,
});

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
  { artistName = "", limit = 10 }: { artistName?: string; limit?: number } = {},
) {
  const artists = await getSimilarArtists({ mbid, name: artistName }, { limit });
  const cards = await mapWithConcurrency(artists.slice(0, limit), 4, async (artist) => ({
    id: artist.mbid || (await guessArtistMbid(artist.name)),
    name: artist.name,
    image: buildImageProxyUrl(artist.image),
    match: Math.round(artist.match * 100),
  }));
  return cards.filter((card) => card.id);
}

export function toDirectSimilarArtists(metadataArtist: NormalizedArtist | null, limit = 30) {
  return (metadataArtist?.similar ?? [])
    .filter((entry) => Boolean(entry.id))
    .slice(0, limit)
    .map((entry) => ({
      id: entry.id,
      name: entry.name,
      image: buildImageProxyUrl(entry.image),
      match: Math.round(similarScoreToMatch(entry.score) * 100),
    }));
}

export function toArtistTopTracks(
  metadataArtist: NormalizedArtist | null,
  fallbackArtistName = "",
  limit = 20,
) {
  if (!metadataArtist?.topTracks.length) return [];
  const artistName = metadataArtist.name || fallbackArtistName;
  const albumsById = new Map(metadataArtist.albums.map((album) => [album.id, album]));
  return metadataArtist.topTracks.slice(0, limit).flatMap((track) => {
    const title = track.title.trim();
    if (!title) return [];
    const album = track.albumId ? albumsById.get(track.albumId) : undefined;
    return [
      {
        id: track.recordingId || `${metadataArtist.id}:${title}`,
        title,
        duration_ms: track.durationMs ?? null,
        album: album?.title || null,
        albumMbid: track.albumId || null,
        trackMbid: track.recordingId || null,
        artworkUrl:
          buildImageProxyUrl(album?.cover) ||
          (track.albumId ? releaseGroupCoverImageUrl(track.albumId) : null),
        preview_url: artistName ? deezerPreviewSearchPath(artistName, title) : null,
      },
    ];
  });
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
    listeners: metadataArtist?.listeners || null,
    ...(metadataArtist?.overview && { bio: metadataArtist.overview }),
  };
}
