type LibraryScanRegistry = { changedPaths?: string[] | null };

export type LibraryScanRequest = {
  force?: boolean;
  includeLidarr?: boolean;
  changedPaths?: string[] | null;
};

export function resolveLibraryScanChangedPaths(
  registry: LibraryScanRegistry | null | undefined,
  force = false,
) {
  if (force) return null;
  return Array.isArray(registry?.changedPaths) ? registry.changedPaths : null;
}
