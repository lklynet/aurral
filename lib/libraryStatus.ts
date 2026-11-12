export const LIBRARY_STATUSES = ["monitored", "unmonitored", "missing"] as const;

export type LibraryStatus = (typeof LIBRARY_STATUSES)[number];

export const isLibraryStatus = (value: unknown): value is LibraryStatus =>
  LIBRARY_STATUSES.some((status) => status === value);
