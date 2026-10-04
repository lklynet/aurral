import { buildImageProxyUrl } from "../../../services/imageProxyService.js";
import {
  getArtistTagLists,
  getSimilarArtists,
} from "../../../services/musicDataSource/index.js";
import { isKnownGenre } from "../../../services/musicGenres.js";

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
