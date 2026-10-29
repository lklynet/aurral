import type { ServiceStatus } from "../SettingsLayout";

export function providerStatus(enabled: boolean, configured: boolean): ServiceStatus {
  if (enabled && configured) return { label: "On" };
  if (enabled) return { label: "Needs setup", tone: "error" };
  if (configured) return { label: "Off", tone: "muted" };
  return { label: "Not set up", tone: "muted" };
}

export const configuredStatus = (configured: boolean): ServiceStatus =>
  configured ? { label: "On" } : { label: "Not set up", tone: "muted" };
