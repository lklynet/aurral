import crypto from "crypto";
import dns from "node:dns";
import fs from "fs";
import net from "node:net";
import path from "path";
import { Agent, fetch as undiciFetch } from "undici";
import sharp from "./sharpConfig.js";
import { resolveAurralDataDir } from "../config/data-dir.js";

const IMAGE_PROXY_ROUTE = "/api/image-proxy";
const DATA_DIR = resolveAurralDataDir();
const IMAGE_PROXY_DIR = path.join(DATA_DIR, "image-proxy");
const IMAGE_CACHE_MIGRATION_MARKER = path.join(DATA_DIR, ".image-cache-links-v1");
const CACHE_TTL_MS = 30 * 24 * 60 * 60 * 1000;
const FETCH_TIMEOUT_MS = 25000;
const MAX_REDIRECTS = 5;
const MAX_SOURCE_IMAGE_BYTES = 25 * 1024 * 1024;
const MAX_SOURCE_IMAGE_PIXELS = 40_000_000;
const IMAGE_PROFILES = {
  library: { maxPx: 512, maxBytes: 150 * 1024, quality: 70 },
};
// ponytail: FIFO by mtime, touch on serve for LRU; raise/env only if disk pressure complains
const IMAGE_PROXY_MAX_BYTES = (() => {
  const parsed = Number(process.env.AURRAL_IMAGE_PROXY_MAX_BYTES);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : 256 * 1024 * 1024;
})();
const inflightRequests = new Map();
const cacheEntriesByKey = new Map();
const cacheKeysBySourceUrl = new Map();
let cacheIndexInitialized = false;
let indexBuildPromise = null;

const blockedAddresses = new net.BlockList();
for (const [address, prefix] of [
  ["0.0.0.0", 8],
  ["10.0.0.0", 8],
  ["100.64.0.0", 10],
  ["127.0.0.0", 8],
  ["169.254.0.0", 16],
  ["172.16.0.0", 12],
  ["192.0.0.0", 24],
  ["192.0.2.0", 24],
  ["192.168.0.0", 16],
  ["198.18.0.0", 15],
  ["198.51.100.0", 24],
  ["203.0.113.0", 24],
  ["224.0.0.0", 4],
  ["240.0.0.0", 4],
]) {
  blockedAddresses.addSubnet(address, prefix, "ipv4");
}
for (const [address, prefix] of [
  ["::", 128],
  ["::1", 128],
  ["64:ff9b:1::", 48],
  ["100::", 64],
  ["2001::", 32],
  ["2001:db8::", 32],
  ["2002::", 16],
  ["fc00::", 7],
  ["fe80::", 10],
  ["fec0::", 10],
  ["ff00::", 8],
]) {
  blockedAddresses.addSubnet(address, prefix, "ipv6");
}

const MIME_EXTENSION_MAP = {
  "image/jpeg": "jpg",
  "image/png": "png",
  "image/apng": "png",
  "image/webp": "webp",
  "image/gif": "gif",
  "image/avif": "avif",
  "image/svg+xml": "svg",
};
const IMAGE_FORMATS_BY_CONTENT_TYPE = {
  "image/jpeg": new Set(["jpeg"]),
  "image/png": new Set(["png"]),
  "image/apng": new Set(["png"]),
  "image/webp": new Set(["webp"]),
  "image/gif": new Set(["gif"]),
  "image/avif": new Set(["heif"]),
  "image/svg+xml": new Set(["svg"]),
};
const OPTIMIZABLE_CONTENT_TYPES = new Set([
  "image/jpeg",
  "image/png",
  "image/webp",
  "image/avif",
  "image/svg+xml",
]);

export const isPrivateAddress = (address) => {
  const normalized = String(address || "").split("%")[0];
  const family = net.isIP(normalized);
  if (family === 0) return true;
  if (family === 6) {
    const canonical = net.SocketAddress.parse(`[${normalized}]:0`)?.address;
    if (!canonical || canonical.startsWith("::ffff:")) return true;
  }
  return blockedAddresses.check(normalized, family === 4 ? "ipv4" : "ipv6");
};

