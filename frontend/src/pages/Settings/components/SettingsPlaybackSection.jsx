import { useEffect, useState } from "react";
import { Link } from "react-router-dom";
import {
  startPlexAuth,
  checkPlexAuth,
  getPlexResources,
  getPlexLibraries,
  checkPlexLibraryAccess,
  testPlaybackConnection,
  syncPlexNow,
} from "../../../utils/api/endpoints/settings.js";
import {
  getLastfmScrobbleLink,
  getScrobbleStatus,
  linkKoito,
  linkListenBrainz,
  unlinkScrobbleProvider,
} from "../../../utils/api/endpoints/auth.js";
import { getConfiguredStatus } from "../utils/integrationStatus";

import {
  AlertTriangle,
  CheckCircle,
  Folder,
  RefreshCw,
} from "lucide-react";
import DownloadFolderPickerModal from "../../../components/DownloadFolderPickerModal";
import { SettingsInput, SettingsSelect } from "./SettingsField";
import { SettingsAdapterFields } from "./SettingsAdapterFields";
import { IntegrationCard, SettingsIntegrationModal } from "./SettingsIntegrationCards";
import {
  SettingsArrCardGrid,
  SettingsArrFieldSet,
} from "./arr/SettingsArrLayout";
import {
  SettingsModalActions,
  SettingsModalCallout,
  SettingsModalField,
  SettingsModalIntro,
  SettingsModalSection,
  SettingsModalToggle,
  SettingsModalToggleGroup,
} from "./SettingsModalLayout";
import {
  pickBestPlexConnection,
  resolvePlexConnectionUrl,
} from "../utils/plexConnections";
export function SettingsPlaybackSection({
  settings,
  playbackSettings,
  updateSettings,
  hasUnsavedChanges,
  handleSaveSettings,
  showSuccess,
  showError,
  showInfo,
}) {
  const [activeModal, setActiveModal] = useState(null);
  const [plexConnecting, setPlexConnecting] = useState(false);
  const [testingPlex, setTestingPlex] = useState(false);
  const [testingNavidrome, setTestingNavidrome] = useState(false);
  const [syncingPlex, setSyncingPlex] = useState(false);
  const [plexServers, setPlexServers] = useState([]);
  const [plexLibraries, setPlexLibraries] = useState([]);
  const [libraryAccessCheck, setLibraryAccessCheck] = useState(null);
  const [plexPathPickerOpen, setPlexPathPickerOpen] = useState(false);
  const [plexLibraryPathPickerOpen, setPlexLibraryPathPickerOpen] = useState(false);
  const [scrobbleStatus, setScrobbleStatus] = useState(null);
  const [listenBrainzToken, setListenBrainzToken] = useState("");
  const [koitoToken, setKoitoToken] = useState("");
  const [koitoUrl, setKoitoUrl] = useState("");

  const navidrome = settings.integrations?.navidrome || {};
  const plex = settings.integrations?.plex || {};
  const navidromeConfigured = Boolean(navidrome.url);
  const plexConfigured = Boolean(plex.token && plex.url);
  const plexToken = plex.token;
  const pathMappings = Array.isArray(settings.pathMappings) ? settings.pathMappings : [];
  const plexLibraryMapping = pathMappings.find((entry) => entry?.source === "plex") || null;

  const refreshScrobbleStatus = () => getScrobbleStatus().then(setScrobbleStatus).catch(() => {});

  useEffect(() => {
    getScrobbleStatus().then(setScrobbleStatus).catch(() => {});
  }, []);

  const closeModal = () => {
    setActiveModal(null);
    setPlexPathPickerOpen(false);
  };

  const updateNavidrome = (patch) =>
    updateSettings({
      ...settings,
      integrations: {
        ...settings.integrations,
        navidrome: { ...navidrome, ...patch },
      },
    });

  const updatePlex = (patch) =>
    updateSettings({
      ...settings,
      integrations: {
        ...settings.integrations,
        plex: { ...plex, ...patch },
      },
    });

  const updatePlexLibraryLocalPath = (localPath) => {
    const trimmed = String(localPath || "").trim();
    const others = pathMappings.filter((entry) => entry?.source !== "plex");
    if (!trimmed) {
      updateSettings({ ...settings, pathMappings: others });
      return;
    }
    const remote = libraryAccessCheck?.reportedPath || plexLibraryMapping?.remote || "";
    updateSettings({
      ...settings,
      pathMappings: [...others, { source: "plex", remote, local: trimmed }],
    });
  };

  const loadPlexServers = async (token) => {
    const { servers } = await getPlexResources(token);
    const list = Array.isArray(servers) ? servers : [];
    setPlexServers(list);
    return list;
  };

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

  useEffect(() => {
    if (!plexConfigured) {
      setPlexLibraries([]);
      return;
    }
    let cancelled = false;
    getPlexLibraries()
      .then(({ libraries }) => {
        if (!cancelled) setPlexLibraries(Array.isArray(libraries) ? libraries : []);
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, [plexConfigured]);

  useEffect(() => {
    const sectionId = plex.mainLibrarySectionId;
    if (!sectionId) {
      setLibraryAccessCheck(null);
      return;
    }
    let cancelled = false;
    setLibraryAccessCheck({ checking: true });
    checkPlexLibraryAccess(sectionId)
      .then((result) => {
        if (!cancelled) setLibraryAccessCheck({ checking: false, ...result });
      })
      .catch(() => {
        if (!cancelled) setLibraryAccessCheck({ checking: false, checked: false });
      });
    return () => {
      cancelled = true;
    };
  }, [plex.mainLibrarySectionId]);

  const handleConnectPlex = async () => {
    setPlexConnecting(true);
    try {
      const { pinId, code, authUrl, clientId } = await startPlexAuth();
      const popup = window.open(authUrl, "plex-auth", "width=600,height=700");
      const deadline = Date.now() + 3 * 60 * 1000;
      let token = null;
      let plexUsername = null;
      while (Date.now() < deadline) {
        await new Promise((r) => setTimeout(r, 2000));
        try {
          const res = await checkPlexAuth(pinId, code);
          if (res.token) {
            token = res.token;
            plexUsername = res.plexUsername || null;
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
      const patch = { token, plexUsername, ...(clientId ? { clientId } : {}) };
      if (owned.length === 1) {
        const best = pickBestPlexConnection(owned[0]);
        const url = resolvePlexConnectionUrl(best);
        if (url) {
          patch.url = url;
          patch.machineIdentifier = owned[0].clientIdentifier;
        }
      }
      updatePlex(patch);
      showSuccess(
        owned.length === 1 && patch.url
          ? `Signed in and selected "${owned[0].name}". Changes save automatically.`
          : "Signed in to Plex. Select your server below.",
      );
    } catch (err) {
      const errorMsg = err.response?.data?.message || err.response?.data?.error || err.message;
      showError(`Plex sign-in failed: ${errorMsg}`);
    } finally {
      setPlexConnecting(false);
    }
  };

  const handleSelectPlexServer = (server) => {
    const best = pickBestPlexConnection(server);
    const url = resolvePlexConnectionUrl(best);
    if (!url) {
      showError("Selected Plex server has no usable connection.");
      return;
    }
    updatePlex({ url, machineIdentifier: server.clientIdentifier });
    showInfo(`Selected "${server.name}". Changes save automatically.`);
  };

  const handleDisconnectPlex = () => {
    updatePlex({
      token: "",
      url: "",
      machineIdentifier: "",
    });
    setPlexServers([]);
    showInfo("Plex disconnected. Changes save automatically.");
  };

  const handleTestPlex = async () => {
    if (!plex.url || !plex.token) {
      showError("Connect to Plex and select a server first");
      return;
    }
    setTestingPlex(true);
    try {
      const result = await testPlaybackConnection("plex", plex);
      if (result.success) {
        showSuccess(`Plex connection successful!${result.version ? ` (v${result.version})` : ""}`);
        if (result.machineIdentifier) {
          updatePlex({ machineIdentifier: result.machineIdentifier });
        }
      } else {
        showError(`Connection failed: ${result.message || result.error}`);
      }
    } catch (err) {
      const errorMsg = err.response?.data?.message || err.response?.data?.error || err.message;
      showError(`Connection failed: ${errorMsg}`);
    } finally {
      setTestingPlex(false);
    }
  };

  const handleTestNavidrome = async () => {
    if (!navidrome.url || !navidrome.username || !navidrome.password) {
      showError("Enter Navidrome URL, username, and password first");
      return;
    }
    setTestingNavidrome(true);
    try {
      if (handleSaveSettings) {
        await handleSaveSettings();
      }
      await testPlaybackConnection("navidrome", navidrome);
      showSuccess("Navidrome connection OK");
    } catch (err) {
      const errorMsg = err.response?.data?.message || err.response?.data?.error || err.message;
      showError(`Navidrome connection failed: ${errorMsg}`);
    } finally {
      setTestingNavidrome(false);
    }
  };

  const handleLastfmLink = async () => {
    if (scrobbleStatus?.lastfm?.configured !== true) {
      setActiveModal("lastfm");
      return;
    }
    try {
      const result = await getLastfmScrobbleLink();
      if (!result.authorizeUrl) {
        showError("Could not start Last.fm linking.");
        return;
      }
      const popup = window.open(
        result.authorizeUrl,
        "aurral-lastfm-link",
        "popup,width=600,height=700",
      );
      if (!popup) {
        showError("Allow popups to link Last.fm.");
        return;
      }
      const timer = window.setInterval(() => {
        if (popup.closed) {
          window.clearInterval(timer);
          refreshScrobbleStatus();
        }
      }, 500);
    } catch (error) {
      showError(error.response?.data?.error || error.message || "Could not start Last.fm linking");
    }
  };

  const handleListenBrainzLink = async () => {
    try {
      await linkListenBrainz(listenBrainzToken);
      setListenBrainzToken("");
      refreshScrobbleStatus();
      showSuccess("ListenBrainz connected.");
    } catch (error) {
      showError(error.response?.data?.error || error.message || "Could not connect ListenBrainz");
    }
  };

  const handleKoitoLink = async () => {
    try {
      await linkKoito(koitoToken, koitoUrl);
      setKoitoToken("");
      refreshScrobbleStatus();
      showSuccess("Koito connected.");
    } catch (error) {
      showError(error.response?.data?.error || error.message || "Could not connect Koito");
    }
  };

  const handleUnlink = async (provider) => {
    try {
      await unlinkScrobbleProvider(provider);
      setActiveModal(null);
      refreshScrobbleStatus();
      showSuccess(
        `${provider === "lastfm" ? "Last.fm" : provider === "listenbrainz" ? "ListenBrainz" : "Koito"} disconnected.`,
      );
    } catch (error) {
      showError(error.response?.data?.error || error.message || "Could not disconnect provider");
    }
  };

  const handleScrobbleToggle = (provider, enabled) => {
    if (enabled) {
      if (provider === "lastfm" && scrobbleStatus?.lastfm?.configured !== true) {
        setActiveModal("lastfm");
        return;
      }
      setActiveModal(provider);
    } else {
      void handleUnlink(provider);
    }
  };

  const handleSyncPlex = async () => {
    if (hasUnsavedChanges) {
      const saved = await handleSaveSettings?.();
      if (saved !== true) return;
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
      const errorMsg = err.response?.data?.message || err.response?.data?.error || err.message;
      showError(`Plex sync failed: ${errorMsg}`);
    } finally {
      setSyncingPlex(false);
    }
  };

  const selectedPlexServer = plexServers.find(
    (server) => server.clientIdentifier === plex.machineIdentifier,
  );
  const navidromeMeta = navidrome.username || navidrome.url || "Subsonic API";
  const plexMeta = selectedPlexServer?.name || (plex.token ? "Signed in" : "Flow playlists");

  return (
    <>
      <SettingsArrFieldSet legend="Playback Servers">
        <div className="arr-info">
          Servers Aurral writes playlists to for in-app and external playback.
        </div>
        <SettingsArrCardGrid>
          <IntegrationCard
            title="Navidrome"
            subtitle="Subsonic"
            status={getConfiguredStatus(navidromeConfigured)}
            meta={navidromeMeta}
            onClick={() => setActiveModal("navidrome")}
          />
          <IntegrationCard
            title="Plex"
            subtitle="Plexamp"
            status={getConfiguredStatus(plexConfigured)}
            meta={plexMeta}
            onClick={() => setActiveModal("plex")}
          />
        </SettingsArrCardGrid>
      </SettingsArrFieldSet>

      <SettingsArrFieldSet legend="Scrobbling">
        <div className="arr-info">
          Send completed local plays to your connected listening services. Aurral uses the same
          provider flows as Navidrome; a Navidrome connection is not required.
        </div>
        <SettingsModalToggleGroup>
          {["lastfm", "listenbrainz", "koito"].map((provider) => {
            const status = scrobbleStatus?.[provider];
            const label = provider === "lastfm"
              ? status?.displayName
                ? `Last.fm — ${status.displayName}`
                : "Last.fm"
              : provider === "listenbrainz"
                ? "ListenBrainz"
                : "Koito";
            return (
              <SettingsModalToggle
                key={provider}
                label={label}
                checked={status?.connected === true}
                disabled={!status}
                onChange={(event) => handleScrobbleToggle(provider, event.target.checked)}
              />
            );
          })}
        </SettingsModalToggleGroup>
        {scrobbleStatus && scrobbleStatus.lastfm?.configured !== true ? (
          <SettingsModalCallout>
            Last.fm API key and secret are required before connecting an account. Add them in{" "}
            <Link to="/settings/connect" className="settings-page__link">
              Settings → Connect → Last.fm
            </Link>
            .
          </SettingsModalCallout>
        ) : null}
      </SettingsArrFieldSet>

      {activeModal === "lastfm" && (
        <SettingsIntegrationModal title="Last.fm scrobbling" onClose={closeModal}>
          <SettingsModalIntro>
            Link the Last.fm account that receives completed local plays. Aurral runs the same
            Last.fm flow Navidrome uses; Navidrome is not required.
          </SettingsModalIntro>
          {scrobbleStatus?.lastfm?.configured !== true ? (
            <SettingsModalCallout>
              Last.fm API key and secret are required first. Add them in{" "}
              <Link to="/settings/connect" className="settings-page__link">
                Settings → Connect → Last.fm
              </Link>
              .
            </SettingsModalCallout>
          ) : null}
          <SettingsModalActions>
            {scrobbleStatus?.lastfm?.configured === true ? (
              <button type="button" className="arr-btn arr-btn--secondary" onClick={handleLastfmLink}>
                {scrobbleStatus?.lastfm?.connected ? "Relink Last.fm" : "Connect Last.fm account"}
              </button>
            ) : null}
            {scrobbleStatus?.lastfm?.connected ? (
              <button type="button" className="arr-btn arr-btn--ghost" onClick={() => handleUnlink("lastfm")}>
                Disconnect
              </button>
            ) : null}
          </SettingsModalActions>
        </SettingsIntegrationModal>
      )}

      {activeModal === "listenbrainz" && (
        <SettingsIntegrationModal title="ListenBrainz scrobbling" onClose={closeModal}>
          <SettingsModalIntro>
            Enter a ListenBrainz user token. Aurral validates and stores it directly; Navidrome is
            not required.
          </SettingsModalIntro>
          <SettingsModalSection title="Connection">
            <SettingsModalField label="User token">
              <SettingsInput
                type="password"
                placeholder="ListenBrainz user token"
                autoComplete="off"
                value={listenBrainzToken}
                onChange={(event) => setListenBrainzToken(event.target.value)}
              />
            </SettingsModalField>
          </SettingsModalSection>
          <SettingsModalActions>
            <button type="button" className="arr-btn arr-btn--secondary" disabled={!listenBrainzToken} onClick={handleListenBrainzLink}>
              Connect ListenBrainz
            </button>
            {scrobbleStatus?.listenbrainz?.connected ? (
              <button type="button" className="arr-btn arr-btn--ghost" onClick={() => handleUnlink("listenbrainz")}>
                Disconnect
              </button>
            ) : null}
          </SettingsModalActions>
        </SettingsIntegrationModal>
      )}

      {activeModal === "koito" && (
        <SettingsIntegrationModal title="Koito scrobbling" onClose={closeModal}>
          <SettingsModalIntro>Koito accepts the ListenBrainz submission format and API key.</SettingsModalIntro>
          <SettingsModalSection title="Connection">
            <SettingsModalField label="Koito URL">
              <SettingsInput type="url" placeholder="https://koito.example.com" value={koitoUrl} onChange={(event) => setKoitoUrl(event.target.value)} />
            </SettingsModalField>
            <SettingsModalField label="API key">
              <SettingsInput type="password" placeholder="Koito API key" autoComplete="off" value={koitoToken} onChange={(event) => setKoitoToken(event.target.value)} />
            </SettingsModalField>
          </SettingsModalSection>
          <SettingsModalActions>
            <button type="button" className="arr-btn arr-btn--secondary" disabled={!koitoToken} onClick={handleKoitoLink}>
              Connect Koito
            </button>
            {scrobbleStatus?.koito?.connected ? (
              <button type="button" className="arr-btn arr-btn--ghost" onClick={() => handleUnlink("koito")}>
                Disconnect
              </button>
            ) : null}
          </SettingsModalActions>
        </SettingsIntegrationModal>
      )}

      {activeModal === "navidrome" && (
        <SettingsIntegrationModal
          title="Subsonic / Navidrome"
          onClose={closeModal}
          footerActions={
            <button
              type="button"
              className="btn btn-secondary"
              onClick={handleTestNavidrome}
              disabled={testingNavidrome || !navidrome.url || !navidrome.username || !navidrome.password}
            >
              <RefreshCw className={`artist-icon-sm${testingNavidrome ? " animate-spin" : ""}`} />
              {testingNavidrome ? "Testing…" : "Test connection"}
            </button>
          }
        >
          <SettingsModalSection title="Connection">
            <SettingsAdapterFields
              definition={playbackSettings?.navidrome}
              settings={navidrome}
              onChange={updateNavidrome}
            />
          </SettingsModalSection>
        </SettingsIntegrationModal>
      )}

      {activeModal === "plex" && (
        <SettingsIntegrationModal
          title="Plex"
          onClose={closeModal}
          footerActions={
            <button
              type="button"
              className="btn btn-secondary"
              onClick={handleTestPlex}
              disabled={testingPlex || !plex.url || !plex.token}
            >
              <RefreshCw className={`artist-icon-sm${testingPlex ? " animate-spin" : ""}`} />
              {testingPlex ? "Testing…" : "Test connection"}
            </button>
          }
        >
          <SettingsModalIntro>
            Sign in with your Plex account to let Aurral create a dedicated music library pointed at
            your flow downloads and build a playlist for each flow. Playlists appear in Plex and
            Plexamp.
          </SettingsModalIntro>

          <SettingsModalSection title="Account">
            <SettingsModalActions>
              <button
                type="button"
                className="btn btn-secondary"
                onClick={handleConnectPlex}
                disabled={plexConnecting}
              >
                {plexConnecting
                  ? "Waiting for Plex…"
                  : plex.token
                    ? "Reconnect Plex account"
                    : "Connect Plex account"}
              </button>
              {plex.token ? (
                <button
                  type="button"
                  className="btn btn-secondary"
                  onClick={handleDisconnectPlex}
                >
                  Disconnect
                </button>
              ) : null}
              {plex.token && (
                <span className="settings-page__status">
                  <CheckCircle className="settings-page__status-icon" />
                  Signed in
                </span>
              )}
            </SettingsModalActions>
          </SettingsModalSection>

          <SettingsModalSection title="Connection">
            <SettingsAdapterFields
              definition={playbackSettings?.plex}
              settings={plex}
              onChange={updatePlex}
            />
            {plex.token && (
              <SettingsModalField label="Plex server">
                <SettingsSelect
                  value={plex.machineIdentifier || ""}
                  onChange={(event) => {
                    const server = plexServers.find(
                      (entry) => entry.clientIdentifier === event.target.value,
                    );
                    if (server) handleSelectPlexServer(server);
                  }}
                >
                  <option value="" disabled>
                    {plexServers.length ? "Select a server…" : "Loading servers…"}
                  </option>
                  {plexServers.map((server) => (
                    <option key={server.clientIdentifier} value={server.clientIdentifier}>
                      {server.name}
                      {server.owned ? "" : " (shared)"}
                    </option>
                  ))}
                </SettingsSelect>
              </SettingsModalField>
            )}
          </SettingsModalSection>

          <SettingsModalSection title="Aurral Library Path">
            <SettingsModalField
              label="Plex Aurral Library path (optional)"
              hint={
                <>
                  Only needed if Plex runs in a different container/host than Aurral. Enter the
                  downloads folder path as the <strong>Plex server</strong> sees it — Aurral appends{" "}
                  <code>/aurral-weekly-flow</code>. Leave blank to use Aurral&apos;s own download
                  path.
                </>
              }
            >
              <div className="arr-path-input">
                <SettingsInput
                  className="arr-path-input__field"
                  type="text"
                  placeholder="/data/aurral_downloads"
                  autoComplete="off"
                  value={plex.downloadsPath || ""}
                  onChange={(event) => updatePlex({ downloadsPath: event.target.value })}
                />
                <button
                  type="button"
                  className="arr-path-input__browse"
                  onClick={() => setPlexPathPickerOpen(true)}
                  aria-label="Browse folders"
                >
                  <Folder className="artist-icon-xs" />
                </button>
              </div>
            </SettingsModalField>
          </SettingsModalSection>

          {plexPathPickerOpen ? (
            <DownloadFolderPickerModal
              initialPath={plex.downloadsPath || ""}
              createOnConfirm={false}
              onConfirm={(path) => {
                updatePlex({ downloadsPath: String(path || "").trim() });
                setPlexPathPickerOpen(false);
              }}
              onCancel={() => setPlexPathPickerOpen(false)}
            />
          ) : null}

          <SettingsModalSection title="Main library (optional)">
            <SettingsModalField
              label="Include tracks from an existing library"
              hint={
                <>
                  If a flow includes songs you already have in another Plex library — like the
                  one Lidarr manages — Aurral needs this library selected to reuse those songs in
                  Plex playlists; without it, the tracks are silently left out of the playlist.
                </>
              }
            >
              <SettingsSelect
                value={plex.mainLibrarySectionId || ""}
                onChange={(event) => updatePlex({ mainLibrarySectionId: event.target.value })}
                disabled={!plexConfigured}
              >
                <option value="">None</option>
                {plexLibraries.map((library) => (
                  <option key={library.key} value={library.key}>
                    {library.title}
                  </option>
                ))}
              </SettingsSelect>
            </SettingsModalField>

            {plex.mainLibrarySectionId && libraryAccessCheck?.checking ? (
              <p className="settings-modal__hint">
                <RefreshCw className="artist-icon-xs" aria-hidden /> Checking whether Aurral can
                already read this library…
              </p>
            ) : null}

            {plex.mainLibrarySectionId &&
            libraryAccessCheck?.checked &&
            !libraryAccessCheck.accessible ? (
              <p className="settings-modal__hint">
                <AlertTriangle className="artist-icon-xs" aria-hidden /> Aurral can&apos;t read this
                library directly yet. Plex reports its files at{" "}
                <code>{libraryAccessCheck.reportedPath}</code> — set a path mapping below so
                Aurral knows where to find that same file.
              </p>
            ) : null}

            {plex.mainLibrarySectionId && libraryAccessCheck?.checked === false ? (
              <p className="settings-modal__hint">
                {libraryAccessCheck.reason ||
                  "Couldn't check library access right now — you can still set a path mapping manually below if needed."}
              </p>
            ) : null}

            {plex.mainLibrarySectionId &&
            (plexLibraryMapping || (libraryAccessCheck?.checked && !libraryAccessCheck.accessible)) ? (
              <SettingsModalField
                label="Local path for this library (optional)"
                hint={
                  <>
                    Plex reports this library&apos;s files at{" "}
                    <code>{libraryAccessCheck?.reportedPath || plexLibraryMapping?.remote}</code>.
                    Enter that same folder as <strong>Aurral</strong> sees it. Leave blank to
                    remove this mapping.
                  </>
                }
              >
                <div className="arr-path-input">
                  <SettingsInput
                    className="arr-path-input__field"
                    type="text"
                    placeholder="/data/media/music"
                    autoComplete="off"
                    value={plexLibraryMapping?.local || ""}
                    onChange={(event) => updatePlexLibraryLocalPath(event.target.value)}
                  />
                  <button
                    type="button"
                    className="arr-path-input__browse"
                    onClick={() => setPlexLibraryPathPickerOpen(true)}
                    aria-label="Browse folders"
                  >
                    <Folder className="artist-icon-xs" />
                  </button>
                </div>
              </SettingsModalField>
            ) : null}
          </SettingsModalSection>

          {plexLibraryPathPickerOpen ? (
            <DownloadFolderPickerModal
              initialPath={plexLibraryMapping?.local || ""}
              createOnConfirm={false}
              onConfirm={(path) => {
                updatePlexLibraryLocalPath(path);
                setPlexLibraryPathPickerOpen(false);
              }}
              onCancel={() => setPlexLibraryPathPickerOpen(false)}
            />
          ) : null}

          <SettingsModalSection title="Sync">
            <SettingsModalActions>
              <button
                type="button"
                className="btn btn-primary"
                onClick={handleSyncPlex}
                disabled={syncingPlex || !plex.url || !plex.token}
              >
                {syncingPlex ? "Syncing…" : "Sync to Plex now"}
              </button>
            </SettingsModalActions>
            <p className="settings-modal__hint">
              Creates an &quot;Aurral&quot; music library pointed at your downloads, scans it, and
              builds a playlist per flow. The Plex server must be able to read the same downloads
              path Aurral writes to. Changes save automatically before syncing.
            </p>
          </SettingsModalSection>
        </SettingsIntegrationModal>
      )}
    </>
  );
}
