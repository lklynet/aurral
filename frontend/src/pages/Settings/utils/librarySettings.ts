import type { StoredIntegrations } from "../../../../../backend/db/helpers/settings.ts";
import type { computeLibraryRootOverlaps } from "../../../../../backend/services/downloadFolderConfig.ts";

type RootOverlapWarning = ReturnType<typeof computeLibraryRootOverlaps>[number];

export function describeLidarrConnectionState({
  lidarr,
  health,
}: {
  lidarr?: StoredIntegrations["lidarr"] | null;
  health?: { lidarr?: { circuitOpen?: boolean } } | null;
}) {
  if (lidarr?.enabled === false) {
    return {
      reason: "disabled",
      title: "Lidarr is off",
      message:
        "Only music in the Library folder is shown. Enable Lidarr and save to restore its music.",
    };
  }
  if (!String(lidarr?.url || "").trim() || !String(lidarr?.apiKey || "").trim()) {
    return null;
  }
  if (health?.lidarr?.circuitOpen === true) {
    return {
      reason: "unreachable",
      title: "Lidarr is unreachable",
      message:
        "Requests paused after repeated failures. Check Lidarr and test the connection. Its music stays in the Library.",
    };
  }
  return null;
}

function describeRootOverlap(warning: RootOverlapWarning) {
  const root = warning?.lidarrRoot;
  if (warning?.type === "equal") return `The Lidarr root ${root} is the Library folder.`;
  if (warning?.type === "nested-b-in-a") {
    return `The Lidarr root ${root} is inside the Library folder.`;
  }
  if (warning?.type === "nested-a-in-b") {
    return `The Library folder is inside the Lidarr root ${root}.`;
  }
  return warning?.message || "";
}

export function describeRootOverlapWarning(rootWarnings: RootOverlapWarning[] | null | undefined) {
  const warnings = Array.isArray(rootWarnings) ? rootWarnings : [];
  if (warnings.length === 0) return null;
  return {
    summary:
      "Use separate folders. Lidarr can rename, import, or delete files in overlapping folders. Aurral leaves Lidarr files untouched.",
    details: warnings.map(describeRootOverlap).filter(Boolean),
  };
}
