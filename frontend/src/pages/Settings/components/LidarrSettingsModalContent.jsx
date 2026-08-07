import { useState } from "react";
import {
  getLidarrRootFolders,
  getLidarrMetadataProfiles,
  getLidarrProfiles,
  getLidarrTags,
  testLidarrConnection,
} from "../../../utils/api/endpoints/settings.js";

import { Link } from "react-router-dom";
import { RefreshCw } from "lucide-react";
import PillToggle from "../../../components/PillToggle";
import { SettingsInput, SettingsSelect } from "./SettingsField";
import { SettingsArrFieldSet, SettingsArrFormGroup } from "./arr/SettingsArrLayout";
export function LidarrSettingsSection({
  settings,
  updateSettings,
  health,
  lidarrRootFolders,
  loadingLidarrRootFolders,
  setLoadingLidarrRootFolders,
  setLidarrRootFolders,
  lidarrProfiles,
  loadingLidarrProfiles,
  setLoadingLidarrProfiles,
  setLidarrProfiles,
  lidarrMetadataProfiles,
  loadingLidarrMetadataProfiles,
  setLoadingLidarrMetadataProfiles,
  setLidarrMetadataProfiles,
  lidarrTags,
  loadingLidarrTags,
  setLoadingLidarrTags,
  setLidarrTags,
  testingLidarr,
  setTestingLidarr,
  applyingCommunityGuide,
  setShowCommunityGuideModal,
  showSuccess,
  showError,
  showInfo,
}) {
  const [lidarrTestLatencyMs, setLidarrTestLatencyMs] = useState(null);

  const safeLidarrRootFolders = Array.isArray(lidarrRootFolders) ? lidarrRootFolders : [];
  const safeLidarrProfiles = Array.isArray(lidarrProfiles) ? lidarrProfiles : [];
  const safeLidarrMetadataProfiles = Array.isArray(lidarrMetadataProfiles)
    ? lidarrMetadataProfiles
    : [];
  const safeLidarrTags = Array.isArray(lidarrTags) ? lidarrTags : [];

  const updateLidarr = (patch) =>
    updateSettings({
      ...settings,
      integrations: {
        ...settings.integrations,
        lidarr: {
          ...(settings.integrations?.lidarr || {}),
          ...patch,
        },
      },
    });

  const handleTestLidarr = async () => {
    const url = settings.integrations?.lidarr?.url;
    const apiKey = settings.integrations?.lidarr?.apiKey;
    if (!url || !apiKey) {
      showError("Please enter both URL and API key");
      return;
    }
    setTestingLidarr(true);
    setLidarrTestLatencyMs(null);
    const startTime = performance.now();
    try {
      const result = await testLidarrConnection(url, apiKey);
      setLidarrTestLatencyMs(Math.round(performance.now() - startTime));
      if (result.success) {
        showSuccess(`Lidarr connection successful! (${result.instanceName || "Lidarr"})`);
        setLoadingLidarrRootFolders(true);
        setLoadingLidarrProfiles(true);
        setLoadingLidarrMetadataProfiles(true);
        setLoadingLidarrTags(true);
        try {
          const [rootFolders, profiles, metadataProfiles, tags] = await Promise.all([
            getLidarrRootFolders(url, apiKey),
            getLidarrProfiles(url, apiKey),
            getLidarrMetadataProfiles(url, apiKey),
            getLidarrTags(url, apiKey),
          ]);
          const nextRootFolders = Array.isArray(rootFolders) ? rootFolders : [];
          const nextProfiles = Array.isArray(profiles) ? profiles : [];
          const nextMetadataProfiles = Array.isArray(metadataProfiles) ? metadataProfiles : [];
          const nextTags = Array.isArray(tags) ? tags : [];
          setLidarrRootFolders(nextRootFolders);
          setLidarrProfiles(nextProfiles);
          setLidarrMetadataProfiles(nextMetadataProfiles);
          setLidarrTags(nextTags);
          if (nextRootFolders.length > 0) {
            showInfo(`Loaded ${nextRootFolders.length} root folder(s)`);
          }
          if (nextProfiles.length > 0) {
            showInfo(`Loaded ${nextProfiles.length} quality profile(s)`);
          }
          if (nextMetadataProfiles.length > 0) {
            showInfo(`Loaded ${nextMetadataProfiles.length} metadata profile(s)`);
          }
          if (nextTags.length > 0) {
            showInfo(`Loaded ${nextTags.length} tag(s)`);
          }
        } catch {
        } finally {
          setLoadingLidarrRootFolders(false);
          setLoadingLidarrProfiles(false);
          setLoadingLidarrMetadataProfiles(false);
          setLoadingLidarrTags(false);
        }
      } else {
        showError(
          `Connection failed: ${result.message || result.error}${result.details ? `\n${result.details}` : ""}`,
        );
      }
    } catch (err) {
      setLidarrTestLatencyMs(Math.round(performance.now() - startTime));
      const errorMsg = err.response?.data?.message || err.response?.data?.error || err.message;
      showError(`Connection failed: ${errorMsg}`);
    } finally {
      setTestingLidarr(false);
    }
  };

  const refreshingProfilesTags =
    loadingLidarrRootFolders || loadingLidarrProfiles || loadingLidarrMetadataProfiles || loadingLidarrTags;

  const handleRefreshProfilesAndTags = async () => {
    const url = settings.integrations?.lidarr?.url;
    const apiKey = settings.integrations?.lidarr?.apiKey;
    if (!url || !apiKey) {
      showError("Please enter Lidarr URL and API key first");
      return;
    }
    setLoadingLidarrRootFolders(true);
    setLoadingLidarrProfiles(true);
    setLoadingLidarrMetadataProfiles(true);
    setLoadingLidarrTags(true);
    try {
      const [rootFolders, profiles, metadataProfiles, tags] = await Promise.all([
        getLidarrRootFolders(url, apiKey),
        getLidarrProfiles(url, apiKey),
        getLidarrMetadataProfiles(url, apiKey),
        getLidarrTags(url, apiKey),
      ]);
      const nextRootFolders = Array.isArray(rootFolders) ? rootFolders : [];
      const nextProfiles = Array.isArray(profiles) ? profiles : [];
      const nextMetadataProfiles = Array.isArray(metadataProfiles) ? metadataProfiles : [];
      const nextTags = Array.isArray(tags) ? tags : [];
      setLidarrRootFolders(nextRootFolders);
      setLidarrProfiles(nextProfiles);
      setLidarrMetadataProfiles(nextMetadataProfiles);
      setLidarrTags(nextTags);
      if (nextRootFolders.length === 0 && nextProfiles.length === 0 && nextMetadataProfiles.length === 0 && nextTags.length === 0) {
        showInfo("No root folders, profiles, or tags found in Lidarr");
      } else {
        const parts = [];
        if (nextRootFolders.length > 0) {
          parts.push(`${nextRootFolders.length} root folder(s)`);
        }
        if (nextProfiles.length > 0) {
          parts.push(`${nextProfiles.length} quality profile(s)`);
        }
        if (nextMetadataProfiles.length > 0) {
          parts.push(`${nextMetadataProfiles.length} metadata profile(s)`);
        }
        if (nextTags.length > 0) {
          parts.push(`${nextTags.length} tag(s)`);
        }
        showSuccess(`Loaded ${parts.join(", ")}`);
      }
    } catch (err) {
      const errorMsg = err.response?.data?.message || err.response?.data?.error || err.message;
      showError(`Failed to load profiles and tags: ${errorMsg}`);
    } finally {
      setLoadingLidarrRootFolders(false);
      setLoadingLidarrProfiles(false);
      setLoadingLidarrMetadataProfiles(false);
      setLoadingLidarrTags(false);
    }
  };

  return (
    <>
      <div className="settings-page__section">
        <div className="settings-page__section-header">
          <div className="settings-page__section-intro">
            <h3 className="settings-page__section-title">Lidarr</h3>
            <p className="settings-page__section-note">
              Connect Aurral to your Lidarr instance and configure library defaults.
            </p>
          </div>
        </div>
      </div>

      <SettingsArrFieldSet
        legend="Connection"
        actions={
          <>
            <button
              type="button"
              onClick={handleRefreshProfilesAndTags}
              disabled={
                refreshingProfilesTags ||
                !settings.integrations?.lidarr?.url ||
                !settings.integrations?.lidarr?.apiKey
              }
              className="arr-btn"
            >
              <RefreshCw
                className={`artist-icon-sm${refreshingProfilesTags ? " animate-spin" : ""}`}
              />
              {refreshingProfilesTags ? "Refreshing..." : "Refresh profiles/tags"}
            </button>
            <button
              type="button"
              onClick={handleTestLidarr}
              disabled={
                testingLidarr ||
                !settings.integrations?.lidarr?.url ||
                !settings.integrations?.lidarr?.apiKey
              }
              className="arr-btn"
            >
              {testingLidarr ? "Testing..." : "Test connection"}
            </button>
          </>
        }
      >
        <div className="arr-info">
          Music library manager. File access, mounts, and path mappings are checked in{" "}
          <Link to="/settings/system" className="arr-link">
            System
          </Link>
          .
        </div>

        <SettingsArrFormGroup label="Server URL" labelFor="lidarr-url">
          <SettingsInput
            id="lidarr-url"
            type="url"
            placeholder="http://lidarr:8686"
            autoComplete="off"
            value={settings.integrations?.lidarr?.url || ""}
            onChange={(e) => {
              setLidarrTestLatencyMs(null);
              updateLidarr({ url: e.target.value });
            }}
          />
        </SettingsArrFormGroup>

        <SettingsArrFormGroup
          label="API Key"
          labelFor="lidarr-api-key"
          help={
            <>
              Found in Settings &rarr; General &rarr; Security.
              {lidarrTestLatencyMs !== null && (
                <> Last test response time: {lidarrTestLatencyMs} ms.</>
              )}
            </>
          }
        >
          <SettingsInput
            id="lidarr-api-key"
            type="password"
            placeholder="Enter Lidarr API Key"
            autoComplete="off"
            value={settings.integrations?.lidarr?.apiKey || ""}
            onChange={(e) => {
              setLidarrTestLatencyMs(null);
              updateLidarr({ apiKey: e.target.value });
            }}
          />
        </SettingsArrFormGroup>

        <SettingsArrFormGroup
          label="External URL"
          labelFor="lidarr-external-url"
          help='Optional. Used only for browser-facing "View on Lidarr" links.'
        >
          <SettingsInput
            id="lidarr-external-url"
            type="url"
            placeholder="https://lidarr.example.com"
            autoComplete="off"
            value={settings.integrations?.lidarr?.externalUrl || ""}
            onChange={(e) => updateLidarr({ externalUrl: e.target.value })}
          />
        </SettingsArrFormGroup>
      </SettingsArrFieldSet>

      <SettingsArrFieldSet legend="Defaults">
        <SettingsArrFormGroup label="Default Root Folder" labelFor="lidarr-root-folder">
          <SettingsSelect
            id="lidarr-root-folder"
            value={settings.integrations?.lidarr?.rootFolderPath || ""}
            onChange={(e) =>
              updateLidarr({ rootFolderPath: e.target.value || null })
            }
            disabled={loadingLidarrRootFolders}
          >
            <option value="">
              {loadingLidarrRootFolders
                ? "Loading root folders..."
                : safeLidarrRootFolders.length === 0
                  ? "No root folders available (test connection first)"
                  : "Select a root folder"}
            </option>
            {safeLidarrRootFolders.map((folder) => (
              <option key={folder.path} value={folder.path}>
                {folder.path}
              </option>
            ))}
          </SettingsSelect>
          <p className="settings-page__section-note">
            Users can set their own default in Profile → Library Defaults, which overrides
            this instance-wide setting.
          </p>
        </SettingsArrFormGroup>

        <SettingsArrFormGroup label="Default Quality Profile" labelFor="lidarr-quality-profile">
          <SettingsSelect
            id="lidarr-quality-profile"
            value={
              settings.integrations?.lidarr?.qualityProfileId
                ? String(settings.integrations.lidarr.qualityProfileId)
                : ""
            }
            onChange={(e) =>
              updateLidarr({
                qualityProfileId: e.target.value ? parseInt(e.target.value, 10) : null,
              })
            }
            disabled={loadingLidarrProfiles}
          >
            <option value="">
              {loadingLidarrProfiles
                ? "Loading profiles..."
                : safeLidarrProfiles.length === 0
                  ? "No profiles available (test connection first)"
                  : "Select a profile"}
            </option>
            {safeLidarrProfiles.map((profile) => (
              <option key={profile.id} value={profile.id}>
                {profile.name}
              </option>
            ))}
          </SettingsSelect>
          <p className="settings-page__section-note">
            Users can set their own default in Profile → Library Defaults, which overrides
            this instance-wide setting.
          </p>
        </SettingsArrFormGroup>

        <SettingsArrFormGroup label="Default Metadata Profile" labelFor="lidarr-metadata-profile">
          <SettingsSelect
            id="lidarr-metadata-profile"
            value={
              settings.integrations?.lidarr?.metadataProfileId
                ? String(settings.integrations.lidarr.metadataProfileId)
                : ""
            }
            onChange={(e) =>
              updateLidarr({
                metadataProfileId: e.target.value ? parseInt(e.target.value, 10) : null,
              })
            }
            disabled={loadingLidarrMetadataProfiles}
          >
            <option value="">
              {loadingLidarrMetadataProfiles
                ? "Loading profiles..."
                : safeLidarrMetadataProfiles.length === 0
                  ? "No profiles available (test connection first)"
                  : "Select a profile"}
            </option>
            {safeLidarrMetadataProfiles.map((profile) => (
              <option key={profile.id} value={profile.id}>
                {profile.name}
              </option>
            ))}
          </SettingsSelect>
        </SettingsArrFormGroup>

        <SettingsArrFormGroup label="Tag" labelFor="lidarr-tag">
          <SettingsSelect
            id="lidarr-tag"
            value={
              settings.integrations?.lidarr?.tagId ? String(settings.integrations.lidarr.tagId) : ""
            }
            onChange={(e) =>
              updateLidarr({
                tagId: e.target.value ? parseInt(e.target.value, 10) : null,
              })
            }
            disabled={loadingLidarrTags}
          >
            <option value="">
              {loadingLidarrTags
                ? "Loading tags..."
                : safeLidarrTags.length === 0
                  ? "No tags available (test connection first)"
                  : "None"}
            </option>
            {safeLidarrTags.map((tag) => (
              <option key={tag.id} value={tag.id}>
                {tag.label}
              </option>
            ))}
          </SettingsSelect>
        </SettingsArrFormGroup>

        <SettingsArrFormGroup label="Default Monitoring Option" labelFor="lidarr-monitor-option">
          <SettingsSelect
            id="lidarr-monitor-option"
            value={settings.integrations?.lidarr?.defaultMonitorOption || "none"}
            onChange={(e) => updateLidarr({ defaultMonitorOption: e.target.value })}
          >
            <option value="none">None (Artist Only)</option>
            <option value="existing">Existing Albums</option>
            <option value="all">All Albums</option>
            <option value="future">Future Albums</option>
            <option value="missing">Missing Albums</option>
            <option value="latest">Latest Album</option>
            <option value="first">First Album</option>
          </SettingsSelect>
        </SettingsArrFormGroup>

        <SettingsArrFormGroup label="Search on Add">
          <PillToggle
            className="settings-toggle"
            checked={settings.integrations?.lidarr?.searchOnAdd || false}
            onChange={(e) => updateLidarr({ searchOnAdd: e.target.checked })}
            aria-label="Search for missing albums when artists are added"
          />
        </SettingsArrFormGroup>
      </SettingsArrFieldSet>

      <SettingsArrFieldSet legend="Community guide">
        <button
          type="button"
          onClick={() => {
            if (!settings.integrations?.lidarr?.url || !settings.integrations?.lidarr?.apiKey) {
              showError("Please configure Lidarr URL and API key first");
              return;
            }
            setShowCommunityGuideModal(true);
          }}
          disabled={applyingCommunityGuide || !health?.lidarrConfigured}
          className="arr-btn arr-btn--primary"
        >
          {applyingCommunityGuide ? "Applying..." : "Apply Davo's Recommended Settings"}
        </button>
        <p className="arr-form-help arr-form-help--spaced">
          Creates quality profile, updates quality definitions, adds custom formats, and updates
          naming scheme.{" "}
          <a
            href="https://wiki.servarr.com/lidarr/community-guide"
            target="_blank"
            rel="noopener noreferrer"
            className="arr-link"
          >
            Read more
          </a>
        </p>
      </SettingsArrFieldSet>
    </>
  );
}
