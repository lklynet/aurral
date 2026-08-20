import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { FileJson, Loader2, Music2, Upload } from "lucide-react";
import { Link } from "react-router-dom";
import { ModalShell } from "../../../components/PlaylistModals";
import {
  completeSpotifyOAuth,
  disconnectSpotify,
  getListenBrainzPlaylists,
  getLastfmPlaylists,
  getSpotifyImportStatus,
  getSpotifyPlaylists,
  importSharedPlaylist,
  importListenBrainzPlaylist,
  importLastfmPlaylist,
  importSpotifyPlaylist,
  previewListenBrainzPlaylist,
  previewLastfmPlaylist,
  previewSpotifyPlaylist,
  startSpotifyOAuth,
} from "../../../utils/api/endpoints/playlists.js";
import { getMyListeningHistory, getScrobbleStatus } from "../../../utils/api/endpoints/auth.js";
import { getAppBasePath, normalizeBasePathWithTrailingSlash } from "../../../utils/basePath";
import { parseFlowImportFile, reserveUniqueFlowName, normalizeNameKey } from "../flowPageUtils";

const SYNC_INTERVAL_OPTIONS = [
  { value: 0, label: "None" },
  { value: 6, label: "Every 6 hours" },
  { value: 12, label: "Every 12 hours" },
  { value: 24, label: "Every 24 hours" },
  { value: 72, label: "Every 3 days" },
];

const SPOTIFY_OAUTH_BROADCAST_CHANNEL = "aurral-spotify-oauth";
const SPOTIFY_AUTH_REQUIRED_CODE = "SPOTIFY_AUTH_REQUIRED";

function getPlaylistMeta(playlist) {
  const parts = [
    playlist?.trackCount != null ? `${playlist.trackCount} tracks` : "Playlist",
  ];
  if (playlist?.sourceType === "lastfm-station") parts.push("Updates from Last.fm");
  else if (playlist?.sourceType) parts.push("Updates weekly");
  return parts.join(" · ");
}

function tokensFromHandoffPayload(payload) {
  const accessToken = String(payload?.access_token || "").trim();
  const refreshToken = String(payload?.refresh_token || "").trim();
  if (!accessToken || !refreshToken) return null;
  return {
    accessToken,
    refreshToken,
    expiresIn: payload?.expires_in,
  };
}

function getOAuthCallbackUrl() {
  const base = normalizeBasePathWithTrailingSlash(getAppBasePath());
  return `${window.location.origin}${base}oauth.html`;
}

function openSpotifyOAuthPopup(oauthUrl) {
  return new Promise((resolve, reject) => {
    const popup = window.open(oauthUrl, "spotify-oauth", "width=480,height=720");
    if (!popup || popup.closed || typeof popup.closed === "undefined") {
      reject(new Error("Pop-ups are being blocked by your browser"));
      return;
    }

    let settled = false;
    let channel;
    const cleanup = () => {
      delete window.onCompleteOauth;
      if (channel) {
        channel.close();
        channel = null;
      }
      clearTimeout(timeout);
    };
    const finish = (tokens) => {
      if (settled) return;
      settled = true;
      cleanup();
      resolve(tokens);
    };
    const fail = (message) => {
      if (settled) return;
      settled = true;
      cleanup();
      reject(new Error(message));
    };

    try {
      channel = new BroadcastChannel(SPOTIFY_OAUTH_BROADCAST_CHANNEL);
      channel.onmessage = (event) => {
        if (event.data?.type !== "ready") return;
        const tokens = tokensFromHandoffPayload(event.data?.payload);
        if (tokens) finish(tokens);
      };
    } catch (_) {
      channel = null;
    }

    window.onCompleteOauth = (query, onComplete) => {
      delete window.onCompleteOauth;
      onComplete?.();
      const params = new URLSearchParams(query.startsWith("?") ? query.slice(1) : query);
      const tokens = tokensFromHandoffPayload({
        access_token: params.get("access_token"),
        refresh_token: params.get("refresh_token"),
        expires_in: params.get("expires_in"),
      });
      if (!tokens) {
        fail("Spotify sign-in returned no tokens");
        return;
      }
      finish(tokens);
    };

    const timeout = setTimeout(() => {
      fail("Spotify sign-in timed out");
    }, 5 * 60 * 1000);
  });
}