const safeLookup = (hostname, options, callback) => {
  dns.lookup(hostname, { ...options, all: true }, (error, addresses) => {
    if (error) return callback(error);
    const publicAddresses = addresses.filter(({ address }) => !isPrivateAddress(address));
    if (publicAddresses.length === 0) {
      const lookupError = new Error("Refusing to connect to a private host");
      lookupError.code = "EHOSTUNREACH";
      return callback(lookupError);
    }
    if (options?.all) return callback(null, publicAddresses);
    return callback(null, publicAddresses[0].address, publicAddresses[0].family);
  });
};

const imageProxyDispatcher = new Agent({
  connections: 8,
  autoSelectFamily: true,
  keepAliveTimeout: 30_000,
  keepAliveMaxTimeout: 60_000,
  maxResponseSize: MAX_SOURCE_IMAGE_BYTES,
  connect: { lookup: safeLookup },
});
const usesNativeFetch = () => Function.prototype.toString.call(globalThis.fetch).includes("internal/deps/undici");

const ensureCacheDir = () => fs.promises.mkdir(IMAGE_PROXY_DIR, { recursive: true });

const initializeCacheIndex = () => {
  if (cacheIndexInitialized) return;
  cacheIndexInitialized = true;
  indexBuildPromise = (async () => {
    try {
      await ensureCacheDir();
      await migrateObsoleteImageCache();
      const files = (await fs.promises.readdir(IMAGE_PROXY_DIR)).filter((file) =>
        /^[a-f0-9]{64}\.json$/i.test(file),
      );
      for (let offset = 0; offset < files.length; offset += 64) {
        await Promise.all(
          files.slice(offset, offset + 64).map(async (file) => {
            const match = file.match(/^([a-f0-9]{64})\.json$/i);
            if (!match) return;
            const cacheKey = match[1].toLowerCase();
            const metaPath = path.join(IMAGE_PROXY_DIR, file);
            let meta = null;
            try {
              meta = JSON.parse(await fs.promises.readFile(metaPath, "utf8"));
            } catch {
              return;
            }
            if (!meta?.extension) return;
            const imagePath = path.join(IMAGE_PROXY_DIR, `${cacheKey}.${meta.extension}`);
            try {
              await fs.promises.access(imagePath);
            } catch {
              return;
            }
            const sourceUrl = normalizeKnownImageUrl(meta.sourceUrl);
            const profile = normalizeImageProfile(meta.profile);
            cacheEntriesByKey.set(cacheKey, {
              cacheKey,
              meta: { ...meta, profile },
              imagePath,
              localUrl: buildLocalImageUrl(cacheKey, meta.extension),
              isFresh:
                Number(meta.fetchedAt || 0) > 0 &&
                Date.now() - Number(meta.fetchedAt || 0) < CACHE_TTL_MS,
            });
            if (sourceUrl) {
              cacheKeysBySourceUrl.set(buildSourceMapKey(sourceUrl, profile), cacheKey);
            }
          }),
        );
      }
      await pruneImageProxyCacheToLimit();
    } catch {}
  })();
};

export const clearImageProxyCache = async () => {
  await migrateObsoleteImageCache();
  if (indexBuildPromise) await indexBuildPromise;
  await Promise.allSettled([...inflightRequests.values()]);
  await fs.promises.rm(IMAGE_PROXY_DIR, { recursive: true, force: true });
  await ensureCacheDir();

  cacheEntriesByKey.clear();
  cacheKeysBySourceUrl.clear();
  inflightRequests.clear();
  cacheIndexInitialized = false;
  indexBuildPromise = null;
};

