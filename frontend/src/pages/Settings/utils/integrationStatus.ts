export function getProviderStatus(enabled: boolean, configured: boolean) {
  if (enabled && configured) {
    return { label: "Enabled", className: "is-enabled" };
  }
  if (enabled) {
    return { label: "Needs setup", className: "is-warning" };
  }
  if (configured) {
    return { label: "Disabled", className: "is-disabled" };
  }
  return { label: "Not configured", className: "is-muted" };
}

export function getConfiguredStatus(configured: boolean) {
  if (configured) {
    return { label: "Enabled", className: "is-enabled" };
  }
  return { label: "Not configured", className: "is-muted" };
}

export function getIndexerStatus(
  indexer: { enabledInProwlarr?: boolean } | null | undefined,
  enabled: boolean,
) {
  if (indexer?.enabledInProwlarr === false) {
    return { label: "Disabled in Prowlarr", className: "is-muted" };
  }
  if (enabled) {
    return { label: "Enabled", className: "is-enabled" };
  }
  return { label: "Disabled", className: "is-disabled" };
}
