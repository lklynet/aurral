import crypto from "crypto";
import fs from "fs";
import path from "path";
import axios from "axios";
import sharp from "sharp";
import { resolveAurralDataDir } from "../config/data-dir.js";

const IMAGE_PROXY_ROUTE = "/api/image-proxy";
const DATA_DIR = resolveAurralDataDir();
const IMAGE_PROXY_DIR = path.join(DATA_DIR, "image-proxy");
const CACHE_TTL_MS = 30 * 24 * 60 * 60 * 1000;
const FETCH_TIMEOUT_MS = 25000;
const OPTIMIZED_IMAGE_MAX_BYTES = 1024 * 1024;
const DEFAULT_WEBP_QUALITY = 70;
const FALLBACK_WEBP_QUALITIES = [70, 60, 50, 40];
const FALLBACK_MAX_DIMENSIONS = [null, 1600, 1400, 1200, 1000, 800];
const inflightRequests = new Map();
const cacheEntriesByKey = new Map();
const cacheKeysBySourceUrl = new Map();
let cacheIndexInitialized = false;

const PRIVATE_HOST_PATTERNS = [
  /^localhost$/i,
  /^127\./,
  /^10\./,
  /^192\.168\./,
  /^169\.254\./,
  /^::1$/i,
  /^0:0:0:0:0:0:0:1$/i,
];

const PRIVATE_172_RANGE = /^172\.(1[6-9]|2\d|3[0-1])\./;
const MIME_EXTENSION_MAP = {
  "image/jpeg": "jpg",
  "image/png": "png",
  "image/webp": "webp",
  "image/gif": "gif",
  "image/avif": "avif",
  "image/svg+xml": "svg",
};
const OPTIMIZABLE_CONTENT_TYPES = new Set([
  "image/jpeg",
  "image/png",
  "image/webp",
  "image/avif",
]);

const ensureCacheDir = () => {
  fs.mkdirSync(IMAGE_PROXY_DIR, { recursive: true });
};

const initializeCacheIndex = () => {
  if (cacheIndexInitialized) return;
  ensureCacheDir();
  cacheIndexInitialized = true;

  const files = fs.readdirSync(IMAGE_PROXY_DIR);
  for (const file of files) {
    const match = file.match(/^([a-f0-9]{64})\.json$/i);
    if (!match) continue;
    const cacheKey = match[1].toLowerCase();
    const metaPath = path.join(IMAGE_PROXY_DIR, file);
    let meta = null;
    try {
      meta = JSON.parse(fs.readFileSync(metaPath, "utf8"));
    } catch {
      continue;
    }
    if (!meta?.extension) continue;
    const imagePath = path.join(
      IMAGE_PROXY_DIR,
      `${cacheKey}.${meta.extension}`,
    );
    if (!fs.existsSync(imagePath)) continue;
    const sourceUrl = normalizeKnownImageUrl(meta.sourceUrl);
    const entry = {
      cacheKey,
      meta,
      imagePath,
      localUrl: buildLocalImageUrl(cacheKey, meta.extension),
      isFresh:
        Number(meta.fetchedAt || 0) > 0 &&
        Date.now() - Number(meta.fetchedAt || 0) < CACHE_TTL_MS,
    };
    cacheEntriesByKey.set(cacheKey, entry);
    if (sourceUrl) {
      cacheKeysBySourceUrl.set(sourceUrl, cacheKey);
    }
  }
};

export const clearImageProxyCache = () => {
  ensureCacheDir();

  for (const file of fs.readdirSync(IMAGE_PROXY_DIR)) {
    try {
      fs.unlinkSync(path.join(IMAGE_PROXY_DIR, file));
    } catch {}
  }

  cacheEntriesByKey.clear();
  cacheKeysBySourceUrl.clear();
  inflightRequests.clear();
  cacheIndexInitialized = false;
};

export const getImageProxyCacheSizeBytes = () => {
  ensureCacheDir();

  let total = 0;
  for (const file of fs.readdirSync(IMAGE_PROXY_DIR)) {
    try {
      const stat = fs.statSync(path.join(IMAGE_PROXY_DIR, file));
      if (stat.isFile()) {
        total += stat.size;
      }
    } catch {}
  }
  return total;
};

