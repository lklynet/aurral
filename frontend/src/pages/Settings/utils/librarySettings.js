export function describeLidarrConnectionState({ lidarr, health }) {
  if (lidarr?.enabled === false) {
    return {
      reason: "disabled",
      title: "Lidarr is off",
      message: "The Library shows only the music in the Downloads Folder. Turn Lidarr on and save to add its music back.",
    };
  }
  if (!String(lidarr?.url || "").trim() || !String(lidarr?.apiKey || "").trim()) {
    return null;
  }
  if (health?.lidarr?.circuitOpen === true) {
    return {
      reason: "unreachable",
      title: "Lidarr is unreachable",
      message: "Lidarr's music stays in the Library. Aurral paused Lidarr requests after repeated failures. Check that Lidarr is running, then test the connection.",
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
      "Use separate folders. While they overlap, Lidarr can rename, import, or delete files in the shared folder, and Aurral leaves files in a Lidarr root folder to Lidarr.",
    details: warnings.map(describeRootOverlap).filter(Boolean),
  };
}
