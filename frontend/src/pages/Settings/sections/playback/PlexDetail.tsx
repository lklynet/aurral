import { useState } from "react";
import { queryOptions, useQuery, useQueryClient } from "@tanstack/react-query";
import { parseResponse } from "hono/client";
import { DotLoader } from "../../../../components/DotLoader";
import DownloadFolderField from "../../../../components/DownloadFolderField";
import { playbackSettingsClient } from "../../../../utils/api/clients/playbackSettings.ts";
import { SettingsAdapterFields } from "../../components/SettingsAdapterFields";
import { Select } from "../../../../components/Select";
import { readApiError } from "../../utils/apiError.ts";
import { pickBestPlexConnection, resolvePlexConnectionUrl } from "../../utils/plexConnections";
import { useServerSettings } from "../../SettingsProviders";
import { SettingsLink } from "../../settingsRoute";
import {
  SettingsActions,
  SettingsGroup,
  SettingsNote,
  SettingsPage,
  SettingsRow,
} from "../../SettingsLayout";
import { usePlaybackTest } from "./usePlaybackTest";

type PlexSettings = ReturnType<typeof useServerSettings>["settings"]["integrations"]["plex"];

const SIGN_IN_POLL_MS = 2000;
const SIGN_IN_TIMEOUT_MS = 3 * 60 * 1000;

const plexServersQuery = (token: string) =>
  queryOptions({
    queryKey: ["settings", "plex", "servers", token],
    queryFn: ({ signal }) =>
      parseResponse(
        playbackSettingsClient.plex.resources.$post({ json: { token } }, { init: { signal } }),
      ).then(({ servers }) => (Array.isArray(servers) ? servers : [])),
  });

async function waitForPlexToken(pinId: number | string, code: string) {
  const deadline = Date.now() + SIGN_IN_TIMEOUT_MS;
  while (Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, SIGN_IN_POLL_MS));
    try {
      const result = await parseResponse(
        playbackSettingsClient.plex.auth.check.$post({ json: { pinId, code } }),
      );
      if ("token" in result && result.token) {
        return { token: result.token, plexUsername: result.plexUsername || null };
      }
    } catch {}
  }
  return null;
}

