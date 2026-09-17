export function resolveLibraryScanChangedPaths(registry, force = false) {
  if (force) return null;
  return Array.isArray(registry?.changedPaths) ? registry.changedPaths : null;
}