export const getImageProxyCacheSizeBytes = async () => {
  let total = 0;
  try {
    await migrateObsoleteImageCache();
    await ensureCacheDir();
    const dir = await fs.promises.opendir(IMAGE_PROXY_DIR);
    for await (const entry of dir) {
      if (entry.isFile() && !entry.name.endsWith(".json")) {
        total += (await fs.promises.stat(path.join(IMAGE_PROXY_DIR, entry.name))).size;
      }
    }
  } catch {}
  return total;
};

const removeCacheEntryFromDisk = async (cacheKey, extension, sourceUrl, profile = "library") => {
  const normalizedKey = String(cacheKey || "").toLowerCase();
  if (!normalizedKey) return;
  const { metaPath, baseImagePath } = getCachePaths(normalizedKey);
  const imagePath = extension ? `${baseImagePath}.${extension}` : null;
  await Promise.allSettled([
    imagePath ? fs.promises.unlink(imagePath) : Promise.resolve(),
    fs.promises.unlink(metaPath),
    removeStaleCachedFiles(normalizedKey, null),
  ]);
  cacheEntriesByKey.delete(normalizedKey);
  const normalizedSource = normalizeKnownImageUrl(sourceUrl);
  if (normalizedSource) {
    cacheKeysBySourceUrl.delete(buildSourceMapKey(normalizedSource, profile));
  }
};

const pruneImageProxyCacheToLimit = async () => {
  let entries = [];
  try {
    await ensureCacheDir();
    const dir = await fs.promises.opendir(IMAGE_PROXY_DIR);
    for await (const file of dir) {
      if (!file.isFile() || !/^[a-f0-9]{64}\.json$/i.test(file.name)) continue;
      const cacheKey = file.name.slice(0, 64).toLowerCase();
      const metaPath = path.join(IMAGE_PROXY_DIR, file.name);
      let meta = null;
      try {
        meta = JSON.parse(await fs.promises.readFile(metaPath, "utf8"));
      } catch {
        continue;
      }
      const extension = meta?.extension || "webp";
      const imagePath = path.join(IMAGE_PROXY_DIR, `${cacheKey}.${extension}`);
      let imageStat = null;
      let metaStat = null;
      try {
        imageStat = await fs.promises.stat(imagePath);
        metaStat = await fs.promises.stat(metaPath);
      } catch {
        continue;
      }
      entries.push({
        cacheKey,
        extension,
        sourceUrl: meta?.sourceUrl || null,
        profile: normalizeImageProfile(meta?.profile),
        mtimeMs: Math.max(Number(imageStat.mtimeMs) || 0, Number(metaStat.mtimeMs) || 0),
        bytes: Number(imageStat.size || 0) + Number(metaStat.size || 0),
      });
    }
  } catch {
    return;
  }

  const evictableEntries = entries;
  let total = evictableEntries.reduce((sum, entry) => sum + entry.bytes, 0);
  if (total <= IMAGE_PROXY_MAX_BYTES) return;

  evictableEntries.sort(
    (a, b) => a.mtimeMs - b.mtimeMs || a.cacheKey.localeCompare(b.cacheKey),
  );
  for (const entry of evictableEntries) {
    if (total <= IMAGE_PROXY_MAX_BYTES) break;
    await removeCacheEntryFromDisk(
      entry.cacheKey,
      entry.extension,
      entry.sourceUrl,
      entry.profile,
    );
    total -= entry.bytes;
  }
};

const touchCacheEntry = (imagePath) => {
  if (!imagePath) return;
  const now = new Date();
  fs.promises.utimes(imagePath, now, now).catch(() => {});
};

export const isPrivateHostname = (hostname) => {
  let normalized = String(hostname || "")
    .trim()
    .toLowerCase();
  if (normalized.startsWith("[") && normalized.endsWith("]")) {
    normalized = normalized.slice(1, -1);
  }
  if (!normalized) return true;
  if (
    normalized === "localhost" ||
    normalized.endsWith(".localhost") ||
    normalized.endsWith(".local") ||
    normalized.endsWith(".home.arpa")
  ) {
    return true;
  }
  return net.isIP(normalized) ? isPrivateAddress(normalized) : false;
};