export function PlexDetail() {
  const {
    settings,
    originalSettings,
    playbackSettings,
    updateSettings,
    hasUnsavedChanges,
    handleSaveSettings,
    showSuccess,
    showError,
    showInfo,
  } = useServerSettings();
  const queryClient = useQueryClient();
  const connection = usePlaybackTest("plex", "Check the Plex settings and retry.");
  const [signingIn, setSigningIn] = useState(false);
  const [syncing, setSyncing] = useState(false);
  const plex = settings.integrations.plex;
  const saved = originalSettings?.integrations.plex;
  const configured = Boolean(plex.token && plex.url);
  const sectionId = plex.mainLibrarySectionId || "";
  const mapping = settings.pathMappings.find((entry) => entry?.source === "plex") ?? null;

  const servers = useQuery({ ...plexServersQuery(plex.token || ""), enabled: Boolean(plex.token) });
  const libraries = useQuery({
    queryKey: ["settings", "plex", "libraries", saved?.url],
    queryFn: ({ signal }) =>
      parseResponse(playbackSettingsClient.plex.libraries.$get({}, { init: { signal } })).then(
        ({ libraries }) => (Array.isArray(libraries) ? libraries : []),
      ),
    enabled: Boolean(saved?.url && saved.token),
  });
  const access = useQuery({
    queryKey: ["settings", "plex", "access-check", sectionId],
    queryFn: ({ signal }) =>
      parseResponse(
        playbackSettingsClient.plex.libraries[":sectionId"]["access-check"].$get(
          { param: { sectionId: encodeURIComponent(sectionId) } },
          { init: { signal } },
        ),
      ),
    enabled: Boolean(sectionId),
  });

  const serverList = servers.data ?? [];
  const checkingAccess = Boolean(sectionId) && access.isFetching;
  const accessResult = sectionId && !checkingAccess ? access.data : undefined;
  const reportedPath =
    accessResult && "reportedPath" in accessResult ? accessResult.reportedPath : "";
  const unreadable = Boolean(
    accessResult && "accessible" in accessResult && !accessResult.accessible,
  );
  const accessNote =
    accessResult && "reason" in accessResult
      ? accessResult.reason
      : sectionId && !checkingAccess && access.isError
        ? "Couldn't check access."
        : null;

  const updatePlex = (patch: Partial<PlexSettings>) => {
    connection.reset();
    updateSettings({
      ...settings,
      integrations: { ...settings.integrations, plex: { ...plex, ...patch } },
    });
  };

  const updateLibraryPath = (localPath: string) => {
    const others = settings.pathMappings.filter((entry) => entry?.source !== "plex");
    const local = localPath.trim();
    updateSettings({
      ...settings,
      pathMappings: local
        ? [...others, { source: "plex", remote: reportedPath || mapping?.remote || "", local }]
        : others,
    });
  };

  const selectServer = (clientIdentifier: string) => {
    const server = serverList.find((entry) => entry.clientIdentifier === clientIdentifier);
    if (!server) return;
    const url = resolvePlexConnectionUrl(pickBestPlexConnection(server));
    if (!url) {
      showError("Selected Plex server has no usable connection.");
      return;
    }
    updatePlex({ url, machineIdentifier: server.clientIdentifier });
    showInfo(`Selected "${server.name}".`);
  };

  const signIn = async () => {
    setSigningIn(true);
    try {
      const { pinId, code, authUrl, clientId } = await parseResponse(
        playbackSettingsClient.plex.auth.pin.$post({ json: {} }),
      );
      const popup = window.open(authUrl, "plex-auth", "width=600,height=700");
      const account = await waitForPlexToken(pinId, code);
      if (popup && !popup.closed) popup.close();
      if (!account) {
        showError("Plex sign-in timed out. Try again.");
        return;
      }
      const owned = (await queryClient.fetchQuery(plexServersQuery(account.token))).filter(
        (server) => server.owned,
      );
      const only = owned.length === 1 ? owned[0] : null;
      const url = only ? resolvePlexConnectionUrl(pickBestPlexConnection(only)) : "";
      updatePlex({
        ...account,
        ...(clientId ? { clientId } : {}),
        ...(only && url ? { url, machineIdentifier: only.clientIdentifier } : {}),
      });
      showSuccess(
        only && url
          ? `Connected to Plex. Selected "${only.name}".`
          : "Signed in to Plex. Select your server below.",
      );
    } catch (error) {
      const failure = readApiError(error);
      showError(`Plex sign-in failed: ${failure.message || failure.error || failure.text}`);
    } finally {
      setSigningIn(false);
    }
  };

  const signOut = () => {
    updatePlex({ token: "", url: "", machineIdentifier: "" });
    showInfo("Plex disconnected.");
  };

  const sync = async () => {
    setSyncing(true);
    try {
      if (hasUnsavedChanges && !(await handleSaveSettings())) return;
      const result = await parseResponse(playbackSettingsClient.plex.sync.$post());
      const synced = "playlists" in result ? result : null;
      if (synced?.scanInProgress) {
        showInfo(
          "Library ready. Plex is scanning. Playlists fill automatically as tracks are indexed.",
        );
      } else {
        showSuccess(
          `Synced to Plex: ${synced?.playlists.length ?? 0} playlist(s) from ${synced?.indexedTracks ?? 0} indexed track(s).`,
        );
      }
    } catch (error) {
      const failure = readApiError(error);
      showError(`Plex sync failed: ${failure.message || failure.error || failure.text}`);
    } finally {
      setSyncing(false);
    }
  };

  return (
    <SettingsPage title="Plex" back="Playback">
      <SettingsGroup title="Account">
        <SettingsRow
          label="Plex account"
          help={
            plex.token
              ? plex.plexUsername
                ? `Signed in as ${plex.plexUsername}.`
                : "Signed in."
              : undefined
          }
        >
          <button
            type="button"
            className="btn btn-secondary btn-sm"
            onClick={signIn}
            disabled={signingIn}
          >
            {signingIn ? <DotLoader size="xs" label={null} /> : null}
            {signingIn ? "Waiting for Plex…" : plex.token ? "Reconnect" : "Connect Plex account"}
          </button>
          {plex.token ? (
            <button type="button" className="btn btn-ghost btn-sm" onClick={signOut}>
              Disconnect
            </button>
          ) : null}
        </SettingsRow>
      </SettingsGroup>

      <SettingsGroup title="Connection">
        {plex.token ? (
          <SettingsRow label="Server" htmlFor="plex-server">
            <Select
              id="plex-server"
              value={plex.machineIdentifier || ""}
              onChange={selectServer}
              options={[
                {
                  value: "",
                  disabled: true,
                  label: servers.isFetching
                    ? "Loading servers…"
                    : serverList.length
                      ? "Select a server"
                      : "No servers found",
                },
                ...serverList.flatMap((server) =>
                  server.clientIdentifier
                    ? [
                        {
                          value: server.clientIdentifier,
                          label: `${server.name}${server.owned ? "" : " (shared)"}`,
                        },
                      ]
                    : [],
                ),
              ]}
            />
          </SettingsRow>
        ) : null}
        <SettingsAdapterFields
          definition={playbackSettings?.plex}
          settings={plex}
          onChange={updatePlex}
        />
        <SettingsActions status={connection.status}>
          <button
            type="button"
            className="btn btn-secondary btn-sm"
            onClick={() => connection.test(plex)}
            disabled={connection.testing || !configured}
          >
            {connection.testing ? <DotLoader size="xs" label={null} /> : null}
            Test connection
          </button>
        </SettingsActions>
      </SettingsGroup>

      <SettingsGroup title="Libraries">
        <SettingsRow
          label="Aurral Library path in Plex"
          htmlFor="plex-downloads-path"
          help="Only if Plex sees downloads at a different path."
        >
          <DownloadFolderField
            id="plex-downloads-path"
            value={plex.downloadsPath || ""}
            suggestFolder={false}
            createOnConfirm={false}
            onChange={(path) => updatePlex({ downloadsPath: path })}
          />
        </SettingsRow>
        <SettingsRow
          label="Main library"
          htmlFor="plex-main-library"
          help="Include tracks from an existing Plex library."
        >
          <Select
            id="plex-main-library"
            value={sectionId}
            onChange={(mainLibrarySectionId) => updatePlex({ mainLibrarySectionId })}
            disabled={!configured}
            options={[
              { value: "", label: "None" },
              ...(libraries.data ?? []).flatMap((library) =>
                library.key ? [{ value: library.key, label: library.title }] : [],
              ),
            ]}
          />
        </SettingsRow>
        {checkingAccess ? (
          <p className="settings-loading">
            <DotLoader size="xs" label={null} /> Checking whether Aurral can read this library…
          </p>
        ) : null}
        {unreadable ? (
          <SettingsNote tone="warning">
            Aurral can&apos;t read <span className="settings-code">{reportedPath}</span>. Map it to
            a local path below.
          </SettingsNote>
        ) : null}
        {accessNote ? (
          <SettingsNote>
            {accessNote} You can add a path mapping in{" "}
            <SettingsLink to="downloads" className="settings-link">
              Downloads
            </SettingsLink>
            .
          </SettingsNote>
        ) : null}
        {sectionId && (mapping || unreadable) ? (
          <SettingsRow
            label="Local path"
            htmlFor="plex-library-local-path"
            help="Where Aurral reads this library. Clear it to remove the mapping."
          >
            <DownloadFolderField
              id="plex-library-local-path"
              value={mapping?.local || ""}
              suggestFolder={false}
              createOnConfirm={false}
              onChange={updateLibraryPath}
            />
          </SettingsRow>
        ) : null}
      </SettingsGroup>

      <SettingsGroup title="Sync">
        <SettingsRow
          label="Sync to Plex"
          help="Saves settings, creates the Plex library and flow playlists, then scans."
        >
          <button
            type="button"
            className="btn btn-primary btn-sm"
            onClick={sync}
            disabled={syncing || !configured}
          >
            {syncing ? <DotLoader size="xs" label={null} /> : null}
            {syncing ? "Syncing…" : "Sync now"}
          </button>
        </SettingsRow>
      </SettingsGroup>
    </SettingsPage>
  );
}
