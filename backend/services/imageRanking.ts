import { isOwnKey } from "../../lib/ownKey.ts";

export type ImageSource = {
  kind?: string | null;
  url?: string | null;
  CoverType?: string | null;
  Url?: string | null;
};
export type ImageList = (ImageSource | null | undefined)[] | null | undefined;

const ARTIST_IMAGE_KIND_RANK = {
  poster: 0,
  artist: 1,
  thumb: 2,
  fanart: 3,
  background: 4,
  banner: 8,
  logo: 9,
  clearlogo: 9,
};

const ALBUM_IMAGE_KIND_RANK = {
  front: 0,
  cover: 0,
  albumcover: 0,
  back: 4,
  booklet: 5,
  medium: 6,
  tray: 6,
  spine: 7,
  disc: 8,
  logo: 9,
};

export const getArtistImageKindRank = (image: ImageSource | null | undefined) => {
  const kind = String(image?.kind || image?.CoverType || "")
    .trim()
    .toLowerCase();
  return isOwnKey(ARTIST_IMAGE_KIND_RANK, kind) ? ARTIST_IMAGE_KIND_RANK[kind] : 5;
};

const getAlbumImageKindRank = (image: ImageSource | null | undefined) => {
  const kind = String(image?.kind || image?.CoverType || "")
    .trim()
    .toLowerCase();
  return isOwnKey(ALBUM_IMAGE_KIND_RANK, kind) ? ALBUM_IMAGE_KIND_RANK[kind] : 3;
};

export const getImageUrl = (image: ImageSource | null | undefined) =>
  image?.url || image?.Url || null;

const selectBestImageByKind = (
  images: ImageList = [],
  getKindRank: (image: ImageSource | null | undefined) => number,
) => {
  if (!Array.isArray(images)) return null;
  return (
    images
      .filter((image) => getImageUrl(image))
      .map((image, index) => ({ image, index }))
      .sort((a, b) => {
        const rankDiff = getKindRank(a.image) - getKindRank(b.image);
        if (rankDiff !== 0) return rankDiff;
        return a.index - b.index;
      })[0]?.image || null
  );
};

export const selectBestArtistImage = (images: ImageList = []) => {
  return selectBestImageByKind(images, getArtistImageKindRank);
};

export const selectBestAlbumImage = (images: ImageList = []) => {
  return selectBestImageByKind(images, getAlbumImageKindRank);
};
