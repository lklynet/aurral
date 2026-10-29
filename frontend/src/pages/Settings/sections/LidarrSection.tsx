import { useState } from "react";
import { parseResponse } from "hono/client";
import PillToggle from "../../../components/PillToggle";
import { DotLoader } from "../../../components/DotLoader";
import { lidarrCredentialParams } from "../../../utils/api/core.ts";
import { settingsClient } from "../../../utils/api/clients/settings.ts";
import { RootOverlapWarning } from "../components/RootOverlapWarning";
import { SettingsInput, SettingsSelect } from "../components/SettingsField";
import { useServerSettings } from "../SettingsProviders";
import { SettingsLink } from "../settingsRoute";
import { readApiError } from "../utils/apiError.ts";
import { describeLidarrConnectionState } from "../utils/librarySettings";
import type { SettingsState } from "../utils";
import {
  SettingsActions,
  SettingsGroup,
  SettingsNote,
  SettingsPage,
  SettingsRow,
} from "../SettingsLayout";

type LidarrPatch = Partial<SettingsState["integrations"]["lidarr"]>;
type TestStatus = { tone: "success" | "error"; message: string };

const MONITOR_OPTIONS = [
  ["none", "None (artist only)"],
  ["existing", "Existing albums"],
  ["all", "All albums"],
  ["future", "Future albums"],
  ["missing", "Missing albums"],
  ["latest", "Latest album"],
  ["first", "First album"],
] as const;

const parseId = (value: string) => (value ? Number.parseInt(value, 10) : null);

function useLidarr() {
  const { settings, updateSettings } = useServerSettings();
  const { lidarr } = settings.integrations;
  const update = (patch: LidarrPatch) =>
    updateSettings({
      ...settings,
      integrations: { ...settings.integrations, lidarr: { ...lidarr, ...patch } },
    });
  return { lidarr, update };
}

function ConnectionGroup() {
  const { health, refreshLidarrResources, showError } = useServerSettings();
  const { lidarr, update } = useLidarr();
  const [testing, setTesting] = useState(false);
  const [status, setStatus] = useState<TestStatus | null>(null);
  const url = lidarr.url || "";
  const apiKey = lidarr.apiKey || "";
  const reconnect = describeLidarrConnectionState({ lidarr, health });

  const edit = (patch: LidarrPatch) => {
    setStatus(null);
    update(patch);
  };

  const test = async () => {
    setTesting(true);
    setStatus(null);
    const started = performance.now();
    try {
      const result = await parseResponse(
        settingsClient.lidarr.test.$get({ query: lidarrCredentialParams(url, apiKey) }),
      );
      const elapsed = Math.round(performance.now() - started);
      const name =
        result.instanceName && result.instanceName !== "Lidarr" ? ` to ${result.instanceName}` : "";
      setStatus({ tone: "success", message: `Connected${name} in ${elapsed} ms.` });
      try {
        await refreshLidarrResources({ url, apiKey });
      } catch (error) {
        const failure = readApiError(error);
        showError(
          `Connected, but couldn't load folders and profiles: ${failure.message || failure.text}`,
        );
      }
    } catch (error) {
      setStatus({
        tone: "error",
        message: "Connection failed. Check the URL and API key, then retry.",
      });
      const failure = readApiError(error);
      showError(`Lidarr connection failed: ${failure.message || failure.error || failure.text}`);
    } finally {
      setTesting(false);
    }
  };

  return (
    <SettingsGroup
      title="Connection"
      note={
        <>
          Optional. Path access is checked in{" "}
          <SettingsLink to="status/storage" className="settings-link">
            Storage
          </SettingsLink>
          .
        </>
      }
    >
      {reconnect ? (
        <SettingsNote tone="warning">
          {reconnect.title}. {reconnect.message}
        </SettingsNote>
      ) : null}
      <SettingsRow
        label="Enabled"
        htmlFor="lidarr-enabled"
        help="Turning off removes Lidarr music from the Library. Files stay on disk."
      >
        <PillToggle
          id="lidarr-enabled"
          checked={lidarr.enabled !== false}
          aria-label="Enabled"
          onChange={(event) => {
            const enabled = event.target.checked;
            if (
              !enabled &&
              !window.confirm(
                "Turn off Lidarr? Its music leaves the Library and Aurral downloads its own copies of affected playlist tracks. Files stay on disk.",
              )
            ) {
              return;
            }
            update({ enabled });
          }}
        />
      </SettingsRow>
      <SettingsRow label="Server URL" htmlFor="lidarr-url">
        <SettingsInput
          id="lidarr-url"
          type="url"
          placeholder="http://lidarr:8686"
          autoComplete="off"
          value={url}
          onChange={(event) => edit({ url: event.target.value })}
        />
      </SettingsRow>
      <SettingsRow
        label="API key"
        htmlFor="lidarr-api-key"
        help="In Lidarr under Settings, General, Security."
      >
        <SettingsInput
          id="lidarr-api-key"
          type="password"
          autoComplete="off"
          value={apiKey}
          onChange={(event) => edit({ apiKey: event.target.value })}
        />
      </SettingsRow>
      <SettingsRow
        label="External URL"
        htmlFor="lidarr-external-url"
        help="Used for View on Lidarr links."
      >
        <SettingsInput
          id="lidarr-external-url"
          type="url"
          placeholder="https://lidarr.example.com"
          autoComplete="off"
          value={lidarr.externalUrl || ""}
          onChange={(event) => update({ externalUrl: event.target.value })}
        />
      </SettingsRow>
      <SettingsActions status={status}>
        <button
          type="button"
          className="btn btn-secondary btn-sm"
          onClick={test}
          disabled={testing || !url || !apiKey}
        >
          {testing ? <DotLoader size="xs" label={null} /> : null}
          Test connection
        </button>
      </SettingsActions>
    </SettingsGroup>
  );
}