const hashValue = (value) => crypto.createHash("sha256").update(String(value)).digest("hex");

const normalizeImageProfile = () => "library";

const buildSourceMapKey = (sourceUrl, profile = "library") =>
  `${normalizeImageProfile(profile)}:${sourceUrl}`;

const buildImageCacheKey = (sourceUrl, profile = "library") =>
  hashValue(`${normalizeImageProfile(profile)}:${sourceUrl}`);

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

const removeStaleCachedFiles = (cacheKey, keepExtension) =>
  Promise.allSettled(
    [...new Set([...Object.values(MIME_EXTENSION_MAP), "img"])]
      .filter((extension) => extension !== keepExtension)
      .map((extension) =>
        fs.promises.unlink(path.join(IMAGE_PROXY_DIR, `${cacheKey}.${extension}`)),
      ),
  );

let obsoleteImageCacheMigrationComplete = false;

const migrateObsoleteImageCache = () => {
  if (obsoleteImageCacheMigrationComplete) return;
  if (fs.existsSync(IMAGE_CACHE_MIGRATION_MARKER)) {
    obsoleteImageCacheMigrationComplete = true;
    return;
  }

  try {
    fs.mkdirSync(IMAGE_PROXY_DIR, { recursive: true });
    const files = fs.readdirSync(IMAGE_PROXY_DIR);
    for (const file of files.filter((entry) => /^[a-f0-9]{64}\.json$/i.test(entry))) {
      const cacheKey = file.slice(0, 64).toLowerCase();
      const metaPath = path.join(IMAGE_PROXY_DIR, file);
      const meta = _readCacheMetadata(metaPath);
      if (!meta) {
        try {
          fs.unlinkSync(metaPath);
        } catch {}
      }
      if (meta?.profile === "library") continue;
      for (const extension of [...new Set([...Object.values(MIME_EXTENSION_MAP), "img"])]) {
        try {
          fs.unlinkSync(path.join(IMAGE_PROXY_DIR, `${cacheKey}.${extension}`));
        } catch {}
      }
    }
    fs.writeFileSync(IMAGE_CACHE_MIGRATION_MARKER, "1\n", { flag: "wx" });
    obsoleteImageCacheMigrationComplete = true;
  } catch (error) {
    if (error?.code === "EEXIST") obsoleteImageCacheMigrationComplete = true;
  }
};

const buildLocalImageUrl = (cacheKey, extension) => `${IMAGE_PROXY_ROUTE}/${cacheKey}.${extension}`;

const awaitCacheIndexReady = async () => {
  initializeCacheIndex();
  if (indexBuildPromise) {
    await indexBuildPromise;
  }
};

const readCacheEntryFromDisk = (cacheKey) => {
  if (!cacheKey) return null;
  const existing = cacheEntriesByKey.get(cacheKey);
  if (existing?.imagePath && fs.existsSync(existing.imagePath)) {
    return existing;
  }
  const metaPath = path.join(IMAGE_PROXY_DIR, `${cacheKey}.json`);
  const meta = _readCacheMetadata(metaPath);
  if (!meta?.extension) return null;
  const imagePath = path.join(IMAGE_PROXY_DIR, `${cacheKey}.${meta.extension}`);
  if (!fs.existsSync(imagePath)) return null;
  const sourceUrl = normalizeKnownImageUrl(meta.sourceUrl);
  const profile = normalizeImageProfile(meta.profile);
  const entry = {
    cacheKey,
    meta: { ...meta, profile },
    imagePath,
    localUrl: buildLocalImageUrl(cacheKey, meta.extension),
    isFresh:
      Number(meta.fetchedAt || 0) > 0 &&
      Date.now() - Number(meta.fetchedAt || 0) < CACHE_TTL_MS,
  };
  cacheEntriesByKey.set(cacheKey, entry);
  if (sourceUrl) {
    cacheKeysBySourceUrl.set(buildSourceMapKey(sourceUrl, profile), cacheKey);
  }
  return entry;
};

