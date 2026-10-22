import { isOwnKey } from "../../../lib/ownKey.ts";
// Canonical candidate-track model and provider result normalization.
//
// Different download sources expose very different evidence. The normalizer
// keeps only what a source actually provides and
// never fabricates values.

import { foldDiacritics } from "../providers/brainzmashRanking.ts";

export const SOURCE_CAPABILITIES = {
  deemix: {
    structuredArtist: true,
    structuredAlbum: true,
    structuredDuration: true,
    providerTrackId: true,
    filename: false,
    directoryContext: false,
    releaseContext: false,
  },
  ytdlp: {
    structuredArtist: false,
    structuredAlbum: false,
    structuredDuration: true,
    providerTrackId: true,
    uploaderChannel: true,
    filename: false,
    directoryContext: false,
    releaseContext: false,
  },
  soulseek: {
    structuredArtist: false,
    structuredAlbum: false,
    structuredDuration: false,
    providerTrackId: false,
    filename: true,
    directoryContext: true,
    advertisedDuration: true,
    releaseContext: false,
  },
  usenet: {
    structuredArtist: false,
    structuredAlbum: false,
    structuredDuration: false,
    providerTrackId: false,
    filename: true,
    filenameMayBeUnavailablePreDownload: true,
    releaseContext: true,
    directoryContext: true,
  },
};

type SourceCapabilities = {
  structuredArtist: boolean;
  structuredAlbum: boolean;
  structuredDuration: boolean;
  providerTrackId: boolean;
  filename: boolean;
  directoryContext: boolean;
  releaseContext: boolean;
  uploaderChannel?: boolean;
  advertisedDuration?: boolean;
  filenameMayBeUnavailablePreDownload?: boolean;
};

const DEFAULT_CAPABILITIES: SourceCapabilities = Object.freeze({
  structuredArtist: false,
  structuredAlbum: false,
  structuredDuration: false,
  providerTrackId: false,
  filename: false,
  directoryContext: false,
  releaseContext: false,
});

export function getCapabilities(source?: string): SourceCapabilities {
  const key = String(source || "").toLowerCase();
  return (
    (isOwnKey(SOURCE_CAPABILITIES, key) ? SOURCE_CAPABILITIES[key] : undefined) || {
      ...DEFAULT_CAPABILITIES,
    }
  );
}

function cleanText(value: unknown) {
  return String(value ?? "").trim() || null;
}

function positiveNumber(value: unknown) {
  const number = Number(value);
  return Number.isFinite(number) && number > 0 ? number : null;
}

function readDurationMs(value: unknown) {
  if (value == null) return null;
  const number = Number(value);
  if (!Number.isFinite(number) || number <= 0) return null;
  return Math.round(number);
}

export function getPathParts(filePath: unknown) {
  return String(filePath || "")
    .split(/[\\/]+/)
    .map((entry) => entry.trim())
    .filter(Boolean);
}

export function getFileName(filePath: unknown) {
  const parts = getPathParts(filePath);
  return parts.length > 0 ? parts[parts.length - 1] : "";
}

export function getFileExtension(filePath: unknown) {
  const fileName = getFileName(filePath);
  const dot = fileName.lastIndexOf(".");
  if (dot <= 0) return "";
  return fileName.slice(dot).toLowerCase();
}

export function getFileBaseName(filePath: unknown) {
  const fileName = getFileName(filePath);
  const ext = getFileExtension(filePath);
  return ext ? fileName.slice(0, -ext.length) : fileName;
}

export type RawCandidate = {
  file?: unknown;
  path?: unknown;
  filename?: unknown;
  title?: unknown;
  durationMs?: unknown;
  durationSec?: unknown;
  length?: unknown;
  artists?: unknown;
  artistName?: unknown;
  artist?: unknown;
  format?: unknown;
  ext?: unknown;
  bitrate?: unknown;
  bitRate?: unknown;
  bitDepth?: unknown;
  sampleRate?: unknown;
  album?: unknown;
  albumName?: unknown;
  year?: unknown;
  trackNumber?: unknown;
  track?: unknown;
  discNumber?: unknown;
  disc?: unknown;
  isrc?: unknown;
  recordingMbid?: unknown;
  trackMbid?: unknown;
  releaseMbid?: unknown;
  id?: unknown;
  guid?: unknown;
  user?: unknown;
  channel?: unknown;
  uploader?: unknown;
  uploaderId?: unknown;
  speed?: unknown;
  slots?: unknown;
  locked?: unknown;
  isLocked?: unknown;
  url?: unknown;
  downloadUrl?: unknown;
};

