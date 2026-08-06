import { useState } from "react";
import { resetDiscoveryFeedback } from "../../../utils/api/endpoints/discovery.js";
import { SettingsInput, SettingsSelect } from "./SettingsField";
import { PlexSelfLinkSection } from "./PlexSelfLinkSection";

import { Link } from "react-router-dom";
import { RotateCcw } from "lucide-react";
export function SettingsAccountTab({
  listenHistoryProvider,
  setListenHistoryProvider,
  listenHistoryUsername,
  setListenHistoryUsername,
  listenHistoryUrl,
  setListenHistoryUrl,
  lidarrConfigured,
  lidarrRootFolders,
  lidarrQualityProfiles,
  lidarrRootFolderPath,
  setLidarrRootFolderPath,
  lidarrQualityProfileId,
  setLidarrQualityProfileId,
  loading,
  handleSave,
  hidePanelHeader = false,
  showSuccess,
  showError,
}) {
  const [resettingTastes, setResettingTastes] = useState(false);

  const handleResetDiscoveryTastes = async () => {
    if (resettingTastes) return;
    const confirmed = window.confirm(
      "Reset all More like this and Less like this preferences? Blocked artists will be kept.",
    );
    if (!confirmed) return;
    setResettingTastes(true);
    try {
      await resetDiscoveryFeedback();
      showSuccess?.("Discovery tastes reset");
    } catch (error) {
      showError?.(error.response?.data?.message || "Failed to reset discovery tastes");
    } finally {
      setResettingTastes(false);
    }
  };

  if (loading) {
    return (
      <div className="settings-page__panel">
        <p>Loading...</p>
      </div>
    );
  }

  const profileSummary = (() => {
    if (listenHistoryProvider === "koito" && listenHistoryUrl) {
      return `Koito: ${listenHistoryUrl}`;
    }
    if (listenHistoryProvider === "listenbrainz" && listenHistoryUsername) {
      return `ListenBrainz: ${listenHistoryUsername}`;
    }
    if (listenHistoryProvider === "lastfm" && listenHistoryUsername) {
      return `Last.fm: ${listenHistoryUsername}`;
    }
    return null;
  })();

  return (
    <div className="settings-page__panel">
      {!hidePanelHeader && <h2 className="settings-page__panel-title">Profile</h2>}
      <form
        onSubmit={(e) => {
          e.preventDefault();
          handleSave();
        }}
        className="settings-page__form"
        autoComplete="off"
      >
        <div className="settings-page__section">
          <div className="settings-page__section-header">
            <h3 className="settings-page__section-title">Listening History</h3>
            <div className="settings-page__inline-row">
              {profileSummary && (
                <span className="settings-page__muted-copy">{profileSummary}</span>
              )}
            </div>
          </div>
          <fieldset className="settings-page__fields">
            <div>
              <label className="artist-field-label">Provider</label>
              <SettingsSelect
                value={listenHistoryProvider}
                onChange={(e) => setListenHistoryProvider(e.target.value)}
              >
                <option value="lastfm">Last.fm</option>
                <option value="listenbrainz">ListenBrainz</option>
                <option value="koito">Koito</option>
              </SettingsSelect>
            </div>
            {listenHistoryProvider === "koito" ? (
              <div>
                <label className="artist-field-label">Koito URL</label>
                <SettingsInput
                  type="url"
                  required
                  placeholder="https://koito.example.com:4110"
                  autoComplete="off"
                  value={listenHistoryUrl}
                  onChange={(e) => setListenHistoryUrl(e.target.value)}
                />
                <p className="settings-page__hint">
                  Your self-hosted Koito instance URL. Aurral reads top artists from Koito&apos;s
                  chart API to power personalized discovery.
                </p>
              </div>
            ) : (
              <div>
                <label className="artist-field-label">Username</label>
                <SettingsInput
                  type="text"
                  placeholder={
                    listenHistoryProvider === "listenbrainz"
                      ? "Your ListenBrainz username"
                      : "Your Last.fm username"
                  }
                  autoComplete="off"
                  value={listenHistoryUsername}
                  onChange={(e) => setListenHistoryUsername(e.target.value)}
                />
                <p className="settings-page__hint">
                  Connect Last.fm or ListenBrainz for personalized discovery recommendations. Admin
                  API defaults are in{" "}
                  <Link to="/settings/connect" className="settings-page__link">
                    Settings → Connect
                  </Link>
                  .
                </p>
              </div>
            )}
          </fieldset>
        </div>

        <PlexSelfLinkSection showSuccess={showSuccess} showError={showError} />

        <div className="settings-page__section">
          <div className="settings-page__section-intro">
            <h3 className="settings-page__section-title">Library Defaults</h3>
            <p className="settings-page__section-note">
              These defaults apply to one-click artist adds unless you override them from the
              Customize action on the artist page.
            </p>
          </div>

          <fieldset
            disabled={!lidarrConfigured}
            className={`settings-page__field-stack--lg${lidarrConfigured ? "" : " settings-page__is-dimmed"}`}
          >
            <div>
              <label className="artist-field-label">Default Root Folder</label>
              <SettingsSelect
                value={lidarrRootFolderPath}
                onChange={(e) => setLidarrRootFolderPath(e.target.value)}
              >
                <option value="">Use automatic default</option>
                {lidarrRootFolders.map((folder) => (
                  <option key={folder.path} value={folder.path}>
                    {folder.path}
                  </option>
                ))}
              </SettingsSelect>
            </div>

            <div>
              <label className="artist-field-label">Default Quality Profile</label>
              <SettingsSelect
                value={lidarrQualityProfileId}
                onChange={(e) => setLidarrQualityProfileId(e.target.value)}
              >
                <option value="">Use automatic default</option>
                {lidarrQualityProfiles.map((profile) => (
                  <option key={profile.id} value={String(profile.id)}>
                    {profile.name}
                  </option>
                ))}
              </SettingsSelect>
            </div>
          </fieldset>

          {!lidarrConfigured && (
            <p className="settings-page__footnote">
              Lidarr must be configured by an admin in{" "}
              <Link to="/settings/lidarr" className="settings-page__link">
                Settings → Lidarr
              </Link>{" "}
              before personal library defaults can be saved.
            </p>
          )}
        </div>

        <div className="settings-page__section">
          <div className="settings-page__section-intro">
            <h3 className="settings-page__section-title">Discovery Tastes</h3>
            <p className="settings-page__section-note">
              Clear your More like this and Less like this feedback so recommendations start fresh.
              Manage hard exclusions on the <Link to="/blocklist" className="settings-page__link">Blocked Artists</Link> page.
            </p>
          </div>
          <button
            type="button"
            onClick={handleResetDiscoveryTastes}
            disabled={resettingTastes}
            className="btn btn-secondary"
          >
            <RotateCcw className={`artist-icon-xs${resettingTastes ? " animate-spin" : ""}`} />
            {resettingTastes ? "Resetting..." : "Reset Discovery Tastes"}
          </button>
        </div>
      </form>
    </div>
  );
}
