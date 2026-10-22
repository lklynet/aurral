import { buildImageProxyUrl } from "../../../services/imageProxyService.ts";
import {
  listenbrainzGetReleaseGroupDates,
  listenbrainzGetReleaseGroupListens,
} from "../../../services/apiClients/listenbrainz.ts";
import { getArtistTagLists, getSimilarArtists } from "../../../services/musicDataSource/index.ts";
import { isKnownGenre } from "../../../services/musicGenres.ts";

export function toLegacyRelations(metadataArtist) {
  return Array.isArray(metadataArtist?.links)
    ? metadataArtist.links
        .filter((link) => link?.target)
        .map((link) => ({
          type: link.type || "external",
          url: { resource: link.target },
        }))
    : [];
}

export async function getArtistTagPayload(mbid, artistName = "", metadataArtist = null) {
  const metadataGenres = Array.isArray(metadataArtist?.genres)
    ? metadataArtist.genres.filter(Boolean)
    : [];
  if (metadataGenres.length > 0) {
    return {
      tags: metadataGenres.map((genre) => ({ name: genre, count: 0 })),
      genres: metadataGenres,
    };
  }
  const [sourceTags] = await getArtistTagLists([{ mbid, name: artistName }]);
  const tags = sourceTags.filter((tag) => isKnownGenre(tag.name));
  return {
    tags,
    genres: tags.map((tag) => tag.name),
  };
}

export async function getSimilarArtistCards(
  mbid,
  { artistName = "", limit = 10, signal, resolveArtistName } = {},
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
const LISTENBRAINZ_DATE_LOOKUP_LIMIT = 300;

const settleWithin = (waitMs, lookups) => {
  let timer;
  const deadline = new Promise((resolve) => {
    timer = setTimeout(resolve, waitMs, new Map());
  });
  return Promise.all(lookups.map((lookup) => Promise.race([lookup, deadline]))).finally(() =>
    clearTimeout(timer),
  );
};

export async function withListenBrainzStats(releaseGroups) {
  if (!releaseGroups.length) return releaseGroups;
  const undatedIds = releaseGroups
    .filter((releaseGroup) => !releaseGroup["first-release-date"])
    .slice(0, LISTENBRAINZ_DATE_LOOKUP_LIMIT)
    .map(({ id }) => id);
  const [listens, dates] = await settleWithin(LISTENBRAINZ_WAIT_MS, [
    listenbrainzGetReleaseGroupListens(releaseGroups.map(({ id }) => id)),
    listenbrainzGetReleaseGroupDates(undatedIds),
  ]);
  return releaseGroups.map((releaseGroup) => ({
    ...releaseGroup,
    ...listens.get(releaseGroup.id),
    "first-release-date": releaseGroup["first-release-date"] || dates.get(releaseGroup.id) || null,
  }));
}

export function buildArtistBase(name, resolvedMbid, metadataArtist = null) {
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
    ...(metadataArtist?.overview ? { bio: metadataArtist.overview } : {}),
  };
}
