import crypto from "crypto";
import dns from "node:dns";
import type { LookupFunction } from "node:net";
import fs from "fs";
import path from "path";
import { Agent, fetch as undiciFetch, type Response as UndiciResponse } from "undici";
import PQueue from "p-queue";
import * as v from "valibot";
import getSharp from "./sharpConfig.ts";
import BoundedMap from "./boundedMap.ts";
import { resolveAurralDataDir } from "../config/data-dir.ts";
import { dbHelpers } from "../config/db-sqlite.ts";
import { lenient } from "../db/helpers/storedSchemas.ts";
import { asAppError } from "../../lib/errors.ts";
import { isOwnKey } from "../../lib/ownKey.ts";
import { isPrivateAddress, isPrivateHostname } from "../../lib/publicUrl.ts";

type CachedImageEntry = {
  cacheKey: string;
  meta: StoredCachedImageMeta;
  imagePath: string;
  localUrl: string;
  isFresh: boolean;
};

const IMAGE_PROXY_ROUTE = "/api/image-proxy";
const DATA_DIR = resolveAurralDataDir();
const IMAGE_PROXY_DIR = path.join(DATA_DIR, "image-proxy");
const IMAGE_CACHE_MIGRATION_MARKER = path.join(DATA_DIR, ".image-cache-links-v1");
const CACHE_TTL_MS = 30 * 24 * 60 * 60 * 1000;
const FETCH_TIMEOUT_MS = 25000;
const MAX_REDIRECTS = 5;
export const MAX_SOURCE_IMAGE_BYTES = 25 * 1024 * 1024;
const MAX_SOURCE_IMAGE_PIXELS = 40_000_000;
const IMAGE_PROFILES = {
  library: { maxPx: 512, maxBytes: 150 * 1024, quality: 70 },
};
// ponytail: FIFO by mtime, touch on serve for LRU; raise/env only if disk pressure complains
const IMAGE_PROXY_MAX_BYTES = (() => {
  const parsed = Number(process.env.AURRAL_IMAGE_PROXY_MAX_BYTES);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : 256 * 1024 * 1024;
})();
const inflightRequests = new Map<string, Promise<CachedImageEntry>>();
const imageWorkQueue = new PQueue({ concurrency: 2 });
const cacheEntriesByKey: Map<string, CachedImageEntry> = new BoundedMap(256);
let cacheIndexInitialized = false;
let indexBuildPromise: Promise<void> | null = null;

const runImageWork = (workKey: string, work: () => Promise<CachedImageEntry>) => {
  if (inflightRequests.has(workKey)) return inflightRequests.get(workKey)!;
  const request = imageWorkQueue.add(work).finally(() => inflightRequests.delete(workKey));
  inflightRequests.set(workKey, request);
  return request;
};

const MIME_EXTENSION_MAP = {
  "image/jpeg": "jpg",
  "image/png": "png",
  "image/apng": "png",
  "image/webp": "webp",
  "image/gif": "gif",
  "image/avif": "avif",
  "image/svg+xml": "svg",
};

const cachedImageMetaSchema = v.looseObject({
  sourceUrl: lenient(v.nullable(v.string())),
  contentType: lenient(v.string()),
  extension: lenient(v.picklist([...new Set([...Object.values(MIME_EXTENSION_MAP), "img"])])),
  fetchedAt: lenient(v.number()),
  size: lenient(v.number()),
  profile: lenient(v.string()),
});

type StoredCachedImageMeta = v.InferOutput<typeof cachedImageMetaSchema>;

const readCacheMetadata = (text: string, metaPath: string) =>
  dbHelpers.readJSON(cachedImageMetaSchema, text, metaPath);
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

