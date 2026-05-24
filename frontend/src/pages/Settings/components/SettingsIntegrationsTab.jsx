import { useState } from "react";
import { CheckCircle, ChevronDown, Pencil, RefreshCw } from "lucide-react";
import FlipSaveButton from "../../../components/FlipSaveButton";
import {
  getLidarrMetadataProfiles,
  getLidarrProfiles,
  getLidarrTags,
  testLidarrConnection,
} from "../../../utils/api";

export function SettingsIntegrationsTab({
  settings,
  updateSettings,
  health,
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
  hasUnsavedChanges,
  saving,
  handleSaveSettings,
  showSuccess,
  showError,
  showInfo,
}) {
  const [lidarrEditing, setLidarrEditing] = useState(false);
  const [ticketmasterEditing, setTicketmasterEditing] = useState(false);
  const [navidromeEditing, setNavidromeEditing] = useState(false);
  const [lastfmEditing, setLastfmEditing] = useState(false);
  const [collapsedSections, setCollapsedSections] = useState({
    lidarr: false,
    lastfm: true,
    ticketmaster: true,
    navidrome: true,
  });
  const [lidarrTestLatencyMs, setLidarrTestLatencyMs] = useState(null);
  const safeLidarrProfiles = Array.isArray(lidarrProfiles)
    ? lidarrProfiles
    : [];
  const localDiscoveryIncludeRecommendations =
    settings.integrations?.ticketmaster?.localDiscoveryIncludeRecommendations !==
    false;
  const localDiscoveryIncludeTrending =
    settings.integrations?.ticketmaster?.localDiscoveryIncludeTrending !== false;
  const safeLidarrMetadataProfiles = Array.isArray(lidarrMetadataProfiles)
    ? lidarrMetadataProfiles
    : [];
  const safeLidarrTags = Array.isArray(lidarrTags) ? lidarrTags : [];
  const toggleSection = (section) => {
    setCollapsedSections((current) => ({
      ...current,
      [section]: !current[section],
    }));
  };

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
        showSuccess(
          `Lidarr connection successful! (${result.instanceName || "Lidarr"})`
        );
        setLoadingLidarrProfiles(true);
        setLoadingLidarrMetadataProfiles(true);
        setLoadingLidarrTags(true);
        try {
          const [profiles, metadataProfiles, tags] = await Promise.all([
            getLidarrProfiles(url, apiKey),
            getLidarrMetadataProfiles(url, apiKey),
            getLidarrTags(url, apiKey),
          ]);
          const nextProfiles = Array.isArray(profiles) ? profiles : [];
          const nextMetadataProfiles = Array.isArray(metadataProfiles)
            ? metadataProfiles
            : [];
          const nextTags = Array.isArray(tags) ? tags : [];
          setLidarrProfiles(nextProfiles);
          setLidarrMetadataProfiles(nextMetadataProfiles);
          setLidarrTags(nextTags);
          if (nextProfiles.length > 0) {
            showInfo(`Loaded ${nextProfiles.length} quality profile(s)`);
          }
          if (nextMetadataProfiles.length > 0) {
            showInfo(
              `Loaded ${nextMetadataProfiles.length} metadata profile(s)`
            );
          }
          if (nextTags.length > 0) {
            showInfo(`Loaded ${nextTags.length} tag(s)`);
          }
        } catch {
        } finally {
          setLoadingLidarrProfiles(false);
          setLoadingLidarrMetadataProfiles(false);
          setLoadingLidarrTags(false);
        }
      } else {
        showError(
          `Connection failed: ${result.message || result.error}${result.details ? `\n${result.details}` : ""}`
        );
      }
    } catch (err) {
      setLidarrTestLatencyMs(Math.round(performance.now() - startTime));
      const errorMsg =
        err.response?.data?.message ||
        err.response?.data?.error ||
        err.message;
      showError(`Connection failed: ${errorMsg}`);
    } finally {
      setTestingLidarr(false);
    }
  };

  const handleRefreshProfiles = async () => {
    const url = settings.integrations?.lidarr?.url;
    const apiKey = settings.integrations?.lidarr?.apiKey;
    if (!url || !apiKey) {
      showError("Please enter Lidarr URL and API key first");
      return;
    }
    setLoadingLidarrProfiles(true);
    try {
      const profiles = await getLidarrProfiles(url, apiKey);
      const nextProfiles = Array.isArray(profiles) ? profiles : [];
      setLidarrProfiles(nextProfiles);
      if (nextProfiles.length > 0) {
        showSuccess(`Loaded ${nextProfiles.length} quality profile(s)`);
      } else {
        showInfo("No quality profiles found in Lidarr");
      }
    } catch (err) {
      const errorMsg =
        err.response?.data?.message ||
        err.response?.data?.error ||
        err.message;
      showError(`Failed to load profiles: ${errorMsg}`);
    } finally {
      setLoadingLidarrProfiles(false);
    }
  };

  const handleRefreshMetadataProfiles = async () => {
    const url = settings.integrations?.lidarr?.url;
    const apiKey = settings.integrations?.lidarr?.apiKey;
    if (!url || !apiKey) {
      showError("Please enter Lidarr URL and API key first");
      return;
    }
    setLoadingLidarrMetadataProfiles(true);
    try {
      const profiles = await getLidarrMetadataProfiles(url, apiKey);
      const nextProfiles = Array.isArray(profiles) ? profiles : [];
      setLidarrMetadataProfiles(nextProfiles);
      if (nextProfiles.length > 0) {
        showSuccess(`Loaded ${nextProfiles.length} metadata profile(s)`);
      } else {
        showInfo("No metadata profiles found in Lidarr");
      }
    } catch (err) {
      const errorMsg =
        err.response?.data?.message ||
        err.response?.data?.error ||
        err.message;
      showError(`Failed to load metadata profiles: ${errorMsg}`);
    } finally {
      setLoadingLidarrMetadataProfiles(false);
    }
  };

  const handleRefreshTags = async () => {
    const url = settings.integrations?.lidarr?.url;
    const apiKey = settings.integrations?.lidarr?.apiKey;
    if (!url || !apiKey) {
      showError("Please enter Lidarr URL and API key first");
      return;
    }
    setLoadingLidarrTags(true);
    try {
      const tags = await getLidarrTags(url, apiKey);
      const nextTags = Array.isArray(tags) ? tags : [];
      setLidarrTags(nextTags);
      if (nextTags.length > 0) {
        showSuccess(`Loaded ${nextTags.length} tag(s)`);
      } else {
        showInfo("No tags found in Lidarr");
      }
    } catch (err) {
      const errorMsg =
        err.response?.data?.message ||
        err.response?.data?.error ||
        err.message;
      showError(`Failed to load tags: ${errorMsg}`);
    } finally {
      setLoadingLidarrTags(false);
    }
  };

  return (
    <div className="card animate-fade-in">
      <div className="flex items-center justify-between mb-6">
        <h2
          className="text-2xl font-bold flex items-center"
          style={{ color: "#fff" }}
        >
          Integrations
        </h2>
        <FlipSaveButton
          saving={saving}
          disabled={!hasUnsavedChanges}
          onClick={handleSaveSettings}
        />
      </div>
      <form
        onSubmit={handleSaveSettings}
        className="space-y-6"
        autoComplete="off"
      >
        <div
          className="p-6 rounded-lg space-y-4"
          style={{
            backgroundColor: "#1a1a1e",
            border: "1px solid #2a2a2e",
          }}
        >
          <div className="flex items-center justify-between mb-2">
            <h3
              className="text-lg font-medium flex items-center"
              style={{ color: "#fff" }}
            >
              <button
                type="button"
                onClick={() => toggleSection("lidarr")}
                className="flex items-center gap-2 text-left"
                style={{ color: "#fff" }}
                aria-expanded={!collapsedSections.lidarr}
              >
                <ChevronDown
                  className={`w-4 h-4 transition-transform ${
                    collapsedSections.lidarr ? "-rotate-90" : ""
                  }`}
                />
                <span>Lidarr</span>
              </button>
            </h3>
            <div className="flex items-center gap-2">
              {health?.lidarrConfigured && (
                <span className="flex items-center text-sm text-green-400">
                  <CheckCircle className="w-4 h-4 mr-1" />
                  Connected
                </span>
              )}
              <button
                type="button"
                className={`btn ${
                  lidarrEditing ? "btn-primary" : "btn-secondary"
                } px-2 py-1`}
                onClick={() => setLidarrEditing((value) => !value)}
                aria-label={
                  lidarrEditing ? "Lock Lidarr settings" : "Edit Lidarr settings"
                }
              >
                <Pencil className="w-4 h-4" />
              </button>
            </div>
          </div>
          {!collapsedSections.lidarr && (
          <fieldset
            disabled={!lidarrEditing}
            className={`grid grid-cols-1 gap-4 ${
              lidarrEditing ? "" : "opacity-60"
            }`}
          >
            <div>
              <label
                className="block text-sm font-medium mb-1"
                style={{ color: "#fff" }}
              >
                Server URL
              </label>
              <input
                type="url"
                className="input"
                placeholder="http://lidarr:8686"
                autoComplete="off"
                value={settings.integrations?.lidarr?.url || ""}
                onChange={(e) => {
                  setLidarrTestLatencyMs(null);
                  updateSettings({
                    ...settings,
                    integrations: {
                      ...settings.integrations,
                      lidarr: {
                        ...(settings.integrations?.lidarr || {}),
                        url: e.target.value,
                      },
                    },
                  });
                }}
              />
            </div>
            <div>
              <label
                className="block text-sm font-medium mb-1"
                style={{ color: "#fff" }}
              >
                API Key
              </label>
              <div className="flex gap-2">
                <input
                  type="password"
                  className="input flex-1"
                  placeholder="Enter Lidarr API Key"
                  autoComplete="off"
                  value={settings.integrations?.lidarr?.apiKey || ""}
                  onChange={(e) => {
                    setLidarrTestLatencyMs(null);
                    updateSettings({
                      ...settings,
                      integrations: {
                        ...settings.integrations,
                        lidarr: {
                          ...(settings.integrations?.lidarr || {}),
                          apiKey: e.target.value,
                        },
                      },
                    });
                  }}
                />
                <button
                  type="button"
                  onClick={handleTestLidarr}
                  disabled={
                    testingLidarr ||
                    !settings.integrations?.lidarr?.url ||
                    !settings.integrations?.lidarr?.apiKey
                  }
                  className="btn btn-secondary"
                >
                  {testingLidarr ? "Testing..." : "Test"}
                </button>
              </div>
              <p className="mt-1 text-xs" style={{ color: "#c1c1c3" }}>
                Found in Settings &rarr; General &rarr; Security.
              </p>
              {lidarrTestLatencyMs !== null && (
                <p className="mt-1 text-xs" style={{ color: "#c1c1c3" }}>
                  Last test response time: {lidarrTestLatencyMs} ms
                </p>
              )}
            </div>
            <div>
              <label
                className="block text-sm font-medium mb-1"
                style={{ color: "#fff" }}
              >
                External URL
              </label>
              <input
                type="url"
                className="input"
                placeholder="https://lidarr.example.com"
                autoComplete="off"
                value={settings.integrations?.lidarr?.externalUrl || ""}
                onChange={(e) =>
                  updateSettings({
                    ...settings,
                    integrations: {
                      ...settings.integrations,
                      lidarr: {
                        ...(settings.integrations?.lidarr || {}),
                        externalUrl: e.target.value,
                      },
                    },
                  })
                }
              />
              <p className="mt-1 text-xs" style={{ color: "#c1c1c3" }}>
                Optional. Used only for browser-facing &quot;View on Lidarr&quot;
                links. Leave blank to use the server URL above.
              </p>
            </div>
            <div>
              <label
                className="block text-sm font-medium mb-1"
                style={{ color: "#fff" }}
              >
                Default Quality Profile
              </label>
              <div className="flex gap-2">
                <select
                  className="input flex-1"
                  value={
                    settings.integrations?.lidarr?.qualityProfileId
                      ? String(settings.integrations.lidarr.qualityProfileId)
                      : ""
                  }
                  onChange={(e) =>
                    updateSettings({
                      ...settings,
                      integrations: {
                        ...settings.integrations,
                        lidarr: {
                          ...(settings.integrations?.lidarr || {}),
                          qualityProfileId: e.target.value
                            ? parseInt(e.target.value)
                            : null,
                        },
                      },
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
                </select>
                <button
                  type="button"
                  onClick={handleRefreshProfiles}
                  disabled={
                    loadingLidarrProfiles ||
                    !settings.integrations?.lidarr?.url ||
                    !settings.integrations?.lidarr?.apiKey
                  }
                  className="btn btn-secondary"
                >
                  <RefreshCw
                    className={`w-4 h-4 ${
                      loadingLidarrProfiles ? "animate-spin" : ""
                    }`}
                  />
                </button>
              </div>
              <p className="mt-1 text-xs" style={{ color: "#c1c1c3" }}>
                Quality profile used when adding artists and albums to Lidarr.
              </p>
            </div>
            <div>
              <label
                className="block text-sm font-medium mb-1"
                style={{ color: "#fff" }}
              >
                Default Metadata Profile
              </label>
              <div className="flex gap-2">
                <select
                  className="input flex-1"
                  value={
                    settings.integrations?.lidarr?.metadataProfileId
                      ? String(settings.integrations.lidarr.metadataProfileId)
                      : ""
                  }
                  onChange={(e) =>
                    updateSettings({
                      ...settings,
                      integrations: {
                        ...settings.integrations,
                        lidarr: {
                          ...(settings.integrations?.lidarr || {}),
                          metadataProfileId: e.target.value
                            ? parseInt(e.target.value)
                            : null,
                        },
                      },
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
                </select>
                <button
                  type="button"
                  onClick={handleRefreshMetadataProfiles}
                  disabled={
                    loadingLidarrMetadataProfiles ||
                    !settings.integrations?.lidarr?.url ||
                    !settings.integrations?.lidarr?.apiKey
                  }
                  className="btn btn-secondary"
                >
                  <RefreshCw
                    className={`w-4 h-4 ${
                      loadingLidarrMetadataProfiles ? "animate-spin" : ""
                    }`}
                  />
                </button>
              </div>
              <p className="mt-1 text-xs" style={{ color: "#c1c1c3" }}>
                Metadata profile used when adding artists to Lidarr.
              </p>
            </div>
            <div>
              <label
                className="block text-sm font-medium mb-1"
                style={{ color: "#fff" }}
              >
                Tag
              </label>
              <div className="flex gap-2">
                <select
                  className="input flex-1"
                  value={
                    settings.integrations?.lidarr?.tagId
                      ? String(settings.integrations.lidarr.tagId)
                      : ""
                  }
                  onChange={(e) =>
                    updateSettings({
                      ...settings,
                      integrations: {
                        ...settings.integrations,
                        lidarr: {
                          ...(settings.integrations?.lidarr || {}),
                          tagId: e.target.value
                            ? parseInt(e.target.value)
                            : null,
                        },
                      },
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
                </select>
                <button
                  type="button"
                  onClick={handleRefreshTags}
                  disabled={
                    loadingLidarrTags ||
                    !settings.integrations?.lidarr?.url ||
                    !settings.integrations?.lidarr?.apiKey
                  }
                  className="btn btn-secondary"
                >
                  <RefreshCw
                    className={`w-4 h-4 ${
                      loadingLidarrTags ? "animate-spin" : ""
                    }`}
                  />
                </button>
              </div>
              <p className="mt-1 text-xs" style={{ color: "#c1c1c3" }}>
                Tag applied to artists added through Aurral.
              </p>
            </div>
            <div>
              <label
                className="block text-sm font-medium mb-1"
                style={{ color: "#fff" }}
              >
                Default Monitoring Option
              </label>
              <select
                className="input"
                value={
                  settings.integrations?.lidarr?.defaultMonitorOption || "none"
                }
                onChange={(e) =>
                  updateSettings({
                    ...settings,
                    integrations: {
                      ...settings.integrations,
                      lidarr: {
                        ...(settings.integrations?.lidarr || {}),
                        defaultMonitorOption: e.target.value,
                      },
                    },
                  })
                }
              >
                <option value="none">None (Artist Only)</option>
                <option value="all">All Albums</option>
                <option value="future">Future Albums</option>
                <option value="missing">Missing Albums</option>
                <option value="latest">Latest Album</option>
                <option value="first">First Album</option>
              </select>
              <p className="mt-1 text-xs" style={{ color: "#c1c1c3" }}>
                Default monitoring used when adding new artists.
              </p>
            </div>
            <div>
              <label className="flex items-center gap-2 cursor-pointer">
                <input
                  type="checkbox"
                  className="checkbox"
                  checked={
                    settings.integrations?.lidarr?.searchOnAdd || false
                  }
                  onChange={(e) =>
                    updateSettings({
                      ...settings,
                      integrations: {
                        ...settings.integrations,
                        lidarr: {
                          ...(settings.integrations?.lidarr || {}),
                          searchOnAdd: e.target.checked,
                        },
                      },
                    })
                  }
                />
                <span
                  className="text-sm font-medium"
                  style={{ color: "#fff" }}
                >
                  Search on Add
                </span>
              </label>
              <p
                className="mt-1 text-xs ml-6"
                style={{ color: "#c1c1c3" }}
              >
                Automatically search for albums when adding them to library
              </p>
            </div>
            <div
              className="pt-4 border-t"
              style={{ borderColor: "#2a2a2e" }}
            >
              <button
                type="button"
                onClick={() => {
                  if (
                    !settings.integrations?.lidarr?.url ||
                    !settings.integrations?.lidarr?.apiKey
                  ) {
                    showError(
                      "Please configure Lidarr URL and API key first"
                    );
                    return;
                  }
                  setShowCommunityGuideModal(true);
                }}
                disabled={
                  applyingCommunityGuide || !health?.lidarrConfigured
                }
                className="btn btn-primary w-full"
              >
                {applyingCommunityGuide
                  ? "Applying..."
                  : "Apply Davo's Recommended Settings"}
              </button>
              <p className="mt-2 text-xs" style={{ color: "#c1c1c3" }}>
                Creates quality profile, updates quality definitions, adds
                custom formats, and updates naming scheme.{" "}
                <a
                  href="https://wiki.servarr.com/lidarr/community-guide"
                  target="_blank"
                  rel="noopener noreferrer"
                  className="underline"
                  style={{ color: "#60a5fa" }}
                >
                  Read more
                </a>
              </p>
            </div>
          </fieldset>
          )}
        </div>
        <div
          className="p-6 rounded-lg space-y-4"
          style={{
            backgroundColor: "#1a1a1e",
            border: "1px solid #2a2a2e",
          }}
        >
          <div className="flex items-center justify-between mb-2">
            <h3
              className="text-lg font-medium flex items-center"
              style={{ color: "#fff" }}
            >
              <button
                type="button"
                onClick={() => toggleSection("lastfm")}
                className="flex items-center gap-2 text-left"
                style={{ color: "#fff" }}
                aria-expanded={!collapsedSections.lastfm}
              >
                <ChevronDown
                  className={`w-4 h-4 transition-transform ${
                    collapsedSections.lastfm ? "-rotate-90" : ""
                  }`}
                />
                <span>Last.fm</span>
              </button>
            </h3>
            <div className="flex items-center gap-2">
              {health?.lastfmConfigured && (
                <span className="flex items-center text-sm text-green-400">
                  <CheckCircle className="w-4 h-4 mr-1" />
                  Configured
                </span>
              )}
              <button
                type="button"
                className={`btn ${
                  lastfmEditing ? "btn-primary" : "btn-secondary"
                } px-2 py-1`}
                onClick={() => setLastfmEditing((value) => !value)}
                aria-label={
                  lastfmEditing
                    ? "Lock Last.fm settings"
                    : "Edit Last.fm settings"
                }
              >
                <Pencil className="w-4 h-4" />
              </button>
            </div>
          </div>
          {!collapsedSections.lastfm && (
          <fieldset
            disabled={!lastfmEditing}
            className={`space-y-4 ${lastfmEditing ? "" : "opacity-60"}`}
          >
            <div>
              <label
                className="block text-sm font-medium mb-1"
                style={{ color: "#fff" }}
              >
                API Key
              </label>
              <input
                type="password"
                className="input"
                placeholder="Last.fm API Key"
                autoComplete="off"
                value={settings.integrations?.lastfm?.apiKey || ""}
                onChange={(e) =>
                  updateSettings({
                    ...settings,
                    integrations: {
                      ...settings.integrations,
                      lastfm: {
                        ...(settings.integrations?.lastfm || {}),
                        apiKey: e.target.value,
                      },
                    },
                  })
                }
              />
            </div>
            <div>
              <label
                className="block text-sm font-medium mb-1"
                style={{ color: "#fff" }}
              >
                Default Username
              </label>
              <input
                type="text"
                className="input"
                placeholder="Your Last.fm username"
                autoComplete="off"
                value={settings.integrations?.lastfm?.username || ""}
                onChange={(e) =>
                  updateSettings({
                    ...settings,
                    integrations: {
                      ...settings.integrations,
                      lastfm: {
                        ...(settings.integrations?.lastfm || {}),
                        username: e.target.value,
                      },
                    },
                  })
                }
              />
              <p className="mt-1 text-xs" style={{ color: "#c1c1c3" }}>
                Used as the app-wide fallback for users who have not set their
                own Last.fm or ListenBrainz account in Account settings.
              </p>
            </div>
          </fieldset>
          )}
        </div>
        <div
          className="p-6 rounded-lg space-y-4"
          style={{
            backgroundColor: "#1a1a1e",
            border: "1px solid #2a2a2e",
          }}
        >
          <div className="flex items-center justify-between mb-2">
            <h3
              className="text-lg font-medium flex items-center"
              style={{ color: "#fff" }}
            >
              <button
                type="button"
                onClick={() => toggleSection("ticketmaster")}
                className="flex items-center gap-2 text-left"
                style={{ color: "#fff" }}
                aria-expanded={!collapsedSections.ticketmaster}
              >
                <ChevronDown
                  className={`w-4 h-4 transition-transform ${
                    collapsedSections.ticketmaster ? "-rotate-90" : ""
                  }`}
                />
                <span>Ticketmaster</span>
              </button>
            </h3>
            <div className="flex items-center gap-2">
              {health?.ticketmasterConfigured && (
                <span className="flex items-center text-sm text-green-400">
                  <CheckCircle className="w-4 h-4 mr-1" />
                  Configured
                </span>
              )}
              <button
                type="button"
                className={`btn ${
                  ticketmasterEditing ? "btn-primary" : "btn-secondary"
                } px-2 py-1`}
                onClick={() => setTicketmasterEditing((value) => !value)}
                aria-label={
                  ticketmasterEditing
                    ? "Lock Ticketmaster settings"
                    : "Edit Ticketmaster settings"
                }
              >
                <Pencil className="w-4 h-4" />
              </button>
            </div>
          </div>
          {!collapsedSections.ticketmaster && (
          <fieldset
            disabled={!ticketmasterEditing}
            className={`space-y-4 ${ticketmasterEditing ? "" : "opacity-60"}`}
          >
            <div
              className="rounded-lg p-4 space-y-2"
              style={{ backgroundColor: "#141418", border: "1px solid #2a2a2e" }}
            >
              <p className="text-sm font-medium" style={{ color: "#fff" }}>
                Get an API key
              </p>
              <p className="text-sm leading-6" style={{ color: "#c1c1c3" }}>
                Register on the developers portal. After the registration, the
                default application will be created. The application contains a
                Consumer Key that is used for authentication.
              </p>
              <a
                href="https://developer-acct.ticketmaster.com/user/login"
                target="_blank"
                rel="noopener noreferrer"
                className="inline-flex text-sm font-medium underline"
                style={{ color: "#60a5fa" }}
              >
                Open the Ticketmaster developer portal
              </a>
            </div>
            <div>
              <label
                className="block text-sm font-medium mb-1"
                style={{ color: "#fff" }}
              >
                Consumer Key
              </label>
              <input
                type="password"
                className="input"
                placeholder="Enter Ticketmaster Consumer Key"
                autoComplete="off"
                value={settings.integrations?.ticketmaster?.apiKey || ""}
                onChange={(e) =>
                  updateSettings({
                    ...settings,
                    integrations: {
                      ...settings.integrations,
                      ticketmaster: {
                        ...(settings.integrations?.ticketmaster || {}),
                        apiKey: e.target.value,
                      },
                    },
                  })
                }
              />
              <p className="mt-1 text-xs" style={{ color: "#c1c1c3" }}>
                Used for the Discover page&apos;s nearby shows section.
              </p>
            </div>
            <div>
              <label
                className="block text-sm font-medium mb-1"
                style={{ color: "#fff" }}
              >
                Search Radius (miles)
              </label>
              <input
                type="number"
                min={5}
                max={250}
                step={5}
                className="input"
                value={settings.integrations?.ticketmaster?.searchRadiusMiles ?? 50}
                onChange={(e) => {
                  const raw = Number(e.target.value);
                  const value = Number.isFinite(raw)
                    ? Math.max(5, Math.min(250, Math.floor(raw)))
                    : 50;
                  updateSettings({
                    ...settings,
                    integrations: {
                      ...settings.integrations,
                      ticketmaster: {
                        ...(settings.integrations?.ticketmaster || {}),
                        searchRadiusMiles: value,
                      },
                    },
                  });
                }}
              />
              <p className="mt-1 text-xs" style={{ color: "#c1c1c3" }}>
                Controls how far from your selected area Ticketmaster events are searched.
              </p>
            </div>
            <label className="flex items-center justify-between gap-4">
              <span style={{ color: "#fff" }}>
                Include recommended artists in local shows
              </span>
              <input
                type="checkbox"
                checked={localDiscoveryIncludeRecommendations}
                onChange={(e) =>
                  updateSettings({
                    ...settings,
                    integrations: {
                      ...settings.integrations,
                      ticketmaster: {
                        ...(settings.integrations?.ticketmaster || {}),
                        localDiscoveryIncludeRecommendations: e.target.checked,
                      },
                    },
                  })
                }
              />
            </label>
            <label className="flex items-center justify-between gap-4">
              <span style={{ color: "#fff" }}>
                Include trending artists in local shows
              </span>
              <input
                type="checkbox"
                checked={localDiscoveryIncludeTrending}
                onChange={(e) =>
                  updateSettings({
                    ...settings,
                    integrations: {
                      ...settings.integrations,
                      ticketmaster: {
                        ...(settings.integrations?.ticketmaster || {}),
                        localDiscoveryIncludeTrending: e.target.checked,
                      },
                    },
                  })
                }
              />
            </label>
          </fieldset>
          )}
        </div>
        <div
          className="p-6 rounded-lg space-y-4"
          style={{
            backgroundColor: "#1a1a1e",
            border: "1px solid #2a2a2e",
          }}
        >
          <div className="flex items-center justify-between mb-2">
            <h3
              className="text-lg font-medium flex items-center"
              style={{ color: "#fff" }}
            >
              <button
                type="button"
                onClick={() => toggleSection("navidrome")}
                className="flex items-center gap-2 text-left"
                style={{ color: "#fff" }}
                aria-expanded={!collapsedSections.navidrome}
              >
                <ChevronDown
                  className={`w-4 h-4 transition-transform ${
                    collapsedSections.navidrome ? "-rotate-90" : ""
                  }`}
                />
                <span>Subsonic / Navidrome</span>
              </button>
            </h3>
            <div className="flex items-center gap-2">
              {settings.integrations?.navidrome?.url && (
                <span className="flex items-center text-sm text-green-400">
                  <CheckCircle className="w-4 h-4 mr-1" />
                  Configured
                </span>
              )}
              <button
                type="button"
                className={`btn ${
                  navidromeEditing ? "btn-primary" : "btn-secondary"
                } px-2 py-1`}
                onClick={() => setNavidromeEditing((value) => !value)}
                aria-label={
                  navidromeEditing
                    ? "Lock Subsonic / Navidrome settings"
                    : "Edit Subsonic / Navidrome settings"
                }
              >
                <Pencil className="w-4 h-4" />
              </button>
            </div>
          </div>
          {!collapsedSections.navidrome && (
          <fieldset
            disabled={!navidromeEditing}
            className={`${navidromeEditing ? "" : "opacity-60"}`}
          >
            <div>
            <label
              className="block text-sm font-medium mb-1"
              style={{ color: "#fff" }}
            >
              Server URL
            </label>
            <input
              type="url"
              className="input"
              placeholder="https://music.example.com"
              autoComplete="off"
              value={settings.integrations?.navidrome?.url || ""}
              onChange={(e) =>
                updateSettings({
                  ...settings,
                  integrations: {
                    ...settings.integrations,
                    navidrome: {
                      ...(settings.integrations?.navidrome || {}),
                      url: e.target.value,
                    },
                  },
                })
              }
            />
            </div>
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
            <div>
              <label
                className="block text-sm font-medium mb-1"
                style={{ color: "#fff" }}
              >
                Username
              </label>
              <input
                type="text"
                className="input"
                autoComplete="off"
                value={settings.integrations?.navidrome?.username || ""}
                onChange={(e) =>
                  updateSettings({
                    ...settings,
                    integrations: {
                      ...settings.integrations,
                      navidrome: {
                        ...(settings.integrations?.navidrome || {}),
                        username: e.target.value,
                      },
                    },
                  })
                }
              />
            </div>
            <div>
              <label
                className="block text-sm font-medium mb-1"
                style={{ color: "#fff" }}
              >
                Password
              </label>
              <input
                type="password"
                className="input"
                autoComplete="off"
                value={settings.integrations?.navidrome?.password || ""}
                onChange={(e) =>
                  updateSettings({
                    ...settings,
                    integrations: {
                      ...settings.integrations,
                      navidrome: {
                        ...(settings.integrations?.navidrome || {}),
                        password: e.target.value,
                      },
                    },
                  })
                }
              />
            </div>
            </div>
            <p className="mt-3 text-xs" style={{ color: "#8a8a8e" }}>
              When using Weekly Flow: set Navidrome&apos;s{" "}
              <code>Scanner.PurgeMissing</code> to <code>always</code> or{" "}
              <code>full</code> (e.g.{" "}
              <code>ND_SCANNER_PURGEMISSING=always</code>) so turning off a flow
              removes those tracks from the library.
            </p>
          </fieldset>
          )}
        </div>
      </form>
    </div>
  );
}
