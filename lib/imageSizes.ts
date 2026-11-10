export type ImageSize = { url: string; width: number };

export const RESIZED_IMAGE_WIDTHS = [128, 256, 512] as const;

export const resizedImageWidth = (requested: number) =>
  requested > 0 ? (RESIZED_IMAGE_WIDTHS.find((width) => width >= requested) ?? null) : null;

const FANART = /^(https?:\/\/assets\.fanart\.tv)\/fanart\//i;
const FANART_SQUARE =
  /^https?:\/\/assets\.fanart\.tv\/fanart\/music\/[^/?#]+\/(?:albumcover|artistthumb)\//i;
const DEEZER =
  /^(https?:\/\/[\w-]+\.dzcdn\.net\/images\/[a-z]+\/[0-9a-f]+\/)\d+x\d+(-[^/?#]*\.(?:jpg|png))$/i;
const DEEZER_WIDTHS = [120, 250, 500, 1000];
const AURRAL_COVER =
  /\/api\/(?:playlists\/artwork\/[^/?#]+|discover\/playlists\/[^/?#]+\/[^/?#]+\/cover)(?:\?|$)/;
const AURRAL_COVER_WIDTH = 1000;

export function imageSizes(url: string): ImageSize[] {
  if (FANART.test(url)) {
    return [
      { url: url.replace(FANART, "$1/preview/"), width: 200 },
      { url: url.replace(FANART, "$1/bigpreview/"), width: 400 },
      ...(FANART_SQUARE.test(url) ? [{ url, width: 1000 }] : []),
    ];
  }
  const deezer = url.match(DEEZER);
  if (deezer) {
    return DEEZER_WIDTHS.map((width) => ({
      url: `${deezer[1]}${width}x${width}${deezer[2]}`,
      width,
    }));
  }
  if (AURRAL_COVER.test(url)) {
    return [
      ...RESIZED_IMAGE_WIDTHS.map((width) => ({
        url: `${url}${url.includes("?") ? "&" : "?"}w=${width}`,
        width,
      })),
      { url, width: AURRAL_COVER_WIDTH },
    ];
  }
  return [];
}
