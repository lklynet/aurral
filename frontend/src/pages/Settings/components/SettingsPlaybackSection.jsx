import { useEffect, useState } from "react";
import {
  startPlexAuth,
  checkPlexAuth,
  getPlexResources,
  getPlexLibraries,
  checkPlexLibraryAccess,
  testPlexConnection,
  testNavidromeConnection,
  syncPlexNow,
} from "../../../utils/api/endpoints/settings.js";
import { getConfiguredStatus } from "../utils/integrationStatus";

import {
  AlertTriangle,
  CheckCircle,
  Folder,
  Plus,
  RefreshCw,
  Trash2,
  Wrench,
} from "lucide-react";
import DownloadFolderPickerModal from "../../../components/DownloadFolderPickerModal";
import PillToggle from "../../../components/PillToggle";
import { SettingsInput, SettingsSelect } from "./SettingsField";
import { IntegrationCard, SettingsIntegrationModal } from "./SettingsIntegrationCards";
import {
  SettingsArrCardGrid,
  SettingsArrFieldSet,
  SettingsArrFormGroup,
} from "./arr/SettingsArrLayout";
import { NavidromePathMappingModal } from "./NavidromePathMappingModal";
import {
  SettingsModalActions,
  SettingsModalField,
  SettingsModalIntro,
  SettingsModalSection,
} from "./SettingsModalLayout";
import {
  pickBestPlexConnection,
  resolvePlexConnectionUrl,
} from "../utils/plexConnections";
function coerceNavidromePathMappings(value) {
  if (!Array.isArray(value)) return [];
  return value.map((entry) => ({
    local: String(entry?.local || "").trim(),
    remote: String(entry?.remote || "").trim(),
  }));
}

