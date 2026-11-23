import { lookupIds } from "../providers/metadataProvider.ts";
import { logger } from "../logger.ts";

type CatalogueIds = Awaited<ReturnType<typeof lookupIds>>;

export const NO_CATALOGUE_IDS: CatalogueIds = new Map();

export const isrcKey = (isrc: string | null | undefined) => {
  const code = String(isrc ?? "")
    .replace(/[^a-z0-9]/gi, "")
    .toUpperCase();
  return code.length === 12 ? `isrc:${code}` : null;
};

export const loadCatalogueIds = (keys: (string | null)[]) =>
  lookupIds(keys.filter((key) => key !== null)).catch((error: unknown) => {
    logger.info("playlist-import", "Imported tracks keep their names without catalogue IDs", {
      error: error instanceof Error ? error.message : String(error),
    });
    return NO_CATALOGUE_IDS;
  });

// The album is the recording's best-known one, which the source may name
// differently. A download keeps it because it lists the recording.
export function catalogueTrackIds(ids: CatalogueIds, keys: (string | null)[]) {
  let trackMbid: string | null = null;
  let albumMbid: string | null = null;
  let artistMbid: string | null = null;
  for (const key of keys) {
    const entry = key ? ids.get(key) : null;
    if (!entry) continue;
    if (artistMbid && entry.artistMbid && entry.artistMbid !== artistMbid) continue;
    trackMbid ??= entry.trackMbid;
    albumMbid ??= entry.albumMbid;
    artistMbid ??= entry.artistMbid;
  }
  return { trackMbid, albumMbid, artistMbid };
}
