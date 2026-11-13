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

const ALBUM_COVER_KINDS = new Set(["front", "cover", "albumcover"]);
const ALBUM_PART_KINDS = new Set(["back", "booklet", "medium", "tray", "spine", "disc", "logo"]);

const imageKind = (image: ImageSource | null | undefined) =>
  String(image?.kind || image?.CoverType || "")
    .trim()
    .toLowerCase();

export const getArtistImageKindRank = (image: ImageSource | null | undefined) => {
  const kind = imageKind(image);
  return isOwnKey(ARTIST_IMAGE_KIND_RANK, kind) ? ARTIST_IMAGE_KIND_RANK[kind] : 5;
};

export const getImageUrl = (image: ImageSource | null | undefined) =>
  image?.url || image?.Url || null;

export const selectBestArtistImage = (images: ImageList = []) => {
  if (!Array.isArray(images)) return null;
  return (
    images
      .filter((image) => getImageUrl(image))
      .map((image, index) => ({ image, index }))
      .sort(
        (a, b) =>
          getArtistImageKindRank(a.image) - getArtistImageKindRank(b.image) || a.index - b.index,
      )[0]?.image || null
  );
};

export const selectAlbumCover = (images: ImageList = []) => {
  if (!Array.isArray(images)) return null;
  const covers = images.filter(
    (image) => getImageUrl(image) && !ALBUM_PART_KINDS.has(imageKind(image)),
  );
  return covers.find((image) => ALBUM_COVER_KINDS.has(imageKind(image))) ?? covers[0] ?? null;
};
