interface OnboardingLidarr {
  url: string;
  apiKey: string;
  qualityProfileId: number | null;
  metadataProfileId: number | null;
}

type OnboardingPayload = {
  authUser: string;
  authPassword: string | undefined;
  security: { localNetworkBypass: { enabled: boolean } };
  lidarr?: OnboardingLidarr & { defaultMonitorOption: "none"; searchOnAdd: false };
  downloadFolderPath?: string;
};

export function buildOnboardingPayload({
  authUser,
  authPassword,
  localNetworkBypass,
  lidarr = null,
  downloadFolderPath = "",
}: {
  authUser: string;
  authPassword: string;
  localNetworkBypass: boolean;
  lidarr?: OnboardingLidarr | null;
  downloadFolderPath?: string;
}) {
  const payload: OnboardingPayload = {
    authUser: String(authUser || "").trim() || "admin",
    authPassword: authPassword || undefined,
    security: {
      localNetworkBypass: { enabled: localNetworkBypass === true },
    },
  };
  if (lidarr) {
    payload.lidarr = {
      url: String(lidarr.url || "")
        .trim()
        .replace(/\/+$/, ""),
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
