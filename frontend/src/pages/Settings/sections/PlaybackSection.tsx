import { DotLoader } from "../../../components/DotLoader";
import { SettingsAdapterFields } from "../components/SettingsAdapterFields";
import { useServerSettings } from "../SettingsProviders";
import { configuredStatus } from "../utils/serviceStatus";
import {
  SettingsActions,
  SettingsGroup,
  SettingsPage,
  SettingsServiceRow,
  useSettingsItem,
} from "../SettingsLayout";
import { PlexDetail } from "./playback/PlexDetail";
import { PLAYBACK_SERVERS, usePlaybackTest } from "./playback/usePlaybackTest";

type AdapterServer = "navidrome" | "jellyfin";

function AdapterServerDetail({
  server,
  ready,
  failureHint,
  note,
}: {
  server: AdapterServer;
  ready: boolean;
  failureHint: string;
  note?: string;
}) {
  const { settings, playbackSettings, updateSettings } = useServerSettings();
  const connection = usePlaybackTest(server, failureHint);
  const config = settings.integrations[server];

  return (
    <SettingsPage title={PLAYBACK_SERVERS[server]} back="Playback">
      <SettingsGroup title="Connection" note={note}>
        <SettingsAdapterFields
          definition={playbackSettings?.[server]}
          settings={config}
          onChange={(patch) => {
            connection.reset();
            updateSettings({
              ...settings,
              integrations: { ...settings.integrations, [server]: { ...config, ...patch } },
            });
          }}
        />
        <SettingsActions status={connection.status}>
          <button
            type="button"
            className="btn btn-secondary btn-sm"
            onClick={() => connection.test(config)}
            disabled={connection.testing || !ready}
          >
            {connection.testing ? <DotLoader size="xs" label={null} /> : null}
            Test connection
          </button>
        </SettingsActions>
      </SettingsGroup>
    </SettingsPage>
  );
}

export function PlaybackSection() {
  const { settings } = useServerSettings();
  const item = useSettingsItem();
  const { navidrome, plex, jellyfin } = settings.integrations;
  const navidromeReady = Boolean(navidrome.url && navidrome.username && navidrome.password);
  const jellyfinReady = Boolean(jellyfin.url && jellyfin.apiKey && jellyfin.userId);

  if (item === "plex") return <PlexDetail />;
  if (item === "navidrome") {
    return (
      <AdapterServerDetail
        server="navidrome"
        ready={navidromeReady}
        failureHint="Check the URL and credentials, then retry."
        note="Any Subsonic server works."
      />
    );
  }
  if (item === "jellyfin") {
    return (
      <AdapterServerDetail
        server="jellyfin"
        ready={jellyfinReady}
        failureHint="Check the URL, API key, and user ID, then retry."
      />
    );
  }

  return (
    <SettingsPage title="Playback">
      <SettingsGroup title="Playback servers" note="Where Aurral publishes flows and playlists.">
        <SettingsServiceRow
          to="playback/navidrome"
          name="Navidrome"
          status={configuredStatus(Boolean(navidrome.url))}
        />
        <SettingsServiceRow
          to="playback/plex"
          name="Plex"
          status={configuredStatus(Boolean(plex.token && plex.url))}
        />
        <SettingsServiceRow
          to="playback/jellyfin"
          name="Jellyfin"
          status={configuredStatus(jellyfinReady)}
        />
      </SettingsGroup>
    </SettingsPage>
  );
}
