// Canonical candidate-track model and provider result normalization.
//
// Different download sources expose very different evidence. The normalizer
// keeps only what a source actually provides (see sourceCapabilities.js) and
// never fabricates values.

function cleanText(value) {
  return String(value ?? "").trim() || null;
}

function positiveNumber(value) {
  const number = Number(value);
  return Number.isFinite(number) && number > 0 ? number : null;
}

function readDurationMs(value) {
  if (value == null) return null;
  const number = Number(value);
  if (!Number.isFinite(number) || number <= 0) return null;
  return Math.round(number);
}

export function getPathParts(filePath) {
  return String(filePath || "")
    .split(/[\\/]+/)
    .map((entry) => entry.trim())
    .filter(Boolean);
}

export function getFileName(filePath) {
  const parts = getPathParts(filePath);
  return parts.length > 0 ? parts[parts.length - 1] : "";
}

export function getFileExtension(filePath) {
  const fileName = getFileName(filePath);
  const dot = fileName.lastIndexOf(".");
  if (dot <= 0) return "";
  return fileName.slice(dot).toLowerCase();
}

export function getFileBaseName(filePath) {
  const fileName = getFileName(filePath);
  const ext = getFileExtension(filePath);
  return ext ? fileName.slice(0, -ext.length) : fileName;
}

// Splits "Artist - Title" style segments. Returns null when the text does not
// look like an artist/title pair.
export function splitArtistTitleSegments(text) {
  const segments = String(text || "")
    .split(/\s+(?:-|–|—)\s+/)
    .map((segment) => segment.trim())
    .filter(Boolean);
  return segments.length >= 2 ? segments : null;
}

// Unstructured sources commonly expose "Artist - Title (Descriptor)" in one
// string. The trailing segment is the strongest available claim about the
// track title; the full string stays in `title` for evidence.
export function claimedTitle(title) {
  const segments = splitArtistTitleSegments(title);
  if (!segments) return cleanText(title);
  return segments[segments.length - 1];
}

function readArtists(raw) {
  if (Array.isArray(raw.artists)) {
    const names = raw.artists.map((entry) => cleanText(entry)).filter(Boolean);
    if (names.length > 0) return names;
  }
  const artist = cleanText(raw.artistName || raw.artist || raw.channel || raw.uploader);
  return artist ? [artist] : [];
}

function readQuality(raw, capabilities) {
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

export function normalizeCandidate(source, raw = {}, options = {}) {
  const capabilities = options.capabilities || null;
  const filePath = cleanText(raw.file || raw.path || raw.filename);
  const fileName = filePath ? getFileName(filePath) : null;
  const baseName = fileName ? getFileBaseName(fileName) : null;
  const title = cleanText(raw.title) || baseName;
  if (!title) return null;

  const durationMs =
    readDurationMs(raw.durationMs) ??
    (positiveNumber(raw.durationSec)
      ? Math.round(Number(raw.durationSec) * 1000)
      : null) ??
    (positiveNumber(raw.length) ? Math.round(Number(raw.length) * 1000) : null);

  const { artist: filenameArtist, title: filenameTitle } = options.parseFilename
    ? parseFilenameArtistTitle(baseName, options.knownArtistNames || [])
    : { artist: null, title: null };

  const artists = readArtists(raw);
  if (filenameArtist && !artists.some((name) => name.toLowerCase() === filenameArtist.toLowerCase())) {
    artists.push(filenameArtist);
  }

  return {
    source,
    title,
    cleanedTitle: claimedTitle(title),
    filenameTitle,
    artists,
    album: cleanText(raw.album || raw.albumName),
    durationMs,
    year: positiveNumber(raw.year) ? Math.round(Number(raw.year)) : null,
    trackNumber: positiveNumber(raw.trackNumber ?? raw.track) ? Math.round(Number(raw.trackNumber ?? raw.track)) : null,
    discNumber: positiveNumber(raw.discNumber ?? raw.disc) ? Math.round(Number(raw.discNumber ?? raw.disc)) : null,
    isrc: cleanText(raw.isrc),
    recordingMbid: cleanText(raw.recordingMbid || raw.trackMbid),
    releaseMbid: cleanText(raw.releaseMbid),
    filename: fileName,
    path: filePath,
    quality: readQuality(raw, capabilities),
    provider: {
      id: cleanText(raw.id || raw.guid),
      uploader: cleanText(raw.user || raw.uploader || raw.uploaderId),
      speed: positiveNumber(raw.speed),
      url: cleanText(raw.url || raw.downloadUrl),
      slots: raw.slots === true,
      locked: raw.locked === true || raw.isLocked === true,
    },
    directoryPath: filePath
      ? getPathParts(filePath).slice(0, -1).join("/")
      : null,
    raw,
  };
}

// Parses "Artist - Title" file names using the known artist names as anchors
// so numeric artist names ("50 Cent") survive a leading track number.
export function parseFilenameArtistTitle(baseName, knownArtistNames = []) {
  const candidates = [String(baseName || "")];
  const stripped = candidates[0].replace(/^\s*\d{1,3}(?:\s*[-._)\]]|\s+)/, "").trim();
  if (stripped) candidates.unshift(stripped);

  for (const text of candidates) {
    const segments = splitArtistTitleSegments(text);
    if (!segments) continue;
    const artist = segments[0];
    const match = knownArtistNames.some((name) => {
      const left = String(name || "").toLowerCase();
      return left && artist.toLowerCase() === left;
    });
    if (match || knownArtistNames.length === 0) {
      return { artist, title: segments[segments.length - 1] };
    }
  }
  return { artist: null, title: null };
}
