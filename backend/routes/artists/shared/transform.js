import { getLastfmApiKey, lastfmRequest } from "../../../services/apiClients/index.js";

const DEFAULT_LASTFM_IMAGE_HASH = "2a96cbd8b46e442fc41c2b86b821562f";

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

export async function getLastfmTags(mbid, artistName = "") {
  if (!getLastfmApiKey()) return [];
  let data = await lastfmRequest("artist.getTopTags", { mbid }).catch(() => null);
  if (!data?.toptags?.tag && artistName) {
    data = await lastfmRequest("artist.getTopTags", { artist: artistName }).catch(
      () => null,
    );
  }
  const tags = data?.toptags?.tag
    ? Array.isArray(data.toptags.tag)
      ? data.toptags.tag
      : [data.toptags.tag]
    : [];
  return tags
    .map((tag) => ({
      name: String(tag?.name || "").trim(),
      count: Number(tag?.count || 0),
    }))
    .filter((tag) => tag.name);
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
  const lastfmTags = await getLastfmTags(mbid, artistName);
  return {
    tags: lastfmTags,
    genres: lastfmTags.map((tag) => tag.name),
  };
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

export function extractLastfmImageUrl(images) {
  if (!Array.isArray(images)) return null;
  const img =
    images.find((i) => i.size === "extralarge") ||
    images.find((i) => i.size === "large") ||
    images.slice(-1)[0];
  if (img && img["#text"] && !img["#text"].includes(DEFAULT_LASTFM_IMAGE_HASH)) {
    return img["#text"];
  }
  return null;
}