const isPrivateHostname = (hostname) => {
  const normalized = String(hostname || "")
    .trim()
    .toLowerCase();
  if (!normalized) return true;
  if (normalized.endsWith(".local")) return true;
  if (PRIVATE_172_RANGE.test(normalized)) return true;
  return PRIVATE_HOST_PATTERNS.some((pattern) => pattern.test(normalized));
};

const hashValue = (value) =>
  crypto.createHash("sha256").update(String(value)).digest("hex");

const normalizeKnownImageUrl = (value) =>
  String(value || "")
    .trim()
    .replace(
      /^(https?:\/\/(?:caa\.lkly\.net|coverartarchive\.org)\/release-group\/[0-9a-f-]+)\/front-250(?=[/?#]|$)/i,
      "$1/front",
    )
    .replace(
      /^(https?:\/\/(?:[\w-]+\.)?ca\.archive\.org\/.*?)-thumb250(\.[a-z0-9]+)(?=[?#]|$)/i,
      "$1$2",
    )
    .replace(
      /^(https?:\/\/archive\.org\/download\/[^?#]+?)_thumb250(\.[a-z0-9]+)(?=[?#]|$)/i,
      "$1$2",
    );

const getCachePaths = (cacheKey) => ({
  metaPath: path.join(IMAGE_PROXY_DIR, `${cacheKey}.json`),
  baseImagePath: path.join(IMAGE_PROXY_DIR, `${cacheKey}`),
});

const removeStaleCachedFiles = (cacheKey, keepExtension) => {
  ensureCacheDir();
  const prefix = `${cacheKey}.`;
  for (const file of fs.readdirSync(IMAGE_PROXY_DIR)) {
    if (!file.startsWith(prefix) || file.endsWith(".json")) continue;
    if (keepExtension && file === `${cacheKey}.${keepExtension}`) continue;
    try {
      fs.unlinkSync(path.join(IMAGE_PROXY_DIR, file));
    } catch {}
  }
};

const buildLocalImageUrl = (cacheKey, extension) =>
  `${IMAGE_PROXY_ROUTE}/${cacheKey}.${extension}`;

const getCacheKeyFromLocalUrl = (value) => {
  const normalized = String(value || "").trim();
  const match = normalized.match(
    /\/api\/image-proxy\/([a-f0-9]{64})(?:\.[a-z0-9]+)?$/i,
  );
  return match?.[1]?.toLowerCase() || null;
};

const readCacheMetadata = (metaPath) => {
  try {
    return JSON.parse(fs.readFileSync(metaPath, "utf8"));
  } catch {
    return null;
  }
};

const getCachedEntryFromKey = (cacheKey) => {
  if (!cacheKey) return null;
  initializeCacheIndex();
  const entry = cacheEntriesByKey.get(cacheKey);
  if (!entry) return null;
  return {
    ...entry,
    isFresh:
      Number(entry.meta?.fetchedAt || 0) > 0 &&
      Date.now() - Number(entry.meta?.fetchedAt || 0) < CACHE_TTL_MS,
  };
};

const getCachedEntry = (sourceUrl) => {
  const normalizedSourceUrl = normalizeKnownImageUrl(sourceUrl);
  if (!normalizedSourceUrl) return null;
  initializeCacheIndex();
  const cacheKey =
    cacheKeysBySourceUrl.get(normalizedSourceUrl) ||
    hashValue(normalizedSourceUrl);
  return getCachedEntryFromKey(cacheKey);
};

const writeCacheEntry = (cacheKey, buffer, contentType, sourceUrl) => {
  ensureCacheDir();
  const extension = MIME_EXTENSION_MAP[contentType] || "img";
  const { metaPath, baseImagePath } = getCachePaths(cacheKey);
  const imagePath = `${baseImagePath}.${extension}`;
  const fetchedAt = Date.now();
  const meta = {
    sourceUrl,
    contentType,
    extension,
    fetchedAt,
    size: buffer.length,
  };

  removeStaleCachedFiles(cacheKey, extension);
  fs.writeFileSync(imagePath, buffer);
  fs.writeFileSync(metaPath, JSON.stringify(meta));
  const entry = {
    cacheKey,
    meta,
    imagePath,
    localUrl: buildLocalImageUrl(cacheKey, extension),
    isFresh: true,
  };
  cacheEntriesByKey.set(cacheKey, entry);
  if (sourceUrl) {
    cacheKeysBySourceUrl.set(sourceUrl, cacheKey);
  }
  return entry;
};

const shouldNormalizeCachedEntry = (entry) => {
  if (!entry?.imagePath || !entry?.meta?.contentType) return false;
  if (!OPTIMIZABLE_CONTENT_TYPES.has(entry.meta.contentType)) return false;
  return (
    entry.meta.contentType !== "image/webp" ||
    Number(entry.meta.size || 0) > OPTIMIZED_IMAGE_MAX_BYTES
  );
};

const optimizeImageBuffer = async (buffer, contentType) => {
  if (!OPTIMIZABLE_CONTENT_TYPES.has(contentType)) {
    return {
      buffer,
      contentType,
    };
  }

  let metadata = null;
  try {
    metadata = await sharp(buffer, { animated: false }).metadata();
  } catch {
    return {
      buffer,
      contentType,
    };
  }

  const largestDimension = Math.max(
    metadata?.width || 0,
    metadata?.height || 0,
  );
  const dimensionSteps = FALLBACK_MAX_DIMENSIONS.filter(
    (dimension) => dimension === null || largestDimension > dimension,
  );
  if (dimensionSteps.length === 0) {
    dimensionSteps.push(null);
  }

  let bestCandidate = null;

  for (const maxDimension of dimensionSteps) {
    for (const quality of FALLBACK_WEBP_QUALITIES) {
      let candidate = sharp(buffer, { animated: false }).rotate();
      if (maxDimension) {
        candidate = candidate.resize({
          width: maxDimension,
          height: maxDimension,
          fit: "inside",
          withoutEnlargement: true,
        });
      }

      const optimizedBuffer = await candidate
        .webp({
          quality,
          effort: 4,
        })
        .toBuffer();

      if (
        !bestCandidate ||
        optimizedBuffer.length < bestCandidate.buffer.length
      ) {
        bestCandidate = {
          buffer: optimizedBuffer,
          contentType: "image/webp",
        };
      }

      if (
        quality === DEFAULT_WEBP_QUALITY &&
        optimizedBuffer.length <= OPTIMIZED_IMAGE_MAX_BYTES
      ) {
        return {
          buffer: optimizedBuffer,
          contentType: "image/webp",
        };
      }

      if (optimizedBuffer.length <= OPTIMIZED_IMAGE_MAX_BYTES) {
        return {
          buffer: optimizedBuffer,
          contentType: "image/webp",
        };
      }
    }
  }

  return bestCandidate || { buffer, contentType };
};

const normalizeCachedEntryIfNeeded = async (entry) => {
  if (!shouldNormalizeCachedEntry(entry)) {
    return entry;
  }

  let buffer = null;
  try {
    buffer = fs.readFileSync(entry.imagePath);
  } catch {
    return entry;
  }

  const optimized = await optimizeImageBuffer(buffer, entry.meta.contentType);
  if (
    optimized.contentType === entry.meta.contentType &&
    optimized.buffer.length === buffer.length
  ) {
    return entry;
  }

  return writeCacheEntry(
    entry.cacheKey,
    optimized.buffer,
    optimized.contentType,
    normalizeKnownImageUrl(entry.meta.sourceUrl) ||
      entry.meta.sourceUrl ||
      null,
  );
};

const fetchAndCacheImage = async (sourceUrl) => {
  const normalizedSourceUrl = normalizeKnownImageUrl(sourceUrl);
  if (!normalizedSourceUrl) {
    throw new Error("Missing source image URL");
  }

  const parsed = new URL(normalizedSourceUrl);
  if (!["http:", "https:"].includes(parsed.protocol)) {
    throw new Error("Unsupported image protocol");
  }
  if (isPrivateHostname(parsed.hostname)) {
    throw new Error("Refusing to cache private host");
  }

  const response = await axios.get(normalizedSourceUrl, {
    responseType: "arraybuffer",
    timeout: FETCH_TIMEOUT_MS,
    maxRedirects: 10,
    headers: {
      Accept:
        "image/avif,image/webp,image/apng,image/svg+xml,image/*,*/*;q=0.8",
      "User-Agent": "Aurral Local Image Cache",
    },
  });

  const contentType = String(response.headers["content-type"] || "")
    .split(";")[0]
    .trim()
    .toLowerCase();
  if (!contentType.startsWith("image/")) {
    throw new Error("Upstream response is not an image");
  }

  const optimized = await optimizeImageBuffer(
    Buffer.from(response.data),
    contentType,
  );

  return writeCacheEntry(
    hashValue(normalizedSourceUrl),
    optimized.buffer,
    optimized.contentType,
    normalizedSourceUrl,
  );
};

export const warmImageProxy = async (sourceUrl) => {
  const cacheKeyFromLocalUrl = getCacheKeyFromLocalUrl(sourceUrl);
  if (cacheKeyFromLocalUrl) {
    const cachedLocal = getCachedEntryFromKey(cacheKeyFromLocalUrl);
    if (cachedLocal?.imagePath) {
      return normalizeCachedEntryIfNeeded(cachedLocal);
    }
    throw new Error("Missing local cached image");
  }

  const normalizedSourceUrl = normalizeKnownImageUrl(sourceUrl);
  if (!normalizedSourceUrl) {
    throw new Error("Missing source image URL");
  }

  const cached = getCachedEntry(normalizedSourceUrl);
  if (cached?.isFresh) {
    return normalizeCachedEntryIfNeeded(cached);
  }

  if (inflightRequests.has(normalizedSourceUrl)) {
    return inflightRequests.get(normalizedSourceUrl);
  }

  const request = fetchAndCacheImage(normalizedSourceUrl).finally(() => {
    inflightRequests.delete(normalizedSourceUrl);
  });
  inflightRequests.set(normalizedSourceUrl, request);
  return request;
};

export const buildImageProxyUrl = (sourceUrl) => {
  const normalized = normalizeKnownImageUrl(sourceUrl);
  if (!normalized) return null;
  if (
    normalized.startsWith("/") ||
    normalized.startsWith("data:") ||
    normalized.startsWith("blob:")
  ) {
    return normalized;
  }

  try {
    const parsed = new URL(normalized);
    if (!["http:", "https:"].includes(parsed.protocol)) {
      return normalized;
    }
  } catch {
    return normalized;
  }

  const cached = getCachedEntry(normalized);
  if (cached?.localUrl) return cached.localUrl;
  return `${IMAGE_PROXY_ROUTE}?src=${encodeURIComponent(normalized)}`;
};

export const handleImageProxyRequest = async (req, res) => {
  const rawKey = String(req.params.cacheKey || "").trim();
  const match = rawKey.match(/^([a-f0-9]{64})(?:\.([a-z0-9]+))?$/i);
  if (!match) {
    return res.status(404).json({ error: "Image not found" });
  }

  const cacheKey = match[1].toLowerCase();
  const cached = getCachedEntryFromKey(cacheKey);
  if (!cached?.imagePath) {
    return res.status(404).json({ error: "Image not found" });
  }

  res.set("Content-Type", cached.meta.contentType || "image/jpeg");
  res.set(
    "Cache-Control",
    "public, max-age=86400, stale-while-revalidate=604800",
  );
  return res.sendFile(cached.imagePath);
};

export const handleLegacyImageProxyRequest = async (req, res) => {
  const rawSourceUrl =
    typeof req.query.src === "string" ? req.query.src.trim() : "";
  if (!rawSourceUrl) {
    return res.status(404).json({ error: "Image not found" });
  }

  try {
    const cached = await warmImageProxy(rawSourceUrl);
    if (!cached?.localUrl) {
      return res.status(404).json({ error: "Image not found" });
    }
    return res.redirect(302, cached.localUrl);
  } catch {
    return res.status(404).json({ error: "Image not found" });
  }
};
