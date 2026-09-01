const IMAGE_PROXY_LOCAL_PATTERN =
  /^\/api\/image-proxy\/([a-f0-9]{64})(?:\.[a-z0-9]+)?$/i;
const IMAGE_PROXY_BARE_PATTERN = /^([a-f0-9]{64})\.[a-z0-9]+$/i;

export function normalizeMediaUrl(value) {
  const src = String(value || "").trim();
  if (!src) return src;
  if (IMAGE_PROXY_LOCAL_PATTERN.test(src)) return src;
  const bareMatch = src.match(IMAGE_PROXY_BARE_PATTERN);
  if (bareMatch?.[1]) {
    return `/api/image-proxy/${bareMatch[1]}${src.slice(bareMatch[1].length)}`;
  }
  return src;
}

export function withImageCacheBust(value) {
  const src = normalizeMediaUrl(value);
  if (!src) return src;
  const hashIndex = src.indexOf("#");
  const base = hashIndex === -1 ? src : src.slice(0, hashIndex);
  const hash = hashIndex === -1 ? "" : src.slice(hashIndex);
  return `${base}${base.includes("?") ? "&" : "?"}aurral_image_retry=${Date.now()}${hash}`;
}