const getCacheKeyFromLocalUrl = (value) => {
  const normalized = String(value || "").trim();
  const proxyMatch = normalized.match(/\/api\/image-proxy\/([a-f0-9]{64})(?:\.[a-z0-9]+)?$/i);
  if (proxyMatch?.[1]) return proxyMatch[1].toLowerCase();
  const bareMatch = normalized.match(/^([a-f0-9]{64})\.[a-z0-9]+$/i);
  return bareMatch?.[1]?.toLowerCase() || null;
};

export const isImageProxyLocalUrl = (value) =>
  getCacheKeyFromLocalUrl(value) != null;

export const resolveImageProxyLocalUrl = (value) => {
  const cacheKey = getCacheKeyFromLocalUrl(value);
  if (!cacheKey) return null;
  const entry = readCacheEntryFromDisk(cacheKey);
  return entry?.localUrl || null;
};

const _readCacheMetadata = (metaPath) => {
  try {
    return JSON.parse(fs.readFileSync(metaPath, "utf8"));
  } catch {
    return null;
  }
};

const getCachedEntryFromKey = (cacheKey) => {
  if (!cacheKey) return null;
  initializeCacheIndex();
  const entry = cacheEntriesByKey.get(cacheKey) || readCacheEntryFromDisk(cacheKey);
  if (!entry) return null;
  return {
    ...entry,
    isFresh:
      Number(entry.meta?.fetchedAt || 0) > 0 &&
      Date.now() - Number(entry.meta?.fetchedAt || 0) < CACHE_TTL_MS,
  };
};

const getCachedEntry = (sourceUrl, imageProfile = "library") => {
  const normalizedSourceUrl = normalizeKnownImageUrl(sourceUrl);
  if (!normalizedSourceUrl) return null;
  const profile = normalizeImageProfile(imageProfile);
  initializeCacheIndex();
  const cacheKey =
    cacheKeysBySourceUrl.get(buildSourceMapKey(normalizedSourceUrl, profile)) ||
    buildImageCacheKey(normalizedSourceUrl, profile);
  return getCachedEntryFromKey(cacheKey);
};

const writeCacheEntry = async (
  cacheKey,
  buffer,
  contentType,
  sourceUrl,
  imageProfile = "library",
) => {
  await ensureCacheDir();
  const profile = normalizeImageProfile(imageProfile);
  const normalizedSourceUrl = normalizeKnownImageUrl(sourceUrl) || sourceUrl;
  const extension = MIME_EXTENSION_MAP[contentType] || "img";
  const { metaPath, baseImagePath } = getCachePaths(cacheKey);
  const imagePath = `${baseImagePath}.${extension}`;
  const fetchedAt = Date.now();
  const meta = {
    sourceUrl: normalizedSourceUrl,
    contentType,
    extension,
    fetchedAt,
    size: buffer.length,
    profile,
  };

  await removeStaleCachedFiles(cacheKey, extension);
  await fs.promises.writeFile(imagePath, buffer);
  await fs.promises.writeFile(metaPath, JSON.stringify(meta));
  const entry = {
    cacheKey,
    meta,
    imagePath,
    localUrl: buildLocalImageUrl(cacheKey, extension),
    isFresh: true,
  };
  cacheEntriesByKey.set(cacheKey, entry);
  if (normalizedSourceUrl) {
    cacheKeysBySourceUrl.set(
      buildSourceMapKey(normalizedSourceUrl, profile),
      cacheKey,
    );
  }
  await pruneImageProxyCacheToLimit();
  return entry;
};

const shouldNormalizeCachedEntry = (entry) => {
  if (!entry?.imagePath || !entry?.meta?.contentType) return false;
  if (!OPTIMIZABLE_CONTENT_TYPES.has(entry.meta.contentType)) return false;
  const profile = IMAGE_PROFILES[normalizeImageProfile(entry.meta.profile)];
  return entry.meta.contentType !== "image/webp" || Number(entry.meta.size || 0) > profile.maxBytes;
};

