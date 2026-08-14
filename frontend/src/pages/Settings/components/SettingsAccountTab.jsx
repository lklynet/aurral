import { useEffect, useState } from "react";
import { resetDiscoveryFeedback } from "../../../utils/api/endpoints/discovery.js";
import {
  getThemePreference,
  setThemePreference,
} from "../../../utils/theme.js";
import { SettingsInput, SettingsSelect } from "./SettingsField";
import { PlexSelfLinkSection } from "./PlexSelfLinkSection";
import { ConnectedAccountsSection } from "./ConnectedAccountsSection";

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
  profileVariant = false,
}) {
  const [resettingTastes, setResettingTastes] = useState(false);
  const [theme, setTheme] = useState(getThemePreference);

  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    if (params.get("connected") === "google") {
      showSuccess?.("Connected your Google account.");
      params.delete("connected");
      const query = params.toString();
      window.history.replaceState(
        null,
        "",
        `${window.location.pathname}${query ? `?${query}` : ""}`,
      );
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

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
      <div className={profileVariant ? "profile-settings" : "settings-page__panel"}>
        <p className="settings-page__muted-copy">Loading…</p>
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
    <div className={profileVariant ? "profile-settings" : "settings-page__panel"}>
      {!hidePanelHeader && <h2 className="settings-page__panel-title">Profile</h2>}
      <form
        onSubmit={(e) => {
          e.preventDefault();
          handleSave();
        }}
        className="settings-page__form"
        autoComplete="off"
      >
        <div className="settings-page__section profile-settings__section">
          <div className="settings-page__section-intro">
            <h3 className="settings-page__section-title">Appearance</h3>
            <p className="settings-page__section-note">
              Choose how Aurral looks on this device.
            </p>
          </div>
          <fieldset className="settings-page__fields profile-settings__fields">
            <div className="profile-settings__field">
              <label className="profile-settings__label" htmlFor="profile-theme">
                Theme
              </label>
              <SettingsSelect
                id="profile-theme"
                value={theme}
                onChange={(event) => setTheme(setThemePreference(event.target.value))}
              >
                <option value="system">System</option>
                <option value="light">Light</option>
                <option value="dark">Dark</option>
              </SettingsSelect>
              <p className="settings-page__hint">
                System follows the appearance setting of your device.
              </p>
            </div>
          </fieldset>
        </div>

        <div className="settings-page__section profile-settings__section">
          <div className="settings-page__section-header">
            <div className="settings-page__section-intro">
              <h3 className="settings-page__section-title">Listening History</h3>
              <p className="settings-page__section-note">
                Connect a listening service to personalize discovery recommendations.
              </p>
            </div>
            {profileSummary ? (
              <span className="profile-settings__section-status">{profileSummary}</span>
            ) : null}
          </div>
          <fieldset className="settings-page__fields profile-settings__fields">
            <div className="profile-settings__field">
              <label className="profile-settings__label" htmlFor="profile-history-provider">
                Provider
              </label>
              <SettingsSelect
                id="profile-history-provider"
                value={listenHistoryProvider}
                onChange={(e) => setListenHistoryProvider(e.target.value)}
              >
                <option value="lastfm">Last.fm</option>
                <option value="listenbrainz">ListenBrainz</option>
                <option value="koito">Koito</option>
              </SettingsSelect>
            </div>
            {listenHistoryProvider === "koito" ? (
              <div className="profile-settings__field">
                <label className="profile-settings__label" htmlFor="profile-history-url">
                  Koito URL
                </label>
                <SettingsInput
                  id="profile-history-url"
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
              <div className="profile-settings__field">
                <label className="profile-settings__label" htmlFor="profile-history-username">
                  Username
                </label>
                <SettingsInput
                  id="profile-history-username"
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

        <ConnectedAccountsSection
          className={profileVariant ? "profile-settings__section" : ""}
          showSuccess={showSuccess}
          showError={showError}
        />

        <PlexSelfLinkSection
          className={profileVariant ? "profile-settings__section" : ""}
          showSuccess={showSuccess}
          showError={showError}
        />

        <div className="settings-page__section profile-settings__section">
          <div className="settings-page__section-intro">
            <h3 className="settings-page__section-title">Library Defaults</h3>
            <p className="settings-page__section-note">
              These defaults apply to one-click artist adds unless you override them from the
              Customize action on the artist page.
            </p>
          </div>

          <fieldset
            disabled={!lidarrConfigured}
            className={`settings-page__field-stack--lg settings-page__fields profile-settings__fields${lidarrConfigured ? "" : " settings-page__is-dimmed"}`}
          >
            <div className="profile-settings__field">
              <label className="profile-settings__label" htmlFor="profile-root-folder">
                Default Root Folder
              </label>
              <SettingsSelect
                id="profile-root-folder"
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

            <div className="profile-settings__field">
              <label className="profile-settings__label" htmlFor="profile-quality-profile">
                Default Quality Profile
              </label>
              <SettingsSelect
                id="profile-quality-profile"
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

        <div className="settings-page__section profile-settings__section">
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
            className="btn btn-secondary btn-sm"
          >
            <RotateCcw className={`artist-icon-xs${resettingTastes ? " animate-spin" : ""}`} />
            {resettingTastes ? "Resetting…" : "Reset Discovery Tastes"}
          </button>
        </div>
      </form>
    </div>
  );
}
