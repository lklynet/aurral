import { useState } from "react";
import { parseResponse } from "hono/client";
import { playbackSettingsClient } from "../../../../utils/api/clients/playbackSettings.ts";
import { readApiError } from "../../utils/apiError.ts";
import { useServerSettings } from "../../SettingsProviders";

export const PLAYBACK_SERVERS = {
  navidrome: "Navidrome",
  plex: "Plex",
  jellyfin: "Jellyfin",
} as const;

export type PlaybackServer = keyof typeof PLAYBACK_SERVERS;

type TestStatus = { tone: "success" | "error"; message: string };

export function usePlaybackTest(server: PlaybackServer, failureHint: string) {
  const { handleSaveSettings, showSuccess, showError } = useServerSettings();
  const [testing, setTesting] = useState(false);
  const [status, setStatus] = useState<TestStatus | null>(null);
  const label = PLAYBACK_SERVERS[server];

  const test = async (json: Record<string, unknown>) => {
    setStatus(null);
    setTesting(true);
    try {
      if (!(await handleSaveSettings())) {
        setStatus({
          tone: "error",
          message: "Couldn't save settings. Fix the save error and retry.",
        });
        return;
      }
      await parseResponse(
        playbackSettingsClient.playback[":key"].test.$post({ param: { key: server }, json }),
      );
      setStatus({ tone: "success", message: "Connected." });
      showSuccess(`Connected to ${label}.`);
    } catch (error) {
      setStatus({ tone: "error", message: `Connection failed. ${failureHint}` });
      const failure = readApiError(error);
      showError(`${label} connection failed: ${failure.message || failure.error || failure.text}`);
    } finally {
      setTesting(false);
    }
  };

  return { testing, status, test, reset: () => setStatus(null) };
}