function placeholder(loading: boolean, count: number, empty: string) {
  if (loading) return "Loading…";
  return count === 0 ? "Test the connection to load these" : empty;
}

function DefaultsGroup() {
  const {
    settings,
    lidarrRootFolders,
    loadingLidarrRootFolders,
    lidarrProfiles,
    loadingLidarrProfiles,
    lidarrMetadataProfiles,
    loadingLidarrMetadataProfiles,
    lidarrTags,
    loadingLidarrTags,
  } = useServerSettings();
  const { lidarr, update } = useLidarr();

  return (
    <SettingsGroup
      title="Defaults"
      note="Used when artists are added. People can pick their own root folder and quality profile in Profile."
    >
      <RootOverlapWarning rootWarnings={settings.rootWarnings} />
      <SettingsRow label="Root folder" htmlFor="lidarr-root-folder">
        <SettingsSelect
          id="lidarr-root-folder"
          value={lidarr.rootFolderPath || ""}
          disabled={loadingLidarrRootFolders}
          onChange={(event) => update({ rootFolderPath: event.target.value || null })}
        >
          <option value="">
            {placeholder(
              loadingLidarrRootFolders,
              lidarrRootFolders.length,
              "Select a root folder",
            )}
          </option>
          {lidarrRootFolders.map((folder) => (
            <option key={folder.path} value={folder.path}>
              {folder.path}
            </option>
          ))}
        </SettingsSelect>
      </SettingsRow>
      <SettingsRow label="Quality profile" htmlFor="lidarr-quality-profile">
        <SettingsSelect
          id="lidarr-quality-profile"
          value={lidarr.qualityProfileId ? String(lidarr.qualityProfileId) : ""}
          disabled={loadingLidarrProfiles}
          onChange={(event) => update({ qualityProfileId: parseId(event.target.value) })}
        >
          <option value="">
            {placeholder(loadingLidarrProfiles, lidarrProfiles.length, "Select a profile")}
          </option>
          {lidarrProfiles.map((profile) => (
            <option key={profile.id} value={profile.id}>
              {profile.name}
            </option>
          ))}
        </SettingsSelect>
      </SettingsRow>
      <SettingsRow label="Metadata profile" htmlFor="lidarr-metadata-profile">
        <SettingsSelect
          id="lidarr-metadata-profile"
          value={lidarr.metadataProfileId ? String(lidarr.metadataProfileId) : ""}
          disabled={loadingLidarrMetadataProfiles}
          onChange={(event) => update({ metadataProfileId: parseId(event.target.value) })}
        >
          <option value="">
            {placeholder(
              loadingLidarrMetadataProfiles,
              lidarrMetadataProfiles.length,
              "Select a profile",
            )}
          </option>
          {lidarrMetadataProfiles.map((profile) => (
            <option key={profile.id} value={profile.id}>
              {profile.name}
            </option>
          ))}
        </SettingsSelect>
      </SettingsRow>
      <SettingsRow label="Tag" htmlFor="lidarr-tag">
        <SettingsSelect
          id="lidarr-tag"
          value={lidarr.tagId ? String(lidarr.tagId) : ""}
          disabled={loadingLidarrTags}
          onChange={(event) => update({ tagId: parseId(event.target.value) })}
        >
          <option value="">{loadingLidarrTags ? "Loading…" : "None"}</option>
          {lidarrTags.map((tag) => (
            <option key={tag.id} value={tag.id}>
              {tag.label}
            </option>
          ))}
        </SettingsSelect>
      </SettingsRow>
      <SettingsRow label="Monitor" htmlFor="lidarr-monitor-option">
        <SettingsSelect
          id="lidarr-monitor-option"
          value={lidarr.defaultMonitorOption || "none"}
          onChange={(event) => update({ defaultMonitorOption: event.target.value })}
        >
          {MONITOR_OPTIONS.map(([value, label]) => (
            <option key={value} value={value}>
              {label}
            </option>
          ))}
        </SettingsSelect>
      </SettingsRow>
      <SettingsRow
        label="Search on add"
        htmlFor="lidarr-search-on-add"
        help="Search for missing albums when an artist is added."
      >
        <PillToggle
          id="lidarr-search-on-add"
          checked={lidarr.searchOnAdd === true}
          aria-label="Search on add"
          onChange={(event) => update({ searchOnAdd: event.target.checked })}
        />
      </SettingsRow>
    </SettingsGroup>
  );
}