export function SettingsPlaybackSection({
  settings,
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
  const [navidromeMappingModal, setNavidromeMappingModal] = useState(null);
  const [plexPathPickerOpen, setPlexPathPickerOpen] = useState(false);
  const [plexLibraryPathPickerOpen, setPlexLibraryPathPickerOpen] = useState(false);

  const navidrome = settings.integrations?.navidrome || {};
  const plex = settings.integrations?.plex || {};
  const navidromeConfigured = Boolean(navidrome.url);
  const plexConfigured = Boolean(plex.token && plex.url);
  const plexToken = plex.token;
  const navidromePathMappings = coerceNavidromePathMappings(navidrome.pathMappings).filter(
    (entry) => entry.local || entry.remote,
  );
  const pathMappings = Array.isArray(settings.pathMappings) ? settings.pathMappings : [];
  const plexLibraryMapping = pathMappings.find((entry) => entry?.source === "plex") || null;
  const showNavidromeMappings =
    navidrome.m3uPathMode === "remote" || navidromePathMappings.length > 0;

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

  const updateNavidromePathMappings = (nextMappings) => {
    updateNavidrome({
      pathMappings: coerceNavidromePathMappings(nextMappings),
    });
  };

  const openAddNavidromeMapping = () => {
    setNavidromeMappingModal({ mode: "add", index: null });
  };

  const openEditNavidromeMapping = (index) => {
    setNavidromeMappingModal({ mode: "edit", index });
  };

  const closeNavidromeMappingModal = () => {
    setNavidromeMappingModal(null);
  };

  const saveNavidromeMapping = (mapping) => {
    if (navidromeMappingModal?.mode === "edit" && navidromeMappingModal.index != null) {
      const nextMappings = [...navidromePathMappings];
      nextMappings[navidromeMappingModal.index] = mapping;
      updateNavidromePathMappings(nextMappings);
    } else {
      updateNavidromePathMappings([...navidromePathMappings, mapping]);
    }
    closeNavidromeMappingModal();
  };

  const deleteNavidromeMapping = (index) => {
    updateNavidromePathMappings(
      navidromePathMappings.filter((_entry, entryIndex) => entryIndex !== index),
    );
  };

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
      const result = await testPlexConnection(plex.url, plex.token);
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
    if (!navidrome.url || !navidrome.username) {
      showError("Enter Navidrome URL and username first");
      return;
    }
    setTestingNavidrome(true);
    try {
      if (handleSaveSettings) {
        await handleSaveSettings();
      }
      await testNavidromeConnection(navidrome.url, navidrome.username, navidrome.password || "");
      showSuccess("Navidrome connection OK");
    } catch (err) {
      const errorMsg = err.response?.data?.message || err.response?.data?.error || err.message;
      showError(`Navidrome connection failed: ${errorMsg}`);
    } finally {
      setTestingNavidrome(false);
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

      <SettingsArrFieldSet legend="Navidrome Playlist Paths">
        <div className="arr-info">
          Only needed when Navidrome cannot open Aurral&apos;s container paths, including native
          Navidrome or Docker containers with different mounts.
        </div>

        <SettingsArrFormGroup
          label="M3U path mode"
          help="Generated playlists will use mapped paths that Navidrome can open. Leave this off when Navidrome and Aurral share the same container paths."
        >
          <PillToggle
            className="settings-toggle"
            checked={navidrome.m3uPathMode === "remote"}
            onChange={(event) =>
              updateNavidrome({
                m3uPathMode: event.target.checked ? "remote" : "local",
              })
            }
            aria-label="Use Navidrome paths in M3U files"
          />
        </SettingsArrFormGroup>

        {showNavidromeMappings ? (
          <>
            <p className="arr-form-help arr-form-help--spaced">
              These mappings only change track lines in generated <code>.m3u</code> files. They do
              not help Aurral read files reported by Lidarr, slskd, or NZBGet.
            </p>

            <div className="arr-table-wrap">
              <table className="arr-table">
                <thead>
                  <tr>
                    <th scope="col">Aurral Path</th>
                    <th scope="col">Navidrome Path</th>
                    <th scope="col" className="arr-table__actions-head">
                      <span className="sr-only">Actions</span>
                    </th>
                  </tr>
                </thead>
                <tbody>
                  {navidromePathMappings.length === 0 ? (
                    <tr className="arr-table__empty-row">
                      <td colSpan={3}>No Navidrome path mappings configured.</td>
                    </tr>
                  ) : (
                    navidromePathMappings.map((mapping, index) => (
                      <tr key={`navidrome-path-mapping-${index}`}>
                        <td>
                          <code className="arr-table__path">{mapping.local}</code>
                        </td>
                        <td>
                          <code className="arr-table__path">{mapping.remote}</code>
                        </td>
                        <td className="arr-table__actions">
                          <div className="arr-table__actions-inner">
                            <button
                              type="button"
                              className="arr-btn arr-btn--ghost arr-btn--icon"
                              aria-label={`Edit Navidrome path mapping ${index + 1}`}
                              onClick={() => openEditNavidromeMapping(index)}
                            >
                              <Wrench className="artist-icon-sm" aria-hidden />
                            </button>
                            <button
                              type="button"
                              className="arr-btn arr-btn--ghost arr-btn--icon"
                              aria-label={`Delete Navidrome path mapping ${index + 1}`}
                              onClick={() => deleteNavidromeMapping(index)}
                            >
                              <Trash2 className="artist-icon-sm" aria-hidden />
                            </button>
                          </div>
                        </td>
                      </tr>
                    ))
                  )}
                </tbody>
              </table>
            </div>

            <div className="arr-table-footer">
              <button
                type="button"
                className="arr-btn arr-btn--ghost arr-btn--icon"
                aria-label="Add Navidrome path mapping"
                onClick={openAddNavidromeMapping}
              >
                <Plus className="artist-icon-sm" aria-hidden />
              </button>
            </div>
          </>
        ) : null}

        <p className="arr-form-help">
          When using Weekly Flow: set Navidrome&apos;s <code>Scanner.PurgeMissing</code> to{" "}
          <code>always</code> or <code>full</code> (e.g. <code>ND_SCANNER_PURGEMISSING=always</code>
          ) so turning off a flow removes those tracks from the library.
        </p>
      </SettingsArrFieldSet>

      {navidromeMappingModal ? (
        <NavidromePathMappingModal
          title={
            navidromeMappingModal.mode === "edit"
              ? "Edit Navidrome Path Mapping"
              : "Add Navidrome Path Mapping"
          }
          initialValue={
            navidromeMappingModal.mode === "edit" && navidromeMappingModal.index != null
              ? navidromePathMappings[navidromeMappingModal.index]
              : undefined
          }
          onClose={closeNavidromeMappingModal}
          onSave={saveNavidromeMapping}
        />
      ) : null}

      {activeModal === "navidrome" && (
        <SettingsIntegrationModal
          title="Subsonic / Navidrome"
          onClose={closeModal}
          footerActions={
            <button
              type="button"
              className="btn btn-secondary"
              onClick={handleTestNavidrome}
              disabled={testingNavidrome || !navidrome.url || !navidrome.username}
            >
              <RefreshCw className={`artist-icon-sm${testingNavidrome ? " animate-spin" : ""}`} />
              {testingNavidrome ? "Testing…" : "Test connection"}
            </button>
          }
        >
          <SettingsModalSection title="Connection">
            <SettingsModalField label="Server URL">
              <SettingsInput
                type="url"
                placeholder="https://music.example.com"
                autoComplete="off"
                value={navidrome.url || ""}
                onChange={(event) => updateNavidrome({ url: event.target.value })}
              />
            </SettingsModalField>
            <SettingsModalField label="Username">
              <SettingsInput
                type="text"
                autoComplete="off"
                value={navidrome.username || ""}
                onChange={(event) => updateNavidrome({ username: event.target.value })}
              />
            </SettingsModalField>
            <SettingsModalField label="Password">
              <SettingsInput
                type="password"
                autoComplete="off"
                value={navidrome.password || ""}
                onChange={(event) => updateNavidrome({ password: event.target.value })}
              />
            </SettingsModalField>
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

          <SettingsModalSection title="Login">
            <SettingsModalField
              label="Allow signing in to Aurral with Plex"
              hint="Users who explicitly connect their own Plex account from their profile can then sign in with it. It never creates new Aurral accounts or changes anyone's role."
            >
              <PillToggle
                className="settings-toggle"
                checked={plex.loginEnabled === true}
                disabled={!plexConfigured}
                onChange={(event) => updatePlex({ loginEnabled: event.target.checked })}
                aria-label="Allow signing in to Aurral with Plex"
              />
            </SettingsModalField>
          </SettingsModalSection>

          <SettingsModalSection title="Connection">
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
            <SettingsModalField
              label="Server URL"
              hint="Auto-filled when you select a server, or enter it manually."
            >
              <SettingsInput
                type="url"
                placeholder="http://localhost:32400"
                autoComplete="off"
                value={plex.url || ""}
                onChange={(event) => updatePlex({ url: event.target.value })}
              />
            </SettingsModalField>
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
