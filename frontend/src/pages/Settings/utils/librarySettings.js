export function describeLidarrConnectionState({ lidarr, health }) {
  if (lidarr?.enabled === false) {
    return {
      reason: "disabled",
      title: "Lidarr is off",
      message: "Only music in the Downloads Folder is shown. Enable Lidarr and save to restore its music.",
    };
  }
  if (!String(lidarr?.url || "").trim() || !String(lidarr?.apiKey || "").trim()) {
    return null;
  }
  if (health?.lidarr?.circuitOpen === true) {
    return {
      reason: "unreachable",
      title: "Lidarr is unreachable",
      message: "Requests paused after repeated failures. Check Lidarr and test the connection. Its music stays in the Library.",
    };
  }
  return null;
}

function describeRootOverlap(warning) {
  const root = warning?.lidarrRoot;
  if (warning?.type === "equal") return `The Lidarr root ${root} is the Downloads Folder.`;
  if (warning?.type === "nested-b-in-a") {
    return `The Lidarr root ${root} is inside the Downloads Folder.`;
  }
  if (warning?.type === "nested-a-in-b") {
    return `The Downloads Folder is inside the Lidarr root ${root}.`;
  }
  return warning?.message || "";
}

export function describeRootOverlapWarning(rootWarnings) {
  const warnings = Array.isArray(rootWarnings) ? rootWarnings : [];
  if (warnings.length === 0) return null;
  return {
    summary:
      "Use separate folders. Lidarr can rename, import, or delete files in overlapping folders. Aurral leaves Lidarr files untouched.",
    details: warnings.map(describeRootOverlap).filter(Boolean),
  };
}