function CommunityGuideGroup() {
  const { health, applyingCommunityGuide, handleApplyCommunityGuide } = useServerSettings();

  const apply = () => {
    if (
      !window.confirm(
        "Apply the community guide to Lidarr? This updates FLAC quality definitions, adds custom formats, changes the naming scheme, and creates the Aurral - HQ quality profile.",
      )
    ) {
      return;
    }
    void handleApplyCommunityGuide();
  };

  return (
    <SettingsGroup
      title="Community guide"
      note={
        <>
          Recommended quality, format, and naming settings.{" "}
          <a
            href="https://wiki.servarr.com/lidarr/community-guide"
            target="_blank"
            rel="noopener noreferrer"
            className="settings-link"
          >
            Read the guide
          </a>
        </>
      }
    >
      <SettingsActions>
        <button
          type="button"
          className="btn btn-secondary btn-sm"
          onClick={apply}
          disabled={applyingCommunityGuide || !health?.lidarrConfigured}
        >
          {applyingCommunityGuide ? <DotLoader size="xs" label={null} /> : null}
          Apply to Lidarr
        </button>
      </SettingsActions>
    </SettingsGroup>
  );
}

export function LidarrSection() {
  const { lidarr } = useLidarr();
  const connected = lidarr.enabled !== false && Boolean(lidarr.url && lidarr.apiKey);

  return (
    <SettingsPage title="Lidarr">
      <ConnectionGroup />
      {connected ? (
        <>
          <DefaultsGroup />
          <CommunityGuideGroup />
        </>
      ) : null}
    </SettingsPage>
  );
}