const safeLookup = (
  hostname: string,
  options: dns.LookupOptions,
  callback: (
    err: NodeJS.ErrnoException | null,
    address?: string | dns.LookupAddress[],
    family?: number,
  ) => void,
) => {
  dns.lookup(hostname, { ...options, all: true }, (error, addresses) => {
    if (error) return callback(error);
    const publicAddresses = addresses.filter(({ address }) => !isPrivateAddress(address));
    if (publicAddresses.length === 0) {
      const lookupError: NodeJS.ErrnoException = new Error("Refusing to connect to a private host");
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
  connect: { lookup: safeLookup as LookupFunction },
});
const usesNativeFetch = () =>
  Function.prototype.toString.call(globalThis.fetch).includes("internal/deps/undici");

const ensureCacheDir = () => fs.promises.mkdir(IMAGE_PROXY_DIR, { recursive: true });

const initializeCacheIndex = () => {
  if (cacheIndexInitialized) return;
  cacheIndexInitialized = true;
  indexBuildPromise = (async () => {
    try {
      await ensureCacheDir();
      await migrateObsoleteImageCache();
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

const removeCacheEntryFromDisk = async (cacheKey: string, extension: string) => {
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
      const text = await fs.promises.readFile(metaPath, "utf8").catch(() => null);
      const meta = text === null ? null : readCacheMetadata(text, metaPath);
      if (!meta) continue;
      const extension = meta.extension || "webp";
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

  evictableEntries.sort((a, b) => a.mtimeMs - b.mtimeMs || a.cacheKey.localeCompare(b.cacheKey));
  for (const entry of evictableEntries) {
    if (total <= IMAGE_PROXY_MAX_BYTES) break;
    await removeCacheEntryFromDisk(entry.cacheKey, entry.extension);
    total -= entry.bytes;
  }
};

const touchCacheEntry = (imagePath: string) => {
  if (!imagePath) return;
  const now = new Date();
  fs.promises.utimes(imagePath, now, now).catch(() => {});
};

const hashValue = (value: string) =>
  crypto.createHash("sha256").update(String(value)).digest("hex");

const normalizeImageProfile: (profile?: unknown) => "library" = () => "library";

const buildImageCacheKey = (sourceUrl: string, profile = "library") =>
  hashValue(`${normalizeImageProfile(profile)}:${sourceUrl}`);

const normalizeKnownImageUrl = (value: string | null | undefined) =>
  String(value || "")
    .trim()
    .replace(
      /^(https?:\/\/coverartarchive\.org\/release-group\/[0-9a-f-]+)\/front-250(?=[/?#]|$)/i,
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

const getCachePaths = (cacheKey: string) => ({
  metaPath: path.join(IMAGE_PROXY_DIR, `${cacheKey}.json`),
  baseImagePath: path.join(IMAGE_PROXY_DIR, `${cacheKey}`),
});

const removeStaleCachedFiles = (cacheKey: string, keepExtension: string | null) =>
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
    if (asAppError(error)?.code === "EEXIST") obsoleteImageCacheMigrationComplete = true;
  }
};

const buildLocalImageUrl = (cacheKey: string, extension: string) =>
  `${IMAGE_PROXY_ROUTE}/${cacheKey}.${extension}`;

const awaitCacheIndexReady = async () => {
  initializeCacheIndex();
  if (indexBuildPromise) {
    await indexBuildPromise;
  }
};

const readCacheEntryFromDisk = (cacheKey: string): CachedImageEntry | null => {
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
  const profile = normalizeImageProfile(meta.profile);
  const entry = {
    cacheKey,
    meta: { ...meta, profile },
    imagePath,
    localUrl: buildLocalImageUrl(cacheKey, meta.extension),
    isFresh:
      Number(meta.fetchedAt || 0) > 0 && Date.now() - Number(meta.fetchedAt || 0) < CACHE_TTL_MS,
  };
  cacheEntriesByKey.set(cacheKey, entry);
  return entry;
};

const getCacheKeyFromLocalUrl = (value: string | null | undefined) => {
  const normalized = String(value || "").trim();
  const proxyMatch = normalized.match(/\/api\/image-proxy\/([a-f0-9]{64})(?:\.[a-z0-9]+)?$/i);
  if (proxyMatch?.[1]) return proxyMatch[1].toLowerCase();
  const bareMatch = normalized.match(/^([a-f0-9]{64})\.[a-z0-9]+$/i);
  return bareMatch?.[1]?.toLowerCase() || null;
};

export const isImageProxyLocalUrl = (value: string | null | undefined) =>
  getCacheKeyFromLocalUrl(value) != null;

export const resolveImageProxyLocalUrl = (value: string | null | undefined) => {
  const cacheKey = getCacheKeyFromLocalUrl(value);
  if (!cacheKey) return null;
  const entry = readCacheEntryFromDisk(cacheKey);
  return entry?.localUrl || null;
};

const _readCacheMetadata = (metaPath: string) => {
  try {
    return readCacheMetadata(fs.readFileSync(metaPath, "utf8"), metaPath);
  } catch {
    return null;
  }
};

const getCachedEntryFromKey = (cacheKey: string) => {
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

const getCachedEntry = (sourceUrl: string, imageProfile = "library") => {
  const normalizedSourceUrl = normalizeKnownImageUrl(sourceUrl);
  if (!normalizedSourceUrl) return null;
  const profile = normalizeImageProfile(imageProfile);
  initializeCacheIndex();
  const cacheKey = buildImageCacheKey(normalizedSourceUrl, profile);
  return getCachedEntryFromKey(cacheKey);
};

const writeCacheEntry = async (
  cacheKey: string,
  buffer: Buffer,
  contentType: string,
  sourceUrl: string | null,
  imageProfile = "library",
) => {
  await ensureCacheDir();
  const profile = normalizeImageProfile(imageProfile);
  const normalizedSourceUrl = normalizeKnownImageUrl(sourceUrl) || sourceUrl;
  const extension = isOwnKey(MIME_EXTENSION_MAP, contentType)
    ? MIME_EXTENSION_MAP[contentType]
    : "img";
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
  await pruneImageProxyCacheToLimit();
  return entry;
};

type CachedImageEntryWithContentType = CachedImageEntry & {
  meta: StoredCachedImageMeta & { contentType: string };
};

const shouldNormalizeCachedEntry = (
  entry: CachedImageEntry | null,
): entry is CachedImageEntryWithContentType => {
  if (!entry?.imagePath || !entry?.meta?.contentType) return false;
  if (!OPTIMIZABLE_CONTENT_TYPES.has(entry.meta.contentType)) return false;
  const profile = IMAGE_PROFILES[normalizeImageProfile(entry.meta.profile)];
  return entry.meta.contentType !== "image/webp" || Number(entry.meta.size || 0) > profile.maxBytes;
};

export const inspectImageBuffer = async (buffer: Uint8Array, contentType: string) => {
  if (!isOwnKey(IMAGE_FORMATS_BY_CONTENT_TYPE, contentType)) {
    throw new Error("Unsupported image content type");
  }
  const expectedFormats = IMAGE_FORMATS_BY_CONTENT_TYPE[contentType];

  let metadata;
  try {
    const sharp = await getSharp();
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

export const optimizeImageBuffer = async <B extends Uint8Array>(
  buffer: B,
  contentType: string,
  imageProfile = "library",
) => {
  if (!OPTIMIZABLE_CONTENT_TYPES.has(contentType)) {
    return { buffer, contentType };
  }
  const profile = IMAGE_PROFILES[normalizeImageProfile(imageProfile)];

  const sharp = await getSharp();
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

const normalizeCachedEntryIfNeeded = async (entry: CachedImageEntry) => {
  if (!shouldNormalizeCachedEntry(entry)) {
    return entry;
  }

  return runImageWork(`normalize:${entry.cacheKey}`, () => normalizeCachedEntry(entry));
};

const normalizeCachedEntry = async (entry: CachedImageEntryWithContentType) => {
  let buffer = null;
  try {
    buffer = await fs.promises.readFile(entry.imagePath);
  } catch {
    return entry;
  }

  const optimized = await optimizeImageBuffer(buffer, entry.meta.contentType, entry.meta.profile);
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

const parseSafeRemoteUrl = (value: string, baseUrl?: string | URL) => {
  const parsed = new URL(value, baseUrl);
  if (!["http:", "https:"].includes(parsed.protocol)) {
    throw new Error("Unsupported image protocol");
  }
  if (parsed.username || parsed.password || isPrivateHostname(parsed.hostname)) {
    throw new Error("Refusing to cache private host");
  }
  return parsed;
};

const readBoundedResponse = async (response: Response | UndiciResponse) => {
  const contentLength = response.headers.get("content-length");
  if (contentLength && Number(contentLength) > MAX_SOURCE_IMAGE_BYTES) {
    await response.body?.cancel();
    throw new Error("Upstream image exceeds the size limit");
  }

  const chunks = [];
  let totalBytes = 0;
  for await (const chunk of response.body || []) {
    const buffer = Buffer.from(chunk.buffer, chunk.byteOffset, chunk.byteLength);
    totalBytes += buffer.length;
    if (totalBytes > MAX_SOURCE_IMAGE_BYTES) {
      throw new Error("Upstream image exceeds the size limit");
    }
    chunks.push(buffer);
  }
  return Buffer.concat(chunks, totalBytes);
};

export const fetchRemoteImage = async (sourceUrl: string) => {
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
      if (!isOwnKey(IMAGE_FORMATS_BY_CONTENT_TYPE, contentType)) {
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

export const fetchOptimizedImage = (sourceUrl: string) =>
  imageWorkQueue.add(async () => {
    const image = await fetchRemoteImage(normalizeKnownImageUrl(sourceUrl));
    return optimizeImageBuffer(image.buffer, image.contentType);
  });

const fetchAndCacheImage = (sourceUrl: string, imageProfile = "library") =>
  runImageWork(`fetch:${buildImageCacheKey(normalizeKnownImageUrl(sourceUrl), imageProfile)}`, () =>
    fetchAndWriteImage(sourceUrl, imageProfile),
  );

const fetchAndWriteImage = async (sourceUrl: string, imageProfile = "library") => {
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

export const findCachedImageUrl = (sourceUrl: string) => {
  const entry = getCachedEntry(sourceUrl);
  return entry?.imagePath && fs.existsSync(entry.imagePath) ? entry.localUrl : null;
};

export const warmImageProxy = async (sourceUrl: string, imageProfile = "library") => {
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
    const meta = _readCacheMetadata(path.join(IMAGE_PROXY_DIR, `${cacheKeyFromLocalUrl}.json`));
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

  return fetchAndCacheImage(normalizedSourceUrl, profile);
};

export const warmPublicImageUrl = async (
  sourceUrl: string | null | undefined,
  imageProfile = "library",
) => {
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
  if (
    !remote ||
    remote.startsWith("/") ||
    remote.startsWith("data:") ||
    remote.startsWith("blob:")
  ) {
    return remote || null;
  }
  try {
    const entry = await warmImageProxy(remote, imageProfile);
    return entry?.localUrl || null;
  } catch {
    return null;
  }
};

export const buildImageProxyUrl = (sourceUrl: string | null | undefined) => {
  return buildStableImageProxyUrl(sourceUrl);
};

export const buildStableImageProxyUrl = (sourceUrl: string | null | undefined): string | null => {
  const normalized = normalizeKnownImageUrl(sourceUrl);
  if (!normalized) return null;

  const localKey = getCacheKeyFromLocalUrl(normalized);
  if (localKey) {
    const meta = _readCacheMetadata(path.join(IMAGE_PROXY_DIR, `${localKey}.json`));
    const sourceFromMeta = normalizeKnownImageUrl(meta?.sourceUrl) || meta?.sourceUrl || null;
    return sourceFromMeta ? buildStableImageProxyUrl(sourceFromMeta) : null;
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
  if (remote.startsWith("/") || remote.startsWith("data:") || remote.startsWith("blob:")) {
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

export const findCachedImage = async (rawKey: string) => {
  const match = rawKey.trim().match(/^([a-f0-9]{64})(?:\.([a-z0-9]+))?$/i);
  if (!match) return null;

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
  if (!cached?.imagePath || !fs.existsSync(cached.imagePath)) return null;
  try {
    cached = await normalizeCachedEntryIfNeeded(cached);
  } catch {
    return null;
  }
  touchCacheEntry(cached.imagePath);
  return cached;
};

migrateObsoleteImageCache();