const inspectImageBuffer = async (buffer, contentType) => {
  const expectedFormats = IMAGE_FORMATS_BY_CONTENT_TYPE[contentType];
  if (!expectedFormats) {
    throw new Error("Unsupported image content type");
  }

  let metadata;
  try {
    metadata = await sharp(buffer, {
      animated: false,
      limitInputPixels: MAX_SOURCE_IMAGE_PIXELS,
    }).metadata();
  } catch {
    throw new Error("Invalid or oversized image data");
  }
  if (!metadata.width || !metadata.height || !expectedFormats.has(metadata.format)) {
    throw new Error("Image data does not match its content type");
  }
  return metadata;
};

const optimizeImageBuffer = async (buffer, contentType, imageProfile = "library") => {
  if (!OPTIMIZABLE_CONTENT_TYPES.has(contentType)) {
    return { buffer, contentType };
  }
  const profile = IMAGE_PROFILES[normalizeImageProfile(imageProfile)];

  const optimizedBuffer = await sharp(buffer, {
    animated: false,
    limitInputPixels: MAX_SOURCE_IMAGE_PIXELS,
  })
    .rotate()
    .resize({
      width: profile.maxPx,
      height: profile.maxPx,
      fit: "inside",
      withoutEnlargement: true,
    })
    .webp({ quality: profile.quality })
    .toBuffer();

  return { buffer: optimizedBuffer, contentType: "image/webp" };
};

const normalizeCachedEntryIfNeeded = async (entry) => {
  if (!shouldNormalizeCachedEntry(entry)) {
    return entry;
  }

  let buffer = null;
  try {
    buffer = await fs.promises.readFile(entry.imagePath);
  } catch {
    return entry;
  }

  const optimized = await optimizeImageBuffer(
    buffer,
    entry.meta.contentType,
    entry.meta.profile,
  );
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
    normalizeKnownImageUrl(entry.meta.sourceUrl) || entry.meta.sourceUrl || null,
    entry.meta.profile,
  );
};

const parseSafeRemoteUrl = (value, baseUrl) => {
  const parsed = new URL(value, baseUrl);
  if (!["http:", "https:"].includes(parsed.protocol)) {
    throw new Error("Unsupported image protocol");
  }
  if (parsed.username || parsed.password || isPrivateHostname(parsed.hostname)) {
    throw new Error("Refusing to cache private host");
  }
  return parsed;
};

const readBoundedResponse = async (response) => {
  const contentLength = response.headers.get("content-length");
  if (contentLength && Number(contentLength) > MAX_SOURCE_IMAGE_BYTES) {
    await response.body?.cancel();
    throw new Error("Upstream image exceeds the size limit");
  }

  const chunks = [];
  let totalBytes = 0;
  for await (const chunk of response.body || []) {
    const buffer = Buffer.from(chunk);
    totalBytes += buffer.length;
    if (totalBytes > MAX_SOURCE_IMAGE_BYTES) {
      throw new Error("Upstream image exceeds the size limit");
    }
    chunks.push(buffer);
  }
  return Buffer.concat(chunks, totalBytes);
};