type NormalizeOptions = {
  capabilities?: Partial<SourceCapabilities>;
  parseFilename?: boolean;
  knownArtistNames?: string[];
};

export type CandidateTrack<Raw extends RawCandidate = RawCandidate> = NonNullable<
  ReturnType<typeof normalizeCandidate<Raw>>
> & {
  sizeBytes?: number;
};

const LOSSLESS_EXTENSIONS = new Set([".flac", ".alac", ".ape", ".wav", ".aiff", ".aif", ".wv"]);
const LOSSY_EXTENSIONS = new Set([".mp3", ".aac", ".m4a", ".ogg", ".oga", ".opus", ".wma"]);
// Real Soulseek listings put every real lossless file
// above 77 kbit/s and every real lossy file at 16 kbit/s or more. Generated
// silence, truncated shares, and game stems sit below these floors.
const MIN_KBPS = { lossless: 48, lossy: 12 };

// The encoded bitrate of a file whose size cannot hold music of its length,
// or null. A ".m4a" may hold ALAC, so it gets the lossy floor unless
// `lossless` says what the file holds. A track MusicBrainz titles
// "[silence]" is digital silence on the release, and its real file is tiny.
export function implausibleBitrateKbps({
  path: filePath,
  lossless = null,
  sizeBytes,
  durationMs,
  trackTitle = null,
}: {
  path?: unknown;
  lossless?: boolean | null;
  sizeBytes?: unknown;
  durationMs?: unknown;
  trackTitle?: unknown;
}) {
  if (/^\s*\[silence\]\s*$/iu.test(String(trackTitle || ""))) return null;
  const extension = getFileExtension(filePath);
  const kind =
    lossless === true || (lossless == null && LOSSLESS_EXTENSIONS.has(extension))
      ? "lossless"
      : lossless === false || LOSSY_EXTENSIONS.has(extension)
        ? "lossy"
        : null;
  const size = positiveNumber(sizeBytes);
  const duration = positiveNumber(durationMs);
  if (!kind || !size || !duration) return null;
  const kbps = (size * 8) / duration;
  return kbps < MIN_KBPS[kind] ? kbps : null;
}

// Splits "Artist - Title" style segments. Returns null when the text does not
// look like an artist/title pair.
export function splitArtistTitleSegments(text: string | null | undefined) {
  const segments = String(text || "")
    .split(/\s+(?:-|–|—)\s+/)
    .map((segment) => segment.trim())
    .filter(Boolean);
  return segments.length >= 2 ? segments : null;
}

// Unstructured sources commonly expose "Artist - Title (Descriptor)" in one
// string. The trailing segment is the strongest available claim about the
// track title; the full string stays in `title` for evidence.
export function claimedTitle(title: string | null | undefined) {
  const segments = splitArtistTitleSegments(title);
  if (!segments) return cleanText(title);
  return segments[segments.length - 1];
}

function readArtists(raw: RawCandidate, capabilities: Partial<SourceCapabilities>) {
  if (capabilities?.structuredArtist !== true) return [];
  if (Array.isArray(raw.artists)) {
    const names = raw.artists.map((entry) => cleanText(entry)).filter(Boolean);
    if (names.length > 0) return names;
  }
  const artist = cleanText(raw.artistName || raw.artist);
  return artist ? [artist] : [];
}

