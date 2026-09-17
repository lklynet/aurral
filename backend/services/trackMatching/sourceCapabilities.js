// Per-source evidence capabilities.
//
// These flags keep the matcher honest about what each provider actually
// proves. A noisy YouTube title must never be treated like structured Deezer
// metadata, and a Soulseek file name is only a claim until tags are parsed
// after download.

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

const DEFAULT_CAPABILITIES = Object.freeze({
  structuredArtist: false,
  structuredAlbum: false,
  structuredDuration: false,
  providerTrackId: false,
  filename: false,
  directoryContext: false,
  releaseContext: false,
});

export function getCapabilities(source) {
  const key = String(source || "").toLowerCase();
  return SOURCE_CAPABILITIES[key] || { ...DEFAULT_CAPABILITIES };
}

export function hasStructuredMetadata(source) {
  const capabilities = getCapabilities(source);
  return capabilities.structuredArtist && capabilities.structuredDuration;
}
