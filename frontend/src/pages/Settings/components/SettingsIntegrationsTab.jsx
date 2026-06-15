import { useState, useEffect } from "react";
import { CheckCircle, ChevronDown, RefreshCw } from "lucide-react";
import FlipSaveButton from "../../../components/FlipSaveButton";
import { SettingsInput, SettingsSelect } from "./SettingsField";
import { LidarrLibraryAccessCheck } from "./LidarrLibraryAccessCheck";
import {
  getLidarrMetadataProfiles,
  getLidarrProfiles,
  getLidarrTags,
  testLidarrConnection,
  testLidarrLibraryAccess,
  testSlskdConnection,
  startPlexAuth,
  checkPlexAuth,
  getPlexResources,
  testPlexConnection,
  syncPlexNow,
  browsePaths,
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
  fetchSettings,
  showSuccess,
  showError,
  showInfo,
}) {
  const [collapsedSections, setCollapsedSections] = useState({
    lidarr: false,
    lastfm: true,
    ticketmaster: true,
    navidrome: true,
    slskd: false,
    plex: true,
  });
  const [testingSlskd, setTestingSlskd] = useState(false);
  const [lidarrTestLatencyMs, setLidarrTestLatencyMs] = useState(null);
  const [testingLidarrLibraryAccess, setTestingLidarrLibraryAccess] =
    useState(false);
  const [lidarrLibraryAccessResult, setLidarrLibraryAccessResult] =
    useState(null);
  const [plexConnecting, setPlexConnecting] = useState(false);
  const [testingPlex, setTestingPlex] = useState(false);
  const [syncingPlex, setSyncingPlex] = useState(false);
  const [plexServers, setPlexServers] = useState([]);
  const [browseOpen, setBrowseOpen] = useState(false);
  const [browseLoading, setBrowseLoading] = useState(false);
  const [browseState, setBrowseState] = useState({
    path: "/",
    parent: null,
    directories: [],
  });
  const safeLidarrProfiles = Array.isArray(lidarrProfiles)
    ? lidarrProfiles
    : [];
  const localDiscoveryIncludeRecommendations =
    settings.integrations?.ticketmaster
      ?.localDiscoveryIncludeRecommendations !== false;
  const localDiscoveryIncludeTrending =
    settings.integrations?.ticketmaster?.localDiscoveryIncludeTrending !==
    false;
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

  const handleTestLidarrLibraryAccess = async () => {
    const url = settings.integrations?.lidarr?.url;
    const apiKey = settings.integrations?.lidarr?.apiKey;
    if (!url || !apiKey) {
      showError("Please enter both URL and API key");
      return;
    }
    setTestingLidarrLibraryAccess(true);
    setLidarrLibraryAccessResult(null);
    try {
      const result = await testLidarrLibraryAccess(url, apiKey);
      setLidarrLibraryAccessResult(result);
      if (result.appliedMappings?.length && fetchSettings) {
        await fetchSettings();
        showInfo(
          `Applied path mapping: ${result.appliedMappings
            .map((entry) => `${entry.remote} -> ${entry.local}`)
            .join(", ")}`,
        );
      }
      if (result.ok) {
        if (result.partial) {
          showInfo(
            "Folders are reachable, but no downloaded tracks were found to verify yet.",
          );
        } else {
          showSuccess("Library access looks good.");
        }
      } else {
        showError("Library access check failed. See the results below.");
      }
    } catch (error) {
      const message =
        error.response?.data?.message ||
        error.response?.data?.error ||
        error.message ||
        "Library access check failed";
      showError(message);
    } finally {
      setTestingLidarrLibraryAccess(false);
    }
  };

  const updatePlex = (patch) =>
    updateSettings({
      ...settings,
      integrations: {
        ...settings.integrations,
        plex: { ...(settings.integrations?.plex || {}), ...patch },
      },
    });

  const loadPlexServers = async (token) => {
    const { servers } = await getPlexResources(token);
    const list = Array.isArray(servers) ? servers : [];
    setPlexServers(list);
    return list;
  };

  // Auto-load servers when we have a token so the dropdown is always populated.
  const plexToken = settings.integrations?.plex?.token;
  useEffect(() => {
    if (!plexToken) {
      setPlexServers([]);
      return;
    }
    let cancelled = false;
    getPlexResources(plexToken)
      .then(({ servers }) => {
        if (!cancelled) setPlexServers(Array.isArray(servers) ? servers : []);
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, [plexToken]);

  const loadBrowse = async (path) => {
    setBrowseLoading(true);
    try {
      const result = await browsePaths(path);
      setBrowseState(result);
    } catch (err) {
      const errorMsg =
        err.response?.data?.message || err.response?.data?.error || err.message;
      showError(`Cannot read path: ${errorMsg}`);
    } finally {
      setBrowseLoading(false);
    }
  };

  const handleToggleBrowse = () => {
    if (browseOpen) {
      setBrowseOpen(false);
      return;
    }
    setBrowseOpen(true);
    loadBrowse(settings.integrations?.plex?.downloadsPath || "/");
  };

  const handleUseBrowsedFolder = () => {
    updatePlex({ downloadsPath: browseState.path });
    setBrowseOpen(false);
  };

  const handleConnectPlex = async () => {
    setPlexConnecting(true);
    try {
      const { pinId, code, authUrl, clientId } = await startPlexAuth();
      const popup = window.open(
        authUrl,
        "plex-auth",
        "width=600,height=700",
      );
      const deadline = Date.now() + 3 * 60 * 1000;
      let token = null;
      while (Date.now() < deadline) {
        await new Promise((r) => setTimeout(r, 2000));
        try {
          const res = await checkPlexAuth(pinId, code);
          if (res.token) {
            token = res.token;
            break;
          }
        } catch {}
      }
      if (popup && !popup.closed) popup.close();
      if (!token) {
        showError("Plex authentication timed out. Please try again.");
        return;
      }
      const servers = await loadPlexServers(token);
      const owned = (servers || []).filter((s) => s.owned);
      const patch = { token, ...(clientId ? { clientId } : {}) };
      if (owned.length === 1) {
        const best = pickBestConnection(owned[0]);
        if (best?.uri) {
          patch.url = best.uri;
          patch.machineIdentifier = owned[0].clientIdentifier;
        }
      }
      updatePlex(patch);
      showSuccess(
        owned.length === 1 && patch.url
          ? `Signed in and selected "${owned[0].name}". Remember to Save settings.`
          : "Signed in to Plex. Select your server below.",
      );
    } catch (err) {
      const errorMsg =
        err.response?.data?.message || err.response?.data?.error || err.message;
      showError(`Plex sign-in failed: ${errorMsg}`);
    } finally {
      setPlexConnecting(false);
    }
  };

  const pickBestConnection = (server) => {
    const conns = server.connections || [];
    return conns.find((c) => c.local) || conns.find((c) => c.uri) || conns[0];
  };

  const handleSelectPlexServer = (server) => {
    const best = pickBestConnection(server);
    if (!best?.uri) {
      showError("Selected Plex server has no usable connection.");
      return;
    }
    updatePlex({ url: best.uri, machineIdentifier: server.clientIdentifier });
    showInfo(`Selected "${server.name}". Remember to Save settings.`);
  };

  const handleTestPlex = async () => {
    const url = settings.integrations?.plex?.url;
    const token = settings.integrations?.plex?.token;
    if (!url || !token) {
      showError("Connect to Plex and select a server first");
      return;
    }
    setTestingPlex(true);
    try {
      const result = await testPlexConnection(url, token);
      if (result.success) {
        showSuccess(
          `Plex connection successful!${result.version ? ` (v${result.version})` : ""}`,
        );
        if (result.machineIdentifier) {
          updatePlex({ machineIdentifier: result.machineIdentifier });
        }
      } else {
        showError(`Connection failed: ${result.message || result.error}`);
      }
    } catch (err) {
      const errorMsg =
        err.response?.data?.message || err.response?.data?.error || err.message;
      showError(`Connection failed: ${errorMsg}`);
    } finally {
      setTestingPlex(false);
    }
  };

  const handleSyncPlex = async () => {
    if (hasUnsavedChanges) {
      showError("Save settings first, then sync to Plex.");
      return;
    }
    setSyncingPlex(true);
    try {
      const result = await syncPlexNow();
      const built = (result.playlists || []).length;
      if (result.scanInProgress) {
        showInfo(
          "Library ready and a Plex scan is running. Playlists will fill in automatically over the next few minutes as Plex indexes the tracks — no need to click again.",
        );
      } else {
        showSuccess(
          `Synced to Plex: ${built} playlist(s) from ${result.indexedTracks} indexed track(s).`,
        );
      }
    } catch (err) {
      const errorMsg =
        err.response?.data?.message || err.response?.data?.error || err.message;
      showError(`Plex sync failed: ${errorMsg}`);
    } finally {
      setSyncingPlex(false);
    }
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
          `Lidarr connection successful! (${result.instanceName || "Lidarr"})`,
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
              `Loaded ${nextMetadataProfiles.length} metadata profile(s)`,
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
          `Connection failed: ${result.message || result.error}${result.details ? `\n${result.details}` : ""}`,
        );
      }
    } catch (err) {
      setLidarrTestLatencyMs(Math.round(performance.now() - startTime));
      const errorMsg =
        err.response?.data?.message || err.response?.data?.error || err.message;
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
        err.response?.data?.message || err.response?.data?.error || err.message;
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
        err.response?.data?.message || err.response?.data?.error || err.message;
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
        err.response?.data?.message || err.response?.data?.error || err.message;
      showError(`Failed to load tags: ${errorMsg}`);
    } finally {
      setLoadingLidarrTags(false);
    }
  };

  return (
    <div className="settings-page__panel">
      <div className="settings-page__panel-header">
        <h2
          className="settings-page__panel-title">
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
        className="settings-page__form"
        autoComplete="off"
      >
        <div
          className="settings-page__section"
        >
          <div className="settings-page__section-header">
            <button
                type="button"
                onClick={() => toggleSection("lidarr")}
                className="settings-page__section-toggle"
                aria-expanded={!collapsedSections.lidarr}
              >
                <ChevronDown
                  className={`settings-page__section-toggle-icon${collapsedSections.lidarr ? " is-collapsed" : ""}`}
                />
                <span>Lidarr</span>
              </button>
            <div className="settings-page__inline-row">
              {health?.lidarrConfigured && (
                <span className="settings-page__status">
                  <CheckCircle className="settings-page__status-icon" />
                  Connected
                </span>
              )}
            </div>
          </div>
          {!collapsedSections.lidarr && (
            <fieldset className="settings-page__fields">
              <div>
                <label
                  className="artist-field-label"
                >
                  Server URL
                </label>
                <SettingsInput type="url"

                  placeholder="http://lidarr:8686"
                  autoComplete="off"
                  value={settings.integrations?.lidarr?.url || ""}
                    onChange={(e) => {
                      setLidarrTestLatencyMs(null);
                      setLidarrLibraryAccessResult(null);
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
                  className="artist-field-label"
                >
                  API Key
                </label>
                <div className="settings-page__field-row">
                  <SettingsInput
                    wrapperClassName="settings-page__field-grow"
                    type="password"
                    placeholder="Enter Lidarr API Key"
                    autoComplete="off"
                    value={settings.integrations?.lidarr?.apiKey || ""}
                    onChange={(e) => {
                      setLidarrTestLatencyMs(null);
                      setLidarrLibraryAccessResult(null);
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
                      testingLidarrLibraryAccess ||
                      !settings.integrations?.lidarr?.url ||
                      !settings.integrations?.lidarr?.apiKey
                    }
                    className="btn btn-secondary"
                  >
                    {testingLidarr ? "Testing..." : "Test connection"}
                  </button>
                </div>
                <p className="settings-page__hint">
                  Found in Settings &rarr; General &rarr; Security.
                </p>
                {lidarrTestLatencyMs !== null && (
                  <p className="settings-page__hint">
                    Last test response time: {lidarrTestLatencyMs} ms
                  </p>
                )}
                <div className="settings-page__lidarr-access-row">
                  <button
                    type="button"
                    onClick={handleTestLidarrLibraryAccess}
                    disabled={
                      testingLidarrLibraryAccess ||
                      testingLidarr ||
                      !settings.integrations?.lidarr?.url ||
                      !settings.integrations?.lidarr?.apiKey
                    }
                    className="btn btn-secondary"
                  >
                    {testingLidarrLibraryAccess
                      ? "Checking library access..."
                      : "Test library access"}
                  </button>
                  <p className="settings-page__hint">
                    Verifies Aurral can read files from Lidarr&apos;s music
                    folders for playback and playlist reuse.
                  </p>
                </div>
                <LidarrLibraryAccessCheck result={lidarrLibraryAccessResult} />
              </div>
              <div>
                <label
                  className="artist-field-label"
                >
                  External URL
                </label>
                <SettingsInput type="url"

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
                <p className="settings-page__hint">
                  Optional. Used only for browser-facing &quot;View on
                  Lidarr&quot; links. Leave blank to use the server URL above.
                </p>
              </div>
              <div>
                <label
                  className="artist-field-label"
                >
                  Default Quality Profile
                </label>
                <div className="settings-page__field-row">
                  <SettingsSelect
                    wrapperClassName="settings-page__field-grow"
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
                  </SettingsSelect>
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
                      className={`artist-icon-sm${
                        loadingLidarrProfiles ? " animate-spin" : ""
                      }`}
                    />
                  </button>
                </div>
                <p className="settings-page__hint">
                  Quality profile used when adding artists and albums to Lidarr.
                </p>
              </div>
              <div>
                <label
                  className="artist-field-label"
                >
                  Default Metadata Profile
                </label>
                <div className="settings-page__field-row">
                  <SettingsSelect
                    wrapperClassName="settings-page__field-grow"
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
                  </SettingsSelect>
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
                      className={`artist-icon-sm${
                        loadingLidarrMetadataProfiles ? " animate-spin" : ""
                      }`}
                    />
                  </button>
                </div>
                <p className="settings-page__hint">
                  Metadata profile used when adding artists to Lidarr.
                </p>
              </div>
              <div>
                <label
                  className="artist-field-label"
                >
                  Tag
                </label>
                <div className="settings-page__field-row">
                  <SettingsSelect
                    wrapperClassName="settings-page__field-grow"
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
                  </SettingsSelect>
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
                      className={`artist-icon-sm${
                        loadingLidarrTags ? " animate-spin" : ""
                      }`}
                    />
                  </button>
                </div>
                <p className="settings-page__hint">
                  Tag applied to artists added through Aurral.
                </p>
              </div>
              <div>
                <label
                  className="artist-field-label"
                >
                  Default Monitoring Option
                </label>
                <SettingsSelect
                  value={
                    settings.integrations?.lidarr?.defaultMonitorOption ||
                    "none"
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
                  <option value="existing">Existing Albums</option>
                  <option value="all">All Albums</option>
                  <option value="future">Future Albums</option>
                  <option value="missing">Missing Albums</option>
                  <option value="latest">Latest Album</option>
                  <option value="first">First Album</option>
                </SettingsSelect>
                <p className="settings-page__hint">
                  Default monitoring used when adding new artists.
                </p>
              </div>
              <div>
                <label className="artist-checkbox-label">
                  <input
                    type="checkbox"
                    className="artist-checkbox"
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
                    className="artist-field-label">
                    Search on Add
                  </span>
                </label>
                <p className="settings-page__hint settings-page__hint--indented">
                  Automatically search for albums when adding them to library
                </p>
              </div>
              <div className="settings-page__split">
                <button
                  type="button"
                  onClick={() => {
                    if (
                      !settings.integrations?.lidarr?.url ||
                      !settings.integrations?.lidarr?.apiKey
                    ) {
                      showError(
                        "Please configure Lidarr URL and API key first",
                      );
                      return;
                    }
                    setShowCommunityGuideModal(true);
                  }}
                  disabled={applyingCommunityGuide || !health?.lidarrConfigured}
                  className="btn btn-primary btn--full"
                >
                  {applyingCommunityGuide
                    ? "Applying..."
                    : "Apply Davo's Recommended Settings"}
                </button>
                <p className="settings-page__hint">
                  Creates quality profile, updates quality definitions, adds
                  custom formats, and updates naming scheme.{" "}
                  <a
                    href="https://wiki.servarr.com/lidarr/community-guide"
                    target="_blank"
                    rel="noopener noreferrer"
                    className="settings-page__link"
                    
                  >
                    Read more
                  </a>
                </p>
              </div>
            </fieldset>
          )}
        </div>
        <div
          className="settings-page__section"
        >
          <div className="settings-page__section-header">
            <button
                type="button"
                onClick={() => toggleSection("lastfm")}
                className="settings-page__section-toggle"
                aria-expanded={!collapsedSections.lastfm}
              >
                <ChevronDown
                  className={`settings-page__section-toggle-icon${collapsedSections.lastfm ? " is-collapsed" : ""}`}
                />
                <span>Last.fm</span>
              </button>
            <div className="settings-page__inline-row">
              {health?.lastfmConfigured && (
                <span className="settings-page__status">
                  <CheckCircle className="settings-page__status-icon" />
                  Configured
                </span>
              )}
            </div>
          </div>
          {!collapsedSections.lastfm && (
            <fieldset className="settings-page__fields">
              <div>
                <label
                  className="artist-field-label"
                >
                  API Key
                </label>
                <SettingsInput type="password"

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
                  className="artist-field-label"
                >
                  Default Username
                </label>
                <SettingsInput type="text"

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
                <p className="settings-page__hint">
                  Used as the app-wide fallback for users who have not set their
                  own Last.fm, ListenBrainz, or Koito account in Profile.
                </p>
              </div>
            </fieldset>
          )}
        </div>
        <div
          className="settings-page__section"
        >
          <div className="settings-page__section-header">
            <button
                type="button"
                onClick={() => toggleSection("ticketmaster")}
                className="settings-page__section-toggle"
                aria-expanded={!collapsedSections.ticketmaster}
              >
                <ChevronDown
                  className={`settings-page__section-toggle-icon${collapsedSections.ticketmaster ? " is-collapsed" : ""}`}
                />
                <span>Ticketmaster</span>
              </button>
            <div className="settings-page__inline-row">
              {health?.ticketmasterConfigured && (
                <span className="settings-page__status">
                  <CheckCircle className="settings-page__status-icon" />
                  Configured
                </span>
              )}
            </div>
          </div>
          {!collapsedSections.ticketmaster && (
            <fieldset className="settings-page__fields">
              <div
                className="settings-page__callout"
              >
                <p className="artist-field-label">
                  Get an API key
                </p>
                <p className="settings-page__callout-copy">
                  Register on the developers portal. After the registration, the
                  default application will be created. The application contains
                  a Consumer Key that is used for authentication.
                </p>
                <a
                  href="https://developer-acct.ticketmaster.com/user/login"
                  target="_blank"
                  rel="noopener noreferrer"
                  className="settings-page__link"
                >
                  Open the Ticketmaster developer portal
                </a>
              </div>
              <div>
                <label
                  className="artist-field-label"
                >
                  Consumer Key
                </label>
                <SettingsInput type="password"

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
                <p className="settings-page__hint">
                  Used for the Discover page&apos;s nearby shows section.
                </p>
              </div>
              <div>
                <label
                  className="artist-field-label"
                >
                  Search Radius (miles)
                </label>
                <SettingsInput type="number"
                  min={5}
                  max={250}
                  step={5}

                  value={
                    settings.integrations?.ticketmaster?.searchRadiusMiles ?? 250
                  }
                  onChange={(e) => {
                    const raw = Number(e.target.value);
                    const value = Number.isFinite(raw)
                      ? Math.max(5, Math.min(250, Math.floor(raw)))
                      : 250;
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
                <p className="settings-page__hint">
                  Controls how far from your selected area Ticketmaster events
                  are searched.
                </p>
              </div>
              <label className="settings-page__toggle-row">
                <span >
                  Include recommended artists in local shows
                </span>
                <input
                  type="checkbox"
                  className="artist-checkbox"
                  checked={localDiscoveryIncludeRecommendations}
                  onChange={(e) =>
                    updateSettings({
                      ...settings,
                      integrations: {
                        ...settings.integrations,
                        ticketmaster: {
                          ...(settings.integrations?.ticketmaster || {}),
                          localDiscoveryIncludeRecommendations:
                            e.target.checked,
                        },
                      },
                    })
                  }
                />
              </label>
              <label className="settings-page__toggle-row">
                <span >
                  Include trending artists in local shows
                </span>
                <input
                  type="checkbox"
                  className="artist-checkbox"
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
        <div className="settings-page__section">
          <div className="settings-page__section-header">
            <button
              type="button"
              onClick={() => toggleSection("slskd")}
              className="settings-page__section-toggle"
              aria-expanded={!collapsedSections.slskd}
            >
              <ChevronDown
                className={`settings-page__section-toggle-icon${collapsedSections.slskd ? " is-collapsed" : ""}`}
              />
              <span>slskd</span>
            </button>
            <div className="settings-page__inline-row">
              {settings.integrations?.slskd?.url &&
                settings.integrations?.slskd?.apiKey && (
                  <span className="settings-page__status">
                    <CheckCircle className="settings-page__status-icon" />
                    Configured
                  </span>
                )}
            </div>
          </div>
          {!collapsedSections.slskd && (
            <fieldset className="settings-page__fields">
              <div>
                <label className="artist-field-label">Server URL</label>
                <SettingsInput
                  type="url"
                  placeholder="http://localhost:5030"
                  autoComplete="off"
                  value={settings.integrations?.slskd?.url || ""}
                  onChange={(e) =>
                    updateSettings({
                      ...settings,
                      integrations: {
                        ...settings.integrations,
                        slskd: {
                          ...(settings.integrations?.slskd || {}),
                          url: e.target.value,
                        },
                      },
                    })
                  }
                />
              </div>
              <div>
                <label className="artist-field-label">API key</label>
                <div className="settings-page__field-row">
                  <SettingsInput
                    wrapperClassName="settings-page__field-grow"
                    type="password"
                    autoComplete="off"
                    value={settings.integrations?.slskd?.apiKey || ""}
                    onChange={(e) =>
                      updateSettings({
                        ...settings,
                        integrations: {
                          ...settings.integrations,
                          slskd: {
                            ...(settings.integrations?.slskd || {}),
                            apiKey: e.target.value,
                          },
                        },
                      })
                    }
                  />
                  <button
                    type="button"
                    className="btn btn-secondary"
                    disabled={testingSlskd}
                    onClick={async () => {
                      if (
                        !settings.integrations?.slskd?.url ||
                        !settings.integrations?.slskd?.apiKey
                      ) {
                        showError("Enter slskd URL and API key first");
                        return;
                      }
                      setTestingSlskd(true);
                      try {
                        await handleSaveSettings();
                        const result = await testSlskdConnection();
                        if (result.success || result.ok) {
                          if (result.warning || result.soulseekConnected === false) {
                            showInfo(
                              result.message ||
                                "slskd API is reachable, but Soulseek is not connected",
                            );
                          } else {
                            showSuccess(result.message || "slskd connection OK");
                          }
                        } else {
                          showError(result.message || "slskd connection failed");
                        }
                      } catch (error) {
                        showError(
                          error.response?.data?.message ||
                            error.response?.data?.error ||
                            error.message ||
                            "slskd connection failed",
                        );
                      } finally {
                        setTestingSlskd(false);
                      }
                    }}
                  >
                    <RefreshCw
                      className={`artist-icon-sm${testingSlskd ? " animate-spin" : ""}`}
                    />
                    {testingSlskd ? "Testing..." : "Test connection"}
                  </button>
                </div>
              </div>
              <div>
                <label className="artist-field-label">Preferred format</label>
                <SettingsSelect
                  value={settings.integrations?.slskd?.preferredFormat || "flac"}
                  onChange={(e) =>
                    updateSettings({
                      ...settings,
                      integrations: {
                        ...settings.integrations,
                        slskd: {
                          ...(settings.integrations?.slskd || {}),
                          preferredFormat: e.target.value,
                        },
                      },
                    })
                  }
                >
                  <option value="flac">FLAC</option>
                  <option value="mp3">MP3</option>
                </SettingsSelect>
              </div>
              <div>
                <label className="artist-checkbox-label">
                  <input
                    type="checkbox"
                    className="artist-checkbox"
                    checked={
                      settings.integrations?.slskd?.preferredFormatStrict === true
                    }
                    onChange={(e) =>
                      updateSettings({
                        ...settings,
                        integrations: {
                          ...settings.integrations,
                          slskd: {
                            ...(settings.integrations?.slskd || {}),
                            preferredFormatStrict: e.target.checked,
                          },
                        },
                      })
                    }
                  />
                  <span className="artist-field-label">Strict format only</span>
                </label>
                <p className="settings-page__hint settings-page__hint--indented">
                  Used when ranking slskd search results for flows and playlists.
                </p>
              </div>
              <div>
                <label className="artist-checkbox-label">
                  <input
                    type="checkbox"
                    className="artist-checkbox"
                    checked={
                      settings.integrations?.slskd?.cleanupAfterRuns === true
                    }
                    onChange={(e) =>
                      updateSettings({
                        ...settings,
                        integrations: {
                          ...settings.integrations,
                          slskd: {
                            ...(settings.integrations?.slskd || {}),
                            cleanupAfterRuns: e.target.checked,
                          },
                        },
                      })
                    }
                  />
                  <span className="artist-field-label">Clean up after runs</span>
                </label>
                <p className="settings-page__hint settings-page__hint--indented">
                  Clear completed searches and downloads from slskd when a flow or
                  playlist run finishes.
                </p>
              </div>
            </fieldset>
          )}
        </div>
        <div
          className="settings-page__section"
        >
          <div className="settings-page__section-header">
            <button
                type="button"
                onClick={() => toggleSection("navidrome")}
                className="settings-page__section-toggle"
                aria-expanded={!collapsedSections.navidrome}
              >
                <ChevronDown
                  className={`settings-page__section-toggle-icon${collapsedSections.navidrome ? " is-collapsed" : ""}`}
                />
                <span>Subsonic / Navidrome</span>
              </button>
            <div className="settings-page__inline-row">
              {settings.integrations?.navidrome?.url && (
                <span className="settings-page__status">
                  <CheckCircle className="settings-page__status-icon" />
                  Configured
                </span>
              )}
            </div>
          </div>
          {!collapsedSections.navidrome && (
            <fieldset className="settings-page__fields">
              <div>
                <label
                  className="artist-field-label"
                >
                  Server URL
                </label>
                <SettingsInput type="url"

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
              <div>
                <label className="artist-field-label">Username</label>
                <SettingsInput
                  type="text"
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
                <label className="artist-field-label">Password</label>
                <SettingsInput
                  type="password"
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
              <div>
                <label className="artist-checkbox-label">
                  <input
                    type="checkbox"
                    className="artist-checkbox"
                    checked={
                      settings.integrations?.navidrome?.m3uPathMode === "remote"
                    }
                    onChange={(e) =>
                      updateSettings({
                        ...settings,
                        integrations: {
                          ...settings.integrations,
                          navidrome: {
                            ...(settings.integrations?.navidrome || {}),
                            m3uPathMode: e.target.checked ? "remote" : "local",
                          },
                        },
                      })
                    }
                  />
                  <span className="artist-field-label">
                    Use host paths in playlist files
                  </span>
                </label>
                <p className="settings-page__hint settings-page__hint--indented">
                  Enable when Navidrome runs outside Docker but Aurral uses
                  path mappings. Playlist M3U files will reference host paths
                  such as <code>N:\Music\...</code> instead of container paths.
                </p>
              </div>
              <p className="settings-page__hint">
                When using Weekly Flow: set Navidrome&apos;s{" "}
                <code>Scanner.PurgeMissing</code> to <code>always</code> or{" "}
                <code>full</code> (e.g.{" "}
                <code>ND_SCANNER_PURGEMISSING=always</code>) so turning off a
                flow removes those tracks from the library.
              </p>
            </fieldset>
          )}
        </div>
        <div className="settings-page__section">
          <div className="settings-page__section-header">
            <button
              type="button"
              onClick={() => toggleSection("plex")}
              className="settings-page__section-toggle"
              aria-expanded={!collapsedSections.plex}
            >
              <ChevronDown
                className={`settings-page__section-toggle-icon${collapsedSections.plex ? " is-collapsed" : ""}`}
              />
              <span>Plex</span>
            </button>
            <div className="settings-page__inline-row">
              {settings.integrations?.plex?.token &&
                settings.integrations?.plex?.url && (
                  <span className="settings-page__status">
                    <CheckCircle className="settings-page__status-icon" />
                    Configured
                  </span>
                )}
            </div>
          </div>
          {!collapsedSections.plex && (
            <fieldset className="settings-page__fields">
              <p className="settings-page__hint">
                Sign in with your Plex account to let Aurral create a dedicated
                music library pointed at your flow downloads and build a
                playlist for each flow. Playlists appear in Plex and Plexamp.
              </p>
              <div className="settings-page__inline-row">
                <button
                  type="button"
                  className="btn btn-secondary"
                  onClick={handleConnectPlex}
                  disabled={plexConnecting}
                >
                  {plexConnecting
                    ? "Waiting for Plex…"
                    : settings.integrations?.plex?.token
                      ? "Reconnect Plex account"
                      : "Connect Plex account"}
                </button>
                {settings.integrations?.plex?.token && (
                  <span className="settings-page__status">
                    <CheckCircle className="settings-page__status-icon" />
                    Signed in
                  </span>
                )}
              </div>

              {settings.integrations?.plex?.token && (
                <div>
                  <label className="artist-field-label">Plex server</label>
                  <SettingsSelect
                    value={settings.integrations?.plex?.machineIdentifier || ""}
                    onChange={(e) => {
                      const server = plexServers.find(
                        (s) => s.clientIdentifier === e.target.value,
                      );
                      if (server) handleSelectPlexServer(server);
                    }}
                  >
                    <option value="" disabled>
                      {plexServers.length
                        ? "Select a server…"
                        : "Loading servers…"}
                    </option>
                    {plexServers.map((s) => (
                      <option
                        key={s.clientIdentifier}
                        value={s.clientIdentifier}
                      >
                        {s.name}
                        {s.owned ? "" : " (shared)"}
                      </option>
                    ))}
                  </SettingsSelect>
                </div>
              )}

              <div>
                <label className="artist-field-label">Server URL</label>
                <SettingsInput
                  type="url"
                  placeholder="http://localhost:32400"
                  autoComplete="off"
                  value={settings.integrations?.plex?.url || ""}
                  onChange={(e) => updatePlex({ url: e.target.value })}
                />
                <p className="settings-page__hint">
                  Auto-filled when you select a server, or enter it manually.
                </p>
              </div>

              <div>
                <label className="artist-field-label">
                  Plex downloads path (optional)
                </label>
                <div className="settings-page__field-row">
                  <SettingsInput
                    wrapperClassName="settings-page__field-grow"
                    type="text"
                    placeholder="/data/aurral_downloads"
                    autoComplete="off"
                    value={settings.integrations?.plex?.downloadsPath || ""}
                    onChange={(e) =>
                      updatePlex({ downloadsPath: e.target.value })
                    }
                  />
                  <button
                    type="button"
                    className="btn btn-secondary"
                    onClick={handleToggleBrowse}
                  >
                    {browseOpen ? "Close" : "Browse"}
                  </button>
                </div>
                <p className="settings-page__hint">
                  Only needed if Plex runs in a different container/host than
                  Aurral. Enter the downloads folder path as the{" "}
                  <strong>Plex server</strong> sees it — Aurral appends{" "}
                  <code>/aurral-weekly-flow</code>. Leave blank to use
                  Aurral&apos;s own download path. Browse shows the filesystem
                  as Aurral sees it; type manually if Plex&apos;s mount path
                  differs.
                </p>

                {browseOpen && (
                  <div
                    className="settings-page__section"
                    style={{ marginTop: "0.75rem" }}
                  >
                    <div className="settings-page__inline-row">
                      <code className="settings-page__hint">{browseState.path}</code>
                      <button
                        type="button"
                        className="btn btn-primary btn-sm"
                        onClick={handleUseBrowsedFolder}
                      >
                        Use this folder
                      </button>
                    </div>
                    <div
                      style={{
                        maxHeight: "14rem",
                        overflowY: "auto",
                        marginTop: "0.5rem",
                      }}
                    >
                      {browseLoading ? (
                        <p className="settings-page__hint">Loading…</p>
                      ) : (
                        <ul className="settings-page__fields">
                          {browseState.parent && (
                            <li>
                              <button
                                type="button"
                                className="btn btn-secondary btn-sm"
                                onClick={() => loadBrowse(browseState.parent)}
                              >
                                ..
                              </button>
                            </li>
                          )}
                          {browseState.directories.length === 0 && (
                            <li className="settings-page__hint">
                              No subfolders here.
                            </li>
                          )}
                          {browseState.directories.map((dir) => (
                            <li key={dir.path}>
                              <button
                                type="button"
                                className="btn btn-secondary btn-sm"
                                onClick={() => loadBrowse(dir.path)}
                              >
                                {dir.name}
                              </button>
                            </li>
                          ))}
                        </ul>
                      )}
                    </div>
                  </div>
                )}
              </div>

              <div className="settings-page__inline-row">
                <button
                  type="button"
                  className="btn btn-secondary"
                  onClick={handleTestPlex}
                  disabled={
                    testingPlex ||
                    !settings.integrations?.plex?.url ||
                    !settings.integrations?.plex?.token
                  }
                >
                  {testingPlex ? "Testing…" : "Test connection"}
                </button>
                <button
                  type="button"
                  className="btn btn-primary"
                  onClick={handleSyncPlex}
                  disabled={
                    syncingPlex ||
                    !settings.integrations?.plex?.url ||
                    !settings.integrations?.plex?.token
                  }
                >
                  {syncingPlex ? "Syncing…" : "Sync to Plex now"}
                </button>
              </div>
              <p className="settings-page__hint">
                Creates an &quot;Aurral&quot; music library pointed at your
                downloads, scans it, and builds a playlist per flow. The Plex
                server must be able to read the same downloads path Aurral
                writes to. Save settings before syncing.
              </p>
            </fieldset>
          )}
        </div>
      </form>
    </div>
  );
}