const fetchRemoteImage = async (sourceUrl) => {
  let currentUrl = parseSafeRemoteUrl(sourceUrl);
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);

  try {
    for (let redirectCount = 0; redirectCount <= MAX_REDIRECTS; redirectCount += 1) {
      const requestFetch = usesNativeFetch() ? undiciFetch : globalThis.fetch;
      const response = await requestFetch(currentUrl, {
        redirect: "manual",
        signal: controller.signal,
        dispatcher: imageProxyDispatcher,
        headers: {
          Accept: "image/avif,image/webp,image/apng,image/svg+xml,image/png,image/jpeg,image/gif",
          "Accept-Encoding": "identity",
          "User-Agent": "Aurral Local Image Cache",
        },
      });

      if ([301, 302, 303, 307, 308].includes(response.status)) {
        const location = response.headers.get("location");
        await response.body?.cancel();
        if (!location || redirectCount === MAX_REDIRECTS) {
          throw new Error("Too many upstream image redirects");
        }
        currentUrl = parseSafeRemoteUrl(location, currentUrl);
        continue;
      }
      if (!response.ok) {
        await response.body?.cancel();
        throw new Error(`Upstream image request failed with status ${response.status}`);
      }

      const contentType = String(response.headers.get("content-type") || "")
        .split(";")[0]
        .trim()
        .toLowerCase();
      if (!IMAGE_FORMATS_BY_CONTENT_TYPE[contentType]) {
        await response.body?.cancel();
        throw new Error("Upstream response is not a supported image");
      }

      const buffer = await readBoundedResponse(response);
      const metadata = await inspectImageBuffer(buffer, contentType);
      return { buffer, contentType, metadata };
    }
  } finally {
    clearTimeout(timer);
  }

  throw new Error("Too many upstream image redirects");
};

const fetchAndCacheImage = async (sourceUrl, imageProfile = "library") => {
  const normalizedSourceUrl = normalizeKnownImageUrl(sourceUrl);
  if (!normalizedSourceUrl) {
    throw new Error("Missing source image URL");
  }
  const profile = normalizeImageProfile(imageProfile);

  const sourceImage = await fetchRemoteImage(normalizedSourceUrl);
  const optimized = await optimizeImageBuffer(sourceImage.buffer, sourceImage.contentType, profile);

  return writeCacheEntry(
    buildImageCacheKey(normalizedSourceUrl, profile),
    optimized.buffer,
    optimized.contentType,
    normalizedSourceUrl,
    profile,
  );
};

export const warmImageProxy = async (sourceUrl, imageProfile = "library") => {
  const profile = normalizeImageProfile(imageProfile);
  const cacheKeyFromLocalUrl = getCacheKeyFromLocalUrl(sourceUrl);
  if (cacheKeyFromLocalUrl) {
    await awaitCacheIndexReady();
    const cachedLocal = getCachedEntryFromKey(cacheKeyFromLocalUrl);
    if (cachedLocal?.imagePath && fs.existsSync(cachedLocal.imagePath)) {
      if (normalizeImageProfile(cachedLocal.meta?.profile) === profile) {
        return normalizeCachedEntryIfNeeded(cachedLocal);
      }
      const sourceFromMeta =
        normalizeKnownImageUrl(cachedLocal.meta?.sourceUrl) || cachedLocal.meta?.sourceUrl || null;
      if (sourceFromMeta) {
        return fetchAndCacheImage(sourceFromMeta, profile);
      }
      return cachedLocal;
    }
    const meta = _readCacheMetadata(
      path.join(IMAGE_PROXY_DIR, `${cacheKeyFromLocalUrl}.json`),
    );
    const sourceFromMeta = normalizeKnownImageUrl(meta?.sourceUrl) || meta?.sourceUrl || null;
    if (sourceFromMeta) {
      return fetchAndCacheImage(sourceFromMeta, profile);
    }
    throw new Error("Missing local cached image");
  }

  const normalizedSourceUrl = normalizeKnownImageUrl(sourceUrl);
  if (!normalizedSourceUrl) {
    throw new Error("Missing source image URL");
  }

  const cached = getCachedEntry(normalizedSourceUrl, profile);
  if (cached?.isFresh) {
    return normalizeCachedEntryIfNeeded(cached);
  }

  const inflightKey = buildSourceMapKey(normalizedSourceUrl, profile);
  if (inflightRequests.has(inflightKey)) {
    return inflightRequests.get(inflightKey);
  }

  const request = fetchAndCacheImage(normalizedSourceUrl, profile).finally(() => {
    inflightRequests.delete(inflightKey);
  });
  inflightRequests.set(inflightKey, request);
  return request;
};

