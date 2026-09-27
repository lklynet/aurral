export function buildOnboardingPayload({
  authUser,
  authPassword,
  localNetworkBypass,
  lidarr = null,
  downloadFolderPath = "",
}) {
  const payload = {
    authUser: String(authUser || "").trim() || "admin",
    authPassword: authPassword || undefined,
    security: {
      localNetworkBypass: { enabled: localNetworkBypass === true },
    },
  };
  if (lidarr) {
    payload.lidarr = {
      url: String(lidarr.url || "").trim().replace(/\/+$/, ""),
      apiKey: String(lidarr.apiKey || "").trim(),
      qualityProfileId: lidarr.qualityProfileId ?? null,
      metadataProfileId: lidarr.metadataProfileId ?? null,
      defaultMonitorOption: "none",
      searchOnAdd: false,
    };
    return payload;
  }
  const folder = String(downloadFolderPath || "").trim();
  if (folder) payload.downloadFolderPath = folder;
  return payload;
}
