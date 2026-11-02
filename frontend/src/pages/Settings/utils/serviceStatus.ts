import type { ServiceStatus } from "../SettingsLayout";
import type { normalizeSettings } from "../utils";

export function providerStatus(enabled: boolean, configured: boolean): ServiceStatus {
  if (enabled && configured) return { label: "On" };
  if (enabled) return { label: "Needs setup", tone: "error" };
  if (configured) return { label: "Off", tone: "muted" };
  return { label: "Not set up", tone: "muted" };
}

export const configuredStatus = (configured: boolean): ServiceStatus =>
  configured ? { label: "On" } : { label: "Not set up", tone: "muted" };

type Integrations = ReturnType<typeof normalizeSettings>["integrations"];

export const connectedServices = ({ navidrome, plex, jellyfin, lidarr }: Integrations) => ({
  navidrome: Boolean(navidrome.url && navidrome.username && navidrome.password),
  plex: Boolean(plex.token && plex.url),
  jellyfin: Boolean(jellyfin.url && jellyfin.apiKey && jellyfin.userId),
  lidarr: lidarr.enabled !== false && Boolean(lidarr.url && lidarr.apiKey),
});