export const warmPublicImageUrl = async (sourceUrl, imageProfile = "library") => {
  const normalized = String(sourceUrl || "").trim();
  if (!normalized || normalized === "NOT_FOUND") return null;
  if (isImageProxyLocalUrl(normalized)) {
    try {
      const entry = await warmImageProxy(normalized, imageProfile);
      return entry?.localUrl || null;
    } catch {
      return null;
    }
  }
  const srcMatch = normalized.match(/\/api\/image-proxy\?src=([^&]+)/i);
  const remote = srcMatch ? decodeURIComponent(srcMatch[1]) : normalized;
  if (!remote || remote.startsWith("/") || remote.startsWith("data:") || remote.startsWith("blob:")) {
    return remote || null;
  }
  try {
    const entry = await warmImageProxy(remote, imageProfile);
    return entry?.localUrl || null;
  } catch {
    return null;
  }
};

export const buildImageProxyUrl = (sourceUrl) => {
  return buildStableImageProxyUrl(sourceUrl);
};

export const buildStableImageProxyUrl = (sourceUrl) => {
  const normalized = normalizeKnownImageUrl(sourceUrl);
  if (!normalized) return null;

  const localKey = getCacheKeyFromLocalUrl(normalized);
  if (localKey) {
    const meta = _readCacheMetadata(path.join(IMAGE_PROXY_DIR, `${localKey}.json`));
    const sourceFromMeta = normalizeKnownImageUrl(meta?.sourceUrl) || meta?.sourceUrl || null;
    return sourceFromMeta ? buildStableImageProxyUrl(sourceFromMeta) : normalized;
  }

  const srcMatch = normalized.match(/\/api\/image-proxy\?src=([^&]+)/i);
  let remote = normalized;
  if (srcMatch) {
    try {
      remote = decodeURIComponent(srcMatch[1]);
    } catch {
      return normalized;
    }
  }
  if (
    remote.startsWith("/") ||
    remote.startsWith("data:") ||
    remote.startsWith("blob:")
  ) {
    return normalized;
  }

  try {
    const parsed = new URL(remote);
    if (!["http:", "https:"].includes(parsed.protocol)) return normalized;
  } catch {
    return normalized;
  }

  return remote;
};

export const handleImageProxyRequest = async (req, res) => {
  const rawKey = String(req.params.cacheKey || "").trim();
  const match = rawKey.match(/^([a-f0-9]{64})(?:\.([a-z0-9]+))?$/i);
  if (!match) {
    return res.status(404).json({ error: "Image not found" });
  }

  const cacheKey = match[1].toLowerCase();
  await awaitCacheIndexReady();
  let cached = getCachedEntryFromKey(cacheKey);
  if (!cached?.imagePath || !fs.existsSync(cached.imagePath)) {
    const meta = _readCacheMetadata(path.join(IMAGE_PROXY_DIR, `${cacheKey}.json`));
    const sourceFromMeta = normalizeKnownImageUrl(meta?.sourceUrl) || meta?.sourceUrl || null;
    if (sourceFromMeta) {
      try {
        cached = await fetchAndCacheImage(sourceFromMeta, meta?.profile);
      } catch {}
    }
  }
  if (!cached?.imagePath || !fs.existsSync(cached.imagePath)) {
    return res.status(404).json({ error: "Image not found" });
  }
  try {
    cached = await normalizeCachedEntryIfNeeded(cached);
  } catch {
    return res.status(404).json({ error: "Image not found" });
  }

  res.set("Content-Type", cached.meta.contentType || "image/jpeg");
  res.set("Cache-Control", "public, max-age=31536000, immutable");
  touchCacheEntry(cached.imagePath);
  return res.sendFile(path.basename(cached.imagePath), {
    root: IMAGE_PROXY_DIR,
    dotfiles: "allow",
  });
};

export const handleLegacyImageProxyRequest = async (req, res) => {
  const rawSourceUrl = typeof req.query.src === "string" ? req.query.src.trim() : "";
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

migrateObsoleteImageCache();
