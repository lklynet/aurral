const IMAGE_TYPES = {
  avif: "image/avif",
  gif: "image/gif",
  jpeg: "image/jpeg",
  jpg: "image/jpeg",
  png: "image/png",
  svg: "image/svg+xml",
  webp: "image/webp",
};

export const MEDIA_SESSION_SEEK_SECONDS = 10;

export function mediaSessionArtwork(src, baseUrl) {
  if (!src) return [];
  let url;
  try {
    url = new URL(src, baseUrl);
  } catch {
    return [];
  }
  const path = url.pathname.toLowerCase();
  const type = IMAGE_TYPES[path.match(/\.([a-z0-9]+)$/)?.[1]];
  const dimensions = path.match(/(\d{2,4})x(\d{2,4})/);
  const coverArtSize = path.match(/\/front-(\d{2,4})$/)?.[1];
  const sizes = dimensions
    ? `${dimensions[1]}x${dimensions[2]}`
    : coverArtSize
      ? `${coverArtSize}x${coverArtSize}`
      : null;
  return [{ src: url.href, ...(sizes ? { sizes } : {}), ...(type ? { type } : {}) }];
}

export function mediaSessionPosition(duration, position) {
  if (!Number.isFinite(duration) || duration <= 0) return null;
  const safePosition = Number.isFinite(position) ? position : 0;
  return {
    duration,
    position: Math.min(Math.max(safePosition, 0), duration),
    playbackRate: 1,
  };
}
