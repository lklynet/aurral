import type { NativeImportProvider } from "./importProviders.ts";

export const BROWSE_PROVIDERS = ["deezer", "mix", "discovery", "community"] as const;

export type BrowseProvider = (typeof BROWSE_PROVIDERS)[number];

export const BROWSE_IMPORT_PROVIDERS = {
  deezer: "deezer-playlist",
  mix: "aurral-mix",
  discovery: "aurral-discovery",
  community: "aurral-community",
} as const satisfies Record<BrowseProvider, NativeImportProvider>;

export const isBrowseProvider = (value: unknown): value is BrowseProvider =>
  BROWSE_PROVIDERS.some((provider) => provider === value);

export const BLEND_MIX_PREFIX = "blend-";
export const LISTENS_MIX_PREFIX = "listens-";

export const fromSomeonesListening = (
  source: { provider: string; externalId?: string | null } | null | undefined,
) =>
  source?.provider === BROWSE_IMPORT_PROVIDERS.mix &&
  !!source.externalId?.startsWith(LISTENS_MIX_PREFIX);