function readQuality(raw: RawCandidate, capabilities: Partial<SourceCapabilities>) {
  const format =
    cleanText(raw.format || raw.ext || getFileExtension(raw.file || raw.path || "").slice(1)) ||
    null;
  const bitrate = positiveNumber(raw.bitrate ?? raw.bitRate);
  return {
    format: format ? format.toLowerCase() : null,
    bitrate: bitrate ? Math.round(bitrate) : null,
    bitDepth: positiveNumber(raw.bitDepth),
    sampleRate: positiveNumber(raw.sampleRate),
    advertised: Boolean(capabilities?.advertisedDuration || format || bitrate),
  };
}

export function normalizeCandidate<Raw extends RawCandidate = RawCandidate>(
  source?: string,
  raw: Partial<Raw> = {},
  options: NormalizeOptions = {},
) {
  const capabilities = options.capabilities || getCapabilities(source);
  const filePath = cleanText(raw.file || raw.path || raw.filename);
  const fileName = filePath ? getFileName(filePath) : null;
  const baseName = fileName ? getFileBaseName(fileName) : null;
  const title = cleanText(raw.title) || baseName;
  if (!title) return null;

  const durationMs =
    readDurationMs(raw.durationMs) ??
    (positiveNumber(raw.durationSec) ? Math.round(Number(raw.durationSec) * 1000) : null) ??
    (positiveNumber(raw.length) ? Math.round(Number(raw.length) * 1000) : null);

  const { artist: filenameArtist, title: filenameTitle } = options.parseFilename
    ? parseFilenameArtistTitle(baseName, options.knownArtistNames || [])
    : { artist: null, title: null };

  const artists = readArtists(raw, capabilities);
  if (
    filenameArtist &&
    !artists.some((name) => name!.toLowerCase() === filenameArtist.toLowerCase())
  ) {
    artists.push(filenameArtist);
  }

  return {
    source,
    title,
    cleanedTitle: capabilities.structuredArtist ? title : claimedTitle(title),
    filenameTitle,
    artists,
    album: cleanText(raw.album || raw.albumName),
    durationMs,
    year: positiveNumber(raw.year) ? Math.round(Number(raw.year)) : null,
    trackNumber: positiveNumber(raw.trackNumber ?? raw.track)
      ? Math.round(Number(raw.trackNumber ?? raw.track))
      : null,
    discNumber: positiveNumber(raw.discNumber ?? raw.disc)
      ? Math.round(Number(raw.discNumber ?? raw.disc))
      : null,
    isrc: cleanText(raw.isrc),
    recordingMbid: cleanText(raw.recordingMbid || raw.trackMbid),
    releaseMbid: cleanText(raw.releaseMbid),
    filename: fileName,
    path: filePath,
    quality: readQuality(raw, capabilities),
    provider: {
      id: cleanText(raw.id || raw.guid),
      uploader: cleanText(raw.user || raw.channel || raw.uploader || raw.uploaderId),
      speed: positiveNumber(raw.speed),
      url: cleanText(raw.url || raw.downloadUrl),
      slots: raw.slots === true,
      locked: raw.locked === true || raw.isLocked === true,
    },
    directoryPath: filePath ? getPathParts(filePath).slice(0, -1).join("/") : null,
    raw,
  };
}

// Parses "Artist - Title" file names using the known artist names as anchors
// so numeric artist names ("50 Cent") survive a leading track number.
export function parseFilenameArtistTitle(
  baseName: string | null | undefined,
  knownArtistNames: (string | null | undefined)[] = [],
) {
  const candidates = [String(baseName || "")];
  const stripped = candidates[0].replace(/^\s*\d{1,3}(?:\s*[-._)\]]|\s+)/, "").trim();
  if (stripped) candidates.unshift(stripped);

  for (const text of candidates) {
    const segments = splitArtistTitleSegments(text);
    if (!segments) continue;
    const artist = segments[0];
    const match = knownArtistNames.some((name) => {
      const left = foldDiacritics(name).toLowerCase();
      return left && foldDiacritics(artist).toLowerCase() === left;
    });
    if (match || knownArtistNames.length === 0) {
      return { artist, title: segments.slice(1).join(" - ") };
    }
  }
  return { artist: null, title: null };
}