export function PlaylistImportModal({
  open,
  onClose,
  onImported,
  showError,
  showSuccess,
  existingPlaylistNames = [],
}) {
  const [source, setSource] = useState("spotify");
  const [spotifyStatus, setSpotifyStatus] = useState({ connected: false, displayName: null });
  const [spotifyLoading, setSpotifyLoading] = useState(false);
  const [listenBrainzStatus, setListenBrainzStatus] = useState({ connected: false, displayName: null });
  const [listenBrainzLoading, setListenBrainzLoading] = useState(false);
  const [lastfmUsername, setLastfmUsername] = useState("");
  const [lastfmUsernameInput, setLastfmUsernameInput] = useState("");
  const [lastfmProfileChecked, setLastfmProfileChecked] = useState(false);
  const [lastfmProfileLoading, setLastfmProfileLoading] = useState(false);
  const [lastfmLoading, setLastfmLoading] = useState(false);
  const [playlists, setPlaylists] = useState([]);
  const [playlistQuery, setPlaylistQuery] = useState("");
  const [selectedPlaylist, setSelectedPlaylist] = useState(null);
  const [playlistName, setPlaylistName] = useState("");
  const [syncIntervalHours, setSyncIntervalHours] = useState(24);
  const [keepRemovedTracks, setKeepRemovedTracks] = useState(true);
  const [previewTracks, setPreviewTracks] = useState([]);
  const [previewTrackCount, setPreviewTrackCount] = useState(0);
  const [previewSkipped, setPreviewSkipped] = useState(0);
  const [previewLoading, setPreviewLoading] = useState(false);
  const [importing, setImporting] = useState(false);
  const [jsonReview, setJsonReview] = useState(null);
  const sourceRef = useRef(source);
  const sourceRequestIdRef = useRef(0);
  const loadedLastfmUsernameRef = useRef("");

  const reservedNameKeys = useMemo(
    () =>
      new Set(
        existingPlaylistNames.map((name) => normalizeNameKey(name)).filter(Boolean),
      ),
    [existingPlaylistNames],
  );

  const resetState = useCallback(() => {
    sourceRef.current = "spotify";
    sourceRequestIdRef.current += 1;
    loadedLastfmUsernameRef.current = "";
    setSource("spotify");
    setLastfmUsername("");
    setLastfmUsernameInput("");
    setLastfmProfileChecked(false);
    setPlaylists([]);
    setPlaylistQuery("");
    setSelectedPlaylist(null);
    setPlaylistName("");
    setSyncIntervalHours(24);
    setKeepRemovedTracks(true);
    setPreviewTracks([]);
    setPreviewTrackCount(0);
    setPreviewSkipped(0);
    setJsonReview(null);
  }, []);

  const selectSource = (nextSource) => {
    sourceRef.current = nextSource;
    sourceRequestIdRef.current += 1;
    loadedLastfmUsernameRef.current = "";
    setSource(nextSource);
    setPlaylists([]);
    setPlaylistQuery("");
    setSelectedPlaylist(null);
    setPlaylistName("");
  };

  const handleSpotifyAuthRequired = useCallback((error, requestId) => {
    if (error?.response?.data?.code !== SPOTIFY_AUTH_REQUIRED_CODE) return false;
    if (sourceRef.current !== "spotify" || requestId !== sourceRequestIdRef.current) return false;
    setSpotifyStatus({ connected: false, displayName: null, connectedAt: null });
    resetState();
    return true;
  }, [resetState]);

  useEffect(() => {
    if (!open) {
      resetState();
      return;
    }
    let cancelled = false;
    (async () => {
      try {
        const status = await getSpotifyImportStatus();
        if (!cancelled) setSpotifyStatus(status || { connected: false });
      } catch {
        if (!cancelled) setSpotifyStatus({ connected: false });
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [open, resetState]);

  const loadSpotifyPlaylists = useCallback(async () => {
    const requestId = sourceRequestIdRef.current;
    setSpotifyLoading(true);
    try {
      const payload = await getSpotifyPlaylists();
      setPlaylists(Array.isArray(payload?.playlists) ? payload.playlists : []);
      if (payload?.user) {
        setSpotifyStatus((prev) => ({ ...prev, connected: true, displayName: payload.user }));
      }
    } catch (error) {
      handleSpotifyAuthRequired(error, requestId);
      showError?.(error?.response?.data?.message || error?.message || "Failed to load Spotify playlists");
    } finally {
      setSpotifyLoading(false);
    }
  }, [handleSpotifyAuthRequired, showError]);

  useEffect(() => {
    if (!open || source !== "spotify" || !spotifyStatus.connected) return;
    loadSpotifyPlaylists();
  }, [open, source, spotifyStatus.connected, loadSpotifyPlaylists]);

  const loadListenBrainzPlaylists = useCallback(async () => {
    const requestId = sourceRequestIdRef.current;
    const isCurrent = () =>
      sourceRef.current === "listenbrainz" && requestId === sourceRequestIdRef.current;
    setListenBrainzLoading(true);
    try {
      const statusPayload = await getScrobbleStatus();
      if (!isCurrent()) return;
      const status = statusPayload?.listenbrainz || { connected: false };
      setListenBrainzStatus(status);
      if (!status.connected) {
        setPlaylists([]);
        return;
      }
      const payload = await getListenBrainzPlaylists();
      if (!isCurrent()) return;
      setPlaylists(Array.isArray(payload?.playlists) ? payload.playlists : []);
      if (payload?.user) {
        setListenBrainzStatus((prev) => ({ ...prev, connected: true, displayName: payload.user }));
      }
    } catch (error) {
      if (!isCurrent()) return;
      setListenBrainzStatus({ connected: false, displayName: null });
      setPlaylists([]);
      showError?.(
        error?.response?.data?.message ||
          error?.message ||
          "Failed to load ListenBrainz playlists",
      );
    } finally {
      if (isCurrent()) setListenBrainzLoading(false);
    }
  }, [showError]);

  const loadLastfmPlaylists = useCallback(async (requestedUsername) => {
    const username = String(requestedUsername || "").trim();
    if (!username) return;
    if (loadedLastfmUsernameRef.current === username) return;
    const requestId = sourceRequestIdRef.current;
    const isCurrent = () =>
      sourceRef.current === "lastfm" && requestId === sourceRequestIdRef.current;
    loadedLastfmUsernameRef.current = username;
    setLastfmProfileChecked(true);
    setLastfmLoading(true);
    try {
      const payload = await getLastfmPlaylists(username);
      if (!isCurrent()) return;
      setLastfmUsername(username);
      setLastfmUsernameInput(username);
      setPlaylists(Array.isArray(payload?.playlists) ? payload.playlists : []);
    } catch (error) {
      if (!isCurrent()) return;
      loadedLastfmUsernameRef.current = "";
      setPlaylists([]);
      showError?.(
        error?.response?.data?.message ||
          error?.message ||
          "Failed to load Last.fm stations",
      );
    } finally {
      if (isCurrent()) setLastfmLoading(false);
    }
  }, [showError]);

  useEffect(() => {
    if (!open || source !== "listenbrainz") return;
    loadListenBrainzPlaylists();
  }, [open, source, loadListenBrainzPlaylists]);

  useEffect(() => {
    if (!open || source !== "lastfm") return;
    if (lastfmUsername || lastfmProfileChecked) {
      if (lastfmUsername) loadLastfmPlaylists(lastfmUsername);
      return;
    }
    let cancelled = false;
    setLastfmProfileLoading(true);
    getMyListeningHistory()
      .then((payload) => {
        if (cancelled) return;
        const username =
          payload?.listenHistoryProvider === "lastfm"
            ? String(payload?.listenHistoryUsername || "").trim()
            : "";
        setLastfmUsernameInput(username);
        if (username) setLastfmUsername(username);
        setLastfmProfileChecked(true);
      })
      .catch(() => {})
      .finally(() => {
        if (!cancelled) setLastfmProfileLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [open, source, lastfmProfileChecked, lastfmUsername, loadLastfmPlaylists]);

  useEffect(() => {
    if (!selectedPlaylist?.id) {
      setPreviewTracks([]);
      setPreviewTrackCount(0);
      setPreviewSkipped(0);
      return;
    }
    let cancelled = false;
    const requestId = sourceRequestIdRef.current;
    setPreviewLoading(true);
    (async () => {
      try {
        const payload =
          source === "spotify"
            ? await previewSpotifyPlaylist(selectedPlaylist.id)
            : source === "listenbrainz"
              ? await previewListenBrainzPlaylist(
                  selectedPlaylist.id,
                  selectedPlaylist.sourceType,
                )
              : await previewLastfmPlaylist(selectedPlaylist.id, lastfmUsername);
        if (cancelled) return;
        setPreviewTrackCount(Number(payload?.trackCount || 0));
        setPreviewSkipped(Number(payload?.skipped || 0));
        setPreviewTracks(Array.isArray(payload?.previewTracks) ? payload.previewTracks : []);
      } catch (error) {
        if (!cancelled) {
          handleSpotifyAuthRequired(error, requestId);
          showError?.(error?.response?.data?.message || error?.message || "Failed to preview playlist");
        }
      } finally {
        if (!cancelled) setPreviewLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [handleSpotifyAuthRequired, lastfmUsername, selectedPlaylist, showError, source]);

  const filteredPlaylists = useMemo(() => {
    const query = playlistQuery.trim().toLowerCase();
    if (!query) return playlists;
    return playlists.filter((playlist) => playlist.name.toLowerCase().includes(query));
  }, [playlistQuery, playlists]);

  const handleConnectSpotify = async () => {
    const requestId = sourceRequestIdRef.current;
    setSpotifyLoading(true);
    try {
      const { oauthUrl } = await startSpotifyOAuth(getOAuthCallbackUrl());
      const tokens = await openSpotifyOAuthPopup(oauthUrl);
      const status = await completeSpotifyOAuth(tokens);
      setSpotifyStatus({
        connected: true,
        displayName: status?.displayName || null,
        connectedAt: status?.connectedAt || null,
      });
      await loadSpotifyPlaylists();
    } catch (error) {
      handleSpotifyAuthRequired(error, requestId);
      showError?.(
        error?.response?.data?.message || error?.message || "Failed to connect Spotify",
      );
    } finally {
      setSpotifyLoading(false);
    }
  };

  const handleDisconnectSpotify = async () => {
    setSpotifyLoading(true);
    try {
      await disconnectSpotify();
      setSpotifyStatus({ connected: false, displayName: null });
      setPlaylists([]);
      setSelectedPlaylist(null);
    } catch (error) {
      showError?.(error?.message || "Failed to disconnect Spotify");
    } finally {
      setSpotifyLoading(false);
    }
  };

  const handleSelectPlaylist = (playlist) => {
    setSelectedPlaylist(playlist);
    setPlaylistName(playlist?.name || "");
  };

  const handleJsonFileChange = async (event) => {
    const file = event.target.files?.[0];
    if (!file) return;
    try {
      const content = await file.text();
      const flows = parseFlowImportFile(content).map((flow) => ({
        ...flow,
        importName: flow?.name || "",
      }));
      setJsonReview({ fileName: file.name, flows });
    } catch (error) {
      showError?.(error?.message || "Failed to read tracklist file");
    } finally {
      event.target.value = "";
    }
  };

  const handleImportExternal = async () => {
    if (!selectedPlaylist?.id || importing) return;
    const baseName = String(playlistName || selectedPlaylist.name || "").trim();
    if (!baseName) {
      showError?.("Playlist name is required");
      return;
    }
    const reservedNames = new Set(reservedNameKeys);
    const finalName = reserveUniqueFlowName(reservedNames, baseName);
    const isListenBrainz = source === "listenbrainz";
    const isLastfm = source === "lastfm";
    const providerLabel = isListenBrainz ? "ListenBrainz" : isLastfm ? "Last.fm" : "Spotify";
    const requestId = sourceRequestIdRef.current;
    setImporting(true);
    try {
      const importPlaylist = isListenBrainz
        ? importListenBrainzPlaylist
        : isLastfm
          ? importLastfmPlaylist
          : importSpotifyPlaylist;
      await importPlaylist({
        playlistId: selectedPlaylist.id,
        ...(isListenBrainz && selectedPlaylist.sourceType
          ? { playlistType: selectedPlaylist.sourceType }
          : {}),
        ...(isLastfm ? { username: lastfmUsername } : {}),
        externalName: selectedPlaylist.name,
        name: finalName,
        syncEnabled: syncIntervalHours > 0,
        syncIntervalHours,
        keepRemovedTracks,
      });
      showSuccess?.(`Imported ${finalName} from ${providerLabel}`);
      onImported?.();
      onClose?.();
    } catch (error) {
      handleSpotifyAuthRequired(error, requestId);
      showError?.(
        error?.response?.data?.message ||
          error?.response?.data?.error ||
          error?.message ||
          `Failed to import ${providerLabel} playlist`,
      );
    } finally {
      setImporting(false);
    }
  };

  const handleImportJson = async () => {
    if (!jsonReview || importing) return;
    setImporting(true);
    const reservedNames = new Set(reservedNameKeys);
    let importedCount = 0;
    const failed = [];
    for (const payload of jsonReview.flows) {
      const desiredName = String(payload?.importName ?? payload?.name ?? "").trim();
      const baseName = desiredName || String(payload?.name || "").trim();
      const finalName = reserveUniqueFlowName(reservedNames, baseName);
      try {
        await importSharedPlaylist({
          name: finalName,
          sourceName: payload?.sourceName || null,
          sourceFlowId: payload?.sourceFlowId || null,
          tracks: payload?.tracks || [],
        });
        importedCount += 1;
      } catch (error) {
        failed.push({
          name: finalName,
          message:
            error?.response?.data?.message ||
            error?.response?.data?.error ||
            error?.message ||
            "Failed to import tracklist",
        });
      }
    }
    setImporting(false);
    if (importedCount > 0) {
      showSuccess?.(`${importedCount} ${importedCount === 1 ? "playlist" : "playlists"} imported`);
      onImported?.();
      onClose?.();
    }
    if (failed.length > 0) {
      const first = failed[0];
      showError?.(
        failed.length === 1
          ? `${first.name}: ${first.message}`
          : `${failed.length} imports failed. First issue: ${first.name} - ${first.message}`,
      );
    }
  };

  const canImportExternal = selectedPlaylist?.id && previewTrackCount > 0 && !previewLoading;
  const canImportJson = Boolean(jsonReview?.flows?.length);
  const externalSource =
    source === "listenbrainz" ? "ListenBrainz" : source === "lastfm" ? "Last.fm" : "Spotify";

  return (
    <ModalShell
      open={open}
      title="Import playlist"
      description={
        source === "spotify"
          ? "Pick a Spotify playlist to queue downloads and optionally sync it."
          : source === "listenbrainz"
            ? "Pick a playlist to queue downloads. Weekly playlists use the latest week."
            : source === "lastfm"
              ? "Pick a Last.fm station to queue downloads and optionally sync it."
            : "Import a JSON tracklist from Aurral or another tool."
      }
      onClose={onClose}
      disableClose={importing}
      footer={
        <>
          <button
            type="button"
            onClick={onClose}
            className="btn btn-secondary btn-sm"
            disabled={importing}
          >
            Cancel
          </button>
          {source !== "json" ? (
            <button
              type="button"
              onClick={handleImportExternal}
              className="btn btn-primary btn-sm"
              disabled={importing || !canImportExternal}
            >
              {importing ? <Loader2 className="artist-icon-sm animate-spin" /> : <Music2 className="artist-icon-sm" />}
              Import playlist
            </button>
          ) : (
            <button
              type="button"
              onClick={handleImportJson}
              className="btn btn-primary btn-sm"
              disabled={importing || !canImportJson}
            >
              {importing ? <Loader2 className="artist-icon-sm animate-spin" /> : <Upload className="artist-icon-sm" />}
              Import JSON
            </button>
          )}
        </>
      }
    >
      <div className="playlist-import">
        <div
          className="artist-segmented playlist-import__segmented"
          role="group"
          aria-label="Import source"
        >
          {[
            { id: "spotify", label: "Spotify" },
            { id: "lastfm", label: "Last.fm" },
            { id: "listenbrainz", label: "ListenBrainz" },
            { id: "json", label: "JSON file" },
          ].map((option) => (
            <button
              key={option.id}
              type="button"
              className={`artist-segmented-button${source === option.id ? " is-active" : ""}`}
              onClick={() => selectSource(option.id)}
              disabled={importing}
            >
              {option.label}
            </button>
          ))}
        </div>

        {source !== "json" ? (
          <div className="playlist-import__spotify">
            {source === "spotify" && !spotifyStatus.connected ? (
              <div className="playlist-import__empty">
                <div className="playlist-import__empty-icon" aria-hidden="true">
                  <Music2 />
                </div>
                <p className="playlist-import__empty-title">Connect your Spotify account</p>
                <p className="playlist-import__empty-copy">
                  Pick playlists from your library and optionally keep them in sync.
                </p>
                <button
                  type="button"
                  className="btn btn-primary btn-sm"
                  onClick={handleConnectSpotify}
                  disabled={spotifyLoading || importing}
                >
                  {spotifyLoading ? <Loader2 className="artist-icon-sm animate-spin" /> : null}
                  Connect Spotify
                </button>
              </div>
            ) : source === "listenbrainz" && !listenBrainzStatus.connected ? (
              <div className="playlist-import__empty">
                <div className="playlist-import__empty-icon" aria-hidden="true">
                  <Music2 />
                </div>
                <p className="playlist-import__empty-title">Connect ListenBrainz first</p>
                <p className="playlist-import__empty-copy">
                  Link your ListenBrainz user token in Settings to import your playlists.
                </p>
                <Link
                  to="/settings/playback"
                  className="btn btn-primary btn-sm"
                  onClick={onClose}
                >
                  Open ListenBrainz settings
                </Link>
              </div>
            ) : source === "lastfm" && !lastfmUsername ? (
              <div className="playlist-import__lastfm-setup">
                <div>
                  <p className="playlist-import__empty-title">Enter your Last.fm username</p>
                  <p className="playlist-import__empty-copy">
                    Aurral will load your Library, Mix, and Recommended stations.
                  </p>
                </div>
                <div className="playlist-modal__fields">
                  <label className="playlist-import__field-label" htmlFor="playlist-import-lastfm-username">
                    Last.fm username
                  </label>
                  <input
                    id="playlist-import-lastfm-username"
                    type="text"
                    className="input"
                    value={lastfmUsernameInput}
                    onChange={(event) => setLastfmUsernameInput(event.target.value)}
                    onKeyDown={(event) => {
                      if (event.key === "Enter") loadLastfmPlaylists(lastfmUsernameInput);
                    }}
                    autoComplete="off"
                    disabled={lastfmProfileLoading || lastfmLoading || importing}
                  />
                  <p className="settings-page__hint">
                    Saved with the imported playlist for future syncs.
                  </p>
                </div>
                <button
                  type="button"
                  className="btn btn-primary btn-sm"
                  onClick={() => loadLastfmPlaylists(lastfmUsernameInput)}
                  disabled={lastfmProfileLoading || lastfmLoading || !lastfmUsernameInput.trim() || importing}
                >
                  {lastfmProfileLoading || lastfmLoading ? (
                    <Loader2 className="artist-icon-sm animate-spin" />
                  ) : null}
                  Load stations
                </button>
              </div>
            ) : (
              <>
                <div className="playlist-import__account">
                  <span className="playlist-import__account-status" aria-hidden="true" />
                  <span className="playlist-import__account-label">
                    Signed in as <strong>
                      {(source === "spotify"
                        ? spotifyStatus
                        : source === "listenbrainz"
                          ? listenBrainzStatus
                          : { displayName: lastfmUsername }
                      ).displayName || externalSource}
                    </strong>
                  </span>
                  {source === "spotify" ? (
                    <button
                      type="button"
                      className="btn btn-ghost btn-sm"
                      onClick={handleDisconnectSpotify}
                      disabled={spotifyLoading || importing}
                    >
                      Disconnect
                    </button>
                  ) : source === "lastfm" ? (
                    <button
                      type="button"
                      className="btn btn-ghost btn-sm"
                      onClick={() => {
                        loadedLastfmUsernameRef.current = "";
                        setLastfmUsername("");
                        setLastfmUsernameInput("");
                        setLastfmProfileChecked(true);
                        setPlaylists([]);
                        setSelectedPlaylist(null);
                      }}
                      disabled={lastfmLoading || importing}
                    >
                      Change
                    </button>
                  ) : null}
                </div>

                {selectedPlaylist ? (
                  <div className="playlist-import__selected">
                    <div className="playlist-import__selected-copy">
                      <span className="playlist-import__selected-name">{selectedPlaylist.name}</span>
                      <span className="playlist-import__selected-meta">
                        {getPlaylistMeta(selectedPlaylist)}
                      </span>
                    </div>
                    <button
                      type="button"
                      className="btn btn-ghost btn-sm"
                      onClick={() => setSelectedPlaylist(null)}
                      disabled={importing}
                    >
                      Change
                    </button>
                  </div>
                ) : (
                  <div className="playlist-import__list-panel">
                    <input
                      id="playlist-import-search"
                      type="search"
                      className="input playlist-import__search"
                      placeholder="Search playlists"
                      value={playlistQuery}
                      onChange={(event) => setPlaylistQuery(event.target.value)}
                      disabled={importing || spotifyLoading || listenBrainzLoading || lastfmLoading}
                    />
                    <div className="playlist-import__playlist-list" role="listbox" aria-label={`${externalSource} playlists`}>
                      {(source === "spotify"
                        ? spotifyLoading
                        : source === "listenbrainz"
                          ? listenBrainzLoading
                          : lastfmLoading) && playlists.length === 0 ? (
                        <div className="playlist-import__list-status">
                          <Loader2 className="artist-icon-sm animate-spin" />
                          <span>Loading playlists…</span>
                        </div>
                      ) : filteredPlaylists.length === 0 ? (
                        <div className="playlist-import__list-status">No playlists found</div>
                      ) : (
                        filteredPlaylists.map((playlist) => (
                          <button
                            key={playlist.id}
                            type="button"
                            role="option"
                            aria-selected={selectedPlaylist?.id === playlist.id}
                            className="playlist-import__playlist-option"
                            onClick={() => handleSelectPlaylist(playlist)}
                            disabled={importing}
                          >
                            <span className="playlist-import__playlist-name">{playlist.name}</span>
                            <span className="playlist-import__playlist-meta">
                              {getPlaylistMeta(playlist)}
                            </span>
                          </button>
                        ))
                      )}
                    </div>
                  </div>
                )}

                {selectedPlaylist ? (
                  <div className="playlist-import__config">
                    <div className="playlist-import__config-fields">
                      <div className="playlist-modal__fields">
                        <label className="playlist-import__field-label" htmlFor="playlist-import-name">
                          Name in Aurral
                        </label>
                        <input
                          id="playlist-import-name"
                          type="text"
                          className="input"
                          value={playlistName}
                          onChange={(event) => setPlaylistName(event.target.value)}
                          disabled={importing}
                        />
                      </div>

                      <div className="playlist-modal__fields">
                        <label className="playlist-import__field-label" htmlFor="playlist-import-interval">
                          Sync
                        </label>
                        <select
                          id="playlist-import-interval"
                          className="input"
                          value={syncIntervalHours}
                          onChange={(event) => setSyncIntervalHours(Number(event.target.value))}
                          disabled={importing}
                        >
                          {SYNC_INTERVAL_OPTIONS.map((option) => (
                            <option key={option.value} value={option.value}>
                              {option.label}
                            </option>
                          ))}
                        </select>
                      </div>
                    </div>

                    <label className="playlist-import__retention">
                      <input
                        type="checkbox"
                        checked={keepRemovedTracks}
                        onChange={(event) => setKeepRemovedTracks(event.target.checked)}
                        className="artist-checkbox"
                        disabled={importing}
                      />
                      <span className="playlist-import__retention-copy">
                        <span className="playlist-import__retention-title">
                          Keep removed tracks in library
                        </span>
                        <span className="playlist-import__retention-help">
                          {externalSource} removals leave the downloaded file available in Aurral.
                        </span>
                      </span>
                    </label>

                    <div className="playlist-import__summary">
                      {previewLoading ? (
                        <div className="playlist-import__list-status playlist-import__list-status--inline">
                          <Loader2 className="artist-icon-sm animate-spin" />
                          <span>Counting importable tracks…</span>
                        </div>
                      ) : (
                        <>
                          <div className="playlist-import__summary-top">
                            <span className="flow-page__badge flow-page__badge--count">
                              {previewTrackCount} importable
                            </span>
                            {previewSkipped > 0 ? (
                              <span className="playlist-import__summary-note">
                                {previewSkipped} skipped
                              </span>
                            ) : null}
                          </div>
                          {previewSkipped > 0 ? (
                            <p className="playlist-import__summary-copy">
                              {externalSource === "Spotify"
                                ? "Spotify also lists unavailable entries, podcast episodes, and duplicates Aurral cannot download."
                                : externalSource === "Last.fm"
                                  ? "Some Last.fm entries are missing the artist or track data Aurral needs."
                                  : "Some ListenBrainz entries are missing the artist or track data Aurral needs."}
                            </p>
                          ) : null}
                          {previewTracks.length > 0 ? (
                            <p className="playlist-import__summary-sample">
                              {previewTracks
                                .map((track) => `${track.artistName} — ${track.trackName}`)
                                .join(" · ")}
                              {previewTrackCount > previewTracks.length
                                ? ` · +${previewTrackCount - previewTracks.length} more`
                                : ""}
                            </p>
                          ) : null}
                        </>
                      )}
                    </div>
                  </div>
                ) : null}
              </>
            )}
          </div>
        ) : (
          <div className="playlist-import__json">
            {!jsonReview ? (
              <label className="playlist-import__dropzone">
                <FileJson className="playlist-import__dropzone-icon" aria-hidden="true" />
                <span className="playlist-import__dropzone-title">Select JSON file</span>
                <span className="playlist-import__dropzone-copy">Aurral exports and compatible tracklists</span>
                <input
                  type="file"
                  accept="application/json,.json"
                  onChange={handleJsonFileChange}
                  disabled={importing}
                />
              </label>
            ) : (
              <div className="playlist-import__file-card">
                <div className="playlist-import__file-card-header">
                  <FileJson className="artist-icon-sm" aria-hidden="true" />
                  <div>
                    <div className="playlist-import__file-name">{jsonReview.fileName}</div>
                    <div className="playlist-import__file-meta">
                      {jsonReview.flows.length}{" "}
                      {jsonReview.flows.length === 1 ? "playlist" : "playlists"} detected
                    </div>
                  </div>
                  <button
                    type="button"
                    className="btn btn-ghost btn-sm"
                    onClick={() => setJsonReview(null)}
                    disabled={importing}
                  >
                    Change file
                  </button>
                </div>
                <div className="playlist-import__json-list">
                  {jsonReview.flows.map((flow, index) => (
                    <div key={`${flow?.name || "flow"}-${index}`} className="playlist-import__json-item">
                      <span>{flow?.name || `Playlist ${index + 1}`}</span>
                      <span className="flow-page__badge flow-page__badge--count">
                        {Number(flow?.tracks?.length || 0)} tracks
                      </span>
                    </div>
                  ))}
                </div>
              </div>
            )}
          </div>
        )}
      </div>
    </ModalShell>
  );
}
