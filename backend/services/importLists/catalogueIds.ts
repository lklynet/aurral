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

// The album stays the one the source names: a download drops every ID of a
// track whose album ID and album name disagree.
export function catalogueTrackIds(ids: CatalogueIds, keys: (string | null)[]) {
  const [known] = keys.flatMap((key) => (key && ids.get(key)) || []);
  return { trackMbid: known?.trackMbid ?? null, artistMbid: known?.artistMbid ?? null };
}
