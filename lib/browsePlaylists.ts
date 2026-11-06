export const BROWSE_PROVIDERS = ["deezer", "mix", "discovery"] as const;

export type BrowseProvider = (typeof BROWSE_PROVIDERS)[number];

export const isBrowseProvider = (value: unknown): value is BrowseProvider =>
  BROWSE_PROVIDERS.some((provider) => provider === value);
