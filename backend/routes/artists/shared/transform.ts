import { buildImageProxyUrl } from "../../../services/imageProxyService.ts";
import { listenbrainzGetReleaseGroupStats } from "../../../services/apiClients/listenbrainz.ts";
import { getArtistTagLists, getSimilarArtists } from "../../../services/musicDataSource/index.ts";
import { isKnownGenre } from "../../../services/musicGenres.ts";
import type { musicbrainzGetArtistReleaseGroups } from "../../../services/apiClients/index.ts";
import type { NormalizedArtist } from "../../../services/providers/brainzmashMappers.ts";

type ReleaseGroupSummary = Awaited<ReturnType<typeof musicbrainzGetArtistReleaseGroups>>[number];

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

export async function getArtistTagPayload(
  mbid: string,
  artistName = "",
  metadataArtist: NormalizedArtist | null = null,
) {
  const metadataGenres = Array.isArray(metadataArtist?.genres)
    ? metadataArtist.genres.filter(Boolean)
    : [];
  if (metadataGenres.length > 0) {
    return {
      tags: metadataGenres.map((genre) => ({ name: genre, count: 0 })),
      genres: metadataGenres,
    };
  }
  const [sourceTags = []]: { name: string; count: number }[][] = await getArtistTagLists([
    { mbid, name: artistName },
  ]);
  const tags = sourceTags.filter((tag) => isKnownGenre(tag.name));
  return {
    tags,
    genres: tags.map((tag) => tag.name),
  };
}

export async function getSimilarArtistCards(
  mbid: string,
  {
    artistName = "",
    limit = 10,
    signal,
    resolveArtistName,
  }: {
    artistName?: string;
    limit?: number;
    signal?: AbortSignal;
    resolveArtistName?: () => Promise<string | null>;
  } = {},
) {
  let artists = await getSimilarArtists({ mbid, name: artistName }, { limit, signal });
  if (artists.length === 0 && !artistName && resolveArtistName) {
    const name = await resolveArtistName().catch(() => null);
    if (name) artists = await getSimilarArtists({ name }, { limit, signal });
  }
  return artists
    .filter((artist) => artist.mbid)
    .map((artist) => ({
      id: artist.mbid,
      name: artist.name,
      image: buildImageProxyUrl(artist.image),
      match: Math.round(artist.match * 100),
    }));
}

const LISTENBRAINZ_WAIT_MS = 2000;

export async function withListenBrainzStats(releaseGroups: ReleaseGroupSummary[]) {
  const { records, pending } = await listenbrainzGetReleaseGroupStats(releaseGroups, {
    waitMs: LISTENBRAINZ_WAIT_MS,
  });
  return {
    pending,
    releaseGroups: releaseGroups.map((releaseGroup) => {
      const record = records.get(releaseGroup.id);
      return {
        ...releaseGroup,
        ...(record?.listen_count &&
          record.listener_count && {
            listenCount: record.listen_count,
            listenerCount: record.listener_count,
          }),
        "first-release-date":
          releaseGroup["first-release-date"] || record?.first_release_date || null,
      };
    }),
  };
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
