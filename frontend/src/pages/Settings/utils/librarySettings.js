const MEDIA_STAYS_VISIBLE = "Indexed Lidarr media stays visible in your library.";

export function describeLidarrConnectionState({ lidarr, health }) {
  if (lidarr?.enabled === false) {
    return {
      reason: "disabled",
      title: "Lidarr is disabled",
      message: `${MEDIA_STAYS_VISIBLE} Turn Lidarr on to use Lidarr actions again.`,
    };
  }
  if (!String(lidarr?.url || "").trim() || !String(lidarr?.apiKey || "").trim()) {
    return {
      reason: "not-configured",
      title: "Lidarr is not configured",
      message: `${MEDIA_STAYS_VISIBLE} Enter the server URL and API key to use Lidarr actions.`,
    };
  }
  if (health?.lidarr?.circuitOpen === true) {
    return {
      reason: "unreachable",
      title: "Lidarr is unreachable",
      message: `${MEDIA_STAYS_VISIBLE} Aurral paused Lidarr requests after repeated failures. Check that Lidarr is running, then test the connection.`,
    };
  }
  return null;
}

function describeRootOverlap(warning) {
  const root = warning?.lidarrRoot;
  if (warning?.type === "equal") return `The Lidarr root ${root} is the Aurral download folder.`;
  if (warning?.type === "nested-b-in-a") {
    return `The Lidarr root ${root} is inside the Aurral download folder.`;
  }
  if (warning?.type === "nested-a-in-b") {
    return `The Aurral download folder is inside the Lidarr root ${root}.`;
  }
  return warning?.message || "";
}

export function describeRootOverlapWarning(rootWarnings) {
  const warnings = Array.isArray(rootWarnings) ? rootWarnings : [];
  if (warnings.length === 0) return null;
  return {
    summary:
      "Overlapping roots are allowed, but Lidarr can rename, import, or delete files under an overlapping root.",
    details: warnings.map(describeRootOverlap).filter(Boolean),
  };
}
