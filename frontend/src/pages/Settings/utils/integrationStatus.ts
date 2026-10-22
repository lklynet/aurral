export function getProviderStatus(enabled, configured) {
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

export function getConfiguredStatus(configured) {
  if (configured) {
    return { label: "Enabled", className: "is-enabled" };
  }
  return { label: "Not configured", className: "is-muted" };
}

export function getIndexerStatus(indexer, enabled) {
  if (indexer?.enabledInProwlarr === false) {
    return { label: "Disabled in Prowlarr", className: "is-muted" };
  }
  if (enabled) {
    return { label: "Enabled", className: "is-enabled" };
  }
  return { label: "Disabled", className: "is-disabled" };
}
