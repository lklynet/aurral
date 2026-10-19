import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useMutation, useQuery } from "@tanstack/react-query";
import { FileJson, Music2, Upload } from "lucide-react";
import { Link } from "react-router";
import { ModalShell } from "../../../components/PlaylistModals";
import { DotLoader } from "../../../components/DotLoader";
import {
  completeSpotifyOAuth,
  disconnectSpotify,
  getListenBrainzPlaylists,
  getLastfmPlaylists,
  getSpotifyImportStatus,
  getSpotifyPlaylists,
  importStaticPlaylist,
  importListenBrainzPlaylist,
  importLastfmPlaylist,
  importSpotifyPlaylist,
  importYoutubeMusicPlaylist,
  previewListenBrainzPlaylist,
  previewLastfmPlaylist,
  previewSpotifyPlaylist,
  previewYoutubeMusicPlaylist,
  startSpotifyOAuth,
} from "../../../utils/api/endpoints/playlists.js";
import { getMyListeningHistory, getScrobbleStatus } from "../../../utils/api/endpoints/auth.js";
import { getAppBasePath, normalizeBasePathWithTrailingSlash } from "../../../utils/basePath";
import { useAuth } from "../../../contexts/AuthContext";
import { queryClient, queryKeys } from "../../../queryClient.js";
import { parseTracklistImportFile, reserveUniqueName, normalizeNameKey } from "../flowPageUtils";

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

function PlaylistImportConfig({
  externalSource,
  importing,
  keepRemovedTracks,
  playlistName,
  previewLoading,
  previewSkipped,
  previewTrackCount,
  previewTracks,
  setKeepRemovedTracks,
  setPlaylistName,
  setSyncIntervalHours,
  syncIntervalHours,
}) {
  return (
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
              <option key={option.value} value={option.value}>{option.label}</option>
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
          <span className="playlist-import__retention-title">Keep removed tracks in library</span>
        </span>
      </label>

      <div className="playlist-import__summary" aria-live="polite">
        {previewLoading ? (
          <div className="playlist-import__list-status playlist-import__list-status--inline">
            <DotLoader size="sm" label={null} />
            <span>Counting importable tracks…</span>
          </div>
        ) : (
          <>
            <div className="playlist-import__summary-top">
              <span className="flow-page__badge flow-page__badge--count">
                {previewTrackCount} importable
              </span>
              {previewSkipped > 0 ? (
                <span className="playlist-import__summary-note">{previewSkipped} skipped</span>
              ) : null}
            </div>
            {previewTrackCount === 0 ? (
              <p className="playlist-import__summary-copy">
                No downloadable tracks. Check the source playlist.
              </p>
            ) : null}
            {previewSkipped > 0 ? (
              <p className="playlist-import__summary-copy">
                {externalSource === "Spotify"
                  ? "Skipped unavailable tracks, podcasts, and duplicates."
                  : externalSource === "Last.fm"
                    ? "Skipped entries with missing artist or track details."
                    : externalSource === "YouTube Music"
                      ? "Skipped unavailable entries, podcasts, incomplete videos, and duplicates."
                      : "Skipped entries with missing artist or track details."}
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
  );
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
      reject(new Error("Allow popups to connect Spotify."));
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

const EMPTY_PLAYLISTS = [];

function errorMessage(error, fallback) {
  return (
    error?.response?.data?.message ||
    error?.response?.data?.error ||
    error?.message ||
    fallback
  );
}

function isSpotifyAuthRequired(error) {
  return error?.response?.data?.code === SPOTIFY_AUTH_REQUIRED_CODE;
}

function validYoutubePreview(payload) {
  const playlist = payload?.playlist;
  if (!playlist?.id || !playlist?.name) throw new Error("YouTube Music returned an invalid playlist");
  return payload;
}

async function importTracklists(flows, reservedNameKeys) {
  const reservedNames = new Set(reservedNameKeys);
  let importedCount = 0;
  const failed = [];
  for (const payload of flows) {
    const desiredName = String(payload?.importName ?? payload?.name ?? "").trim();
    const baseName = desiredName || String(payload?.name || "").trim();
    const finalName = reserveUniqueName(reservedNames, baseName);
    try {
      await importStaticPlaylist({
        name: finalName,
        sourceName: payload?.sourceName || null,
        sourceFlowId: payload?.sourceFlowId || null,
        tracks: payload?.tracks || [],
      });
      importedCount += 1;
    } catch (error) {
      failed.push({ name: finalName, message: errorMessage(error, "Failed to import tracklist") });
    }
  }
  return { importedCount, failed };
}

function useErrorToast(error, fallback, showError, onError) {
  const handledRef = useRef(null);
  useEffect(() => {
    if (!error || handledRef.current === error) return;
    handledRef.current = error;
    onError?.(error);
    showError?.(errorMessage(error, fallback));
  }, [error, fallback, onError, showError]);
}

export function PlaylistImportModal({
  open,
  onClose,
  onImported,
  showError,
  showSuccess,
  existingPlaylistNames = [],
}) {
  const { user } = useAuth();
  const [source, setSource] = useState("spotify");
  const [lastfmUsernameDraft, setLastfmUsernameDraft] = useState(null);
  const [lastfmRequestedUsername, setLastfmRequestedUsername] = useState(null);
  const [youtubeUrl, setYoutubeUrl] = useState("");
  const [playlistQuery, setPlaylistQuery] = useState("");
  const [pickedPlaylist, setPickedPlaylist] = useState(null);
  const [playlistNameDraft, setPlaylistNameDraft] = useState(null);
  const [syncIntervalHours, setSyncIntervalHours] = useState(24);
  const [keepRemovedTracks, setKeepRemovedTracks] = useState(true);
  const [jsonReview, setJsonReview] = useState(null);

  const reservedNameKeys = useMemo(
    () =>
      new Set(
        existingPlaylistNames.map((name) => normalizeNameKey(name)).filter(Boolean),
      ),
    [existingPlaylistNames],
  );

  const youtubePreview = useMutation({
    mutationFn: (url) => previewYoutubeMusicPlaylist(url).then(validYoutubePreview),
  });
  const resetYoutubePreview = youtubePreview.reset;

  const resetState = useCallback(() => {
    setSource("spotify");
    setLastfmUsernameDraft(null);
    setLastfmRequestedUsername(null);
    setYoutubeUrl("");
    setPlaylistQuery("");
    setPickedPlaylist(null);
    setPlaylistNameDraft(null);
    setSyncIntervalHours(24);
    setKeepRemovedTracks(true);
    setJsonReview(null);
    resetYoutubePreview();
  }, [resetYoutubePreview]);

  const handleSpotifyError = useCallback((error) => {
    if (!isSpotifyAuthRequired(error)) return;
    queryClient.removeQueries({ queryKey: queryKeys.playlistImportPrefix("spotify") });
    queryClient.setQueryData(queryKeys.spotifyImportStatus, {
      connected: false,
      displayName: null,
      connectedAt: null,
    });
    resetState();
  }, [resetState]);

  const spotifyStatusQuery = useQuery({
    queryKey: queryKeys.spotifyImportStatus,
    queryFn: () => getSpotifyImportStatus(),
    enabled: open,
    staleTime: 0,
  });
  const spotifyConnected = Boolean(spotifyStatusQuery.data?.connected);
  const spotifyPlaylistsQuery = useQuery({
    queryKey: queryKeys.playlistImportList("spotify"),
    queryFn: () => getSpotifyPlaylists(),
    enabled: open && source === "spotify" && spotifyConnected,
  });
  const spotifyStatus = {
    connected: spotifyConnected,
    displayName: spotifyPlaylistsQuery.data?.user || spotifyStatusQuery.data?.displayName || null,
  };

  const scrobbleStatusQuery = useQuery({
    queryKey: queryKeys.scrobbleStatus,
    queryFn: () => getScrobbleStatus(),
    enabled: open && source === "listenbrainz",
    staleTime: 0,
  });
  const listenBrainzAccount = scrobbleStatusQuery.data?.listenbrainz;
  const listenBrainzPlaylistsQuery = useQuery({
    queryKey: queryKeys.playlistImportList("listenbrainz"),
    queryFn: () => getListenBrainzPlaylists(),
    enabled: open && source === "listenbrainz" && Boolean(listenBrainzAccount?.connected),
  });
  const listenBrainzStatus = {
    connected: Boolean(listenBrainzAccount?.connected) && !listenBrainzPlaylistsQuery.isError,
    displayName: listenBrainzPlaylistsQuery.data?.user || listenBrainzAccount?.displayName || null,
  };

  const lastfmProfileQuery = useQuery({
    queryKey: queryKeys.listeningHistory(user?.id),
    queryFn: ({ signal }) => getMyListeningHistory({ signal }),
    enabled: open && source === "lastfm" && lastfmRequestedUsername === null,
  });
  const profileLastfmUsername =
    lastfmProfileQuery.data?.listenHistoryProvider === "lastfm"
      ? String(lastfmProfileQuery.data?.listenHistoryUsername || "").trim()
      : "";
  const lastfmUsernameRequest = lastfmRequestedUsername ?? profileLastfmUsername;
  const lastfmUsernameInput = lastfmUsernameDraft ?? profileLastfmUsername;
  const lastfmPlaylistsQuery = useQuery({
    queryKey: queryKeys.playlistImportList("lastfm", lastfmUsernameRequest),
    queryFn: () => getLastfmPlaylists(lastfmUsernameRequest),
    enabled: open && source === "lastfm" && Boolean(lastfmUsernameRequest),
  });
  const lastfmUsername = lastfmPlaylistsQuery.isSuccess ? lastfmUsernameRequest : "";
  const lastfmProfileLoading = lastfmRequestedUsername === null && lastfmProfileQuery.isLoading;
  const lastfmLoading = lastfmPlaylistsQuery.isFetching;

  const previewQuery = useQuery({
    queryKey: queryKeys.playlistImportPreview(source, pickedPlaylist?.id, {
      sourceType: pickedPlaylist?.sourceType || null,
      username: source === "lastfm" ? lastfmUsername : null,
    }),
    queryFn: () =>
      source === "spotify"
        ? previewSpotifyPlaylist(pickedPlaylist.id)
        : source === "listenbrainz"
          ? previewListenBrainzPlaylist(pickedPlaylist.id, pickedPlaylist.sourceType)
          : previewLastfmPlaylist(pickedPlaylist.id, lastfmUsername),
    enabled:
      open && ["spotify", "listenbrainz", "lastfm"].includes(source) && Boolean(pickedPlaylist?.id),
  });

  useErrorToast(
    source === "spotify" ? spotifyPlaylistsQuery.error : null,
    "Failed to load Spotify playlists",
    showError,
    handleSpotifyError,
  );
  useErrorToast(
    source === "listenbrainz" ? scrobbleStatusQuery.error || listenBrainzPlaylistsQuery.error : null,
    "Failed to load ListenBrainz playlists",
    showError,
  );
  useErrorToast(
    source === "lastfm" ? lastfmPlaylistsQuery.error : null,
    "Failed to load Last.fm stations",
    showError,
  );
  useErrorToast(previewQuery.error, "Failed to preview playlist", showError, handleSpotifyError);

  const connectSpotify = useMutation({
    mutationFn: async () => {
      const { oauthUrl } = await startSpotifyOAuth(getOAuthCallbackUrl());
      const tokens = await openSpotifyOAuthPopup(oauthUrl);
      return completeSpotifyOAuth(tokens);
    },
    onSuccess: (status) => {
      queryClient.removeQueries({ queryKey: queryKeys.playlistImportPrefix("spotify") });
      queryClient.setQueryData(queryKeys.spotifyImportStatus, {
        connected: true,
        displayName: status?.displayName || null,
        connectedAt: status?.connectedAt || null,
      });
    },
    onError: (error) => {
      handleSpotifyError(error);
      showError?.(errorMessage(error, "Failed to connect Spotify"));
    },
  });

  const disconnectSpotifyAccount = useMutation({
    mutationFn: () => disconnectSpotify(),
    onSuccess: () => {
      queryClient.removeQueries({ queryKey: queryKeys.playlistImportPrefix("spotify") });
      queryClient.setQueryData(queryKeys.spotifyImportStatus, { connected: false, displayName: null });
      setPickedPlaylist(null);
    },
    onError: (error) => {
      showError?.(error?.message || "Failed to disconnect Spotify");
    },
  });

  const externalImport = useMutation({
    mutationFn: ({ importPlaylist, payload }) => importPlaylist(payload),
  });
  const jsonImport = useMutation({
    mutationFn: (flows) => importTracklists(flows, reservedNameKeys),
  });

  const importing = externalImport.isPending || jsonImport.isPending;
  const spotifyLoading =
    connectSpotify.isPending || disconnectSpotifyAccount.isPending || spotifyPlaylistsQuery.isLoading;
  const listenBrainzLoading = scrobbleStatusQuery.isLoading || listenBrainzPlaylistsQuery.isLoading;

  const youtubePlaylist = youtubePreview.data
    ? {
        ...youtubePreview.data.playlist,
        trackCount: Number(youtubePreview.data.trackCount || 0),
      }
    : null;
  const youtubeError = youtubePreview.error
    ? errorMessage(youtubePreview.error, "Failed to preview YouTube Music playlist")
    : "";
  const selectedPlaylist = source === "youtube" ? youtubePlaylist : pickedPlaylist;
  const previewPayload = source === "youtube" ? youtubePreview.data : previewQuery.data;
  const previewLoading = source === "youtube" ? youtubePreview.isPending : previewQuery.isLoading;
  const previewTrackCount = Number(previewPayload?.trackCount || 0);
  const previewSkipped = Number(previewPayload?.skipped || 0);
  const previewTracks = Array.isArray(previewPayload?.previewTracks) ? previewPayload.previewTracks : [];
  const playlistName = playlistNameDraft ?? selectedPlaylist?.name ?? "";

  const activePlaylistsData =
    source === "spotify"
      ? spotifyPlaylistsQuery.data
      : source === "listenbrainz"
        ? listenBrainzStatus.connected ? listenBrainzPlaylistsQuery.data : null
        : source === "lastfm"
          ? lastfmPlaylistsQuery.data
          : null;
  const playlists = Array.isArray(activePlaylistsData?.playlists)
    ? activePlaylistsData.playlists
    : EMPTY_PLAYLISTS;

  const filteredPlaylists = useMemo(() => {
    const query = playlistQuery.trim().toLowerCase();
    if (!query) return playlists;
    return playlists.filter((playlist) => playlist.name.toLowerCase().includes(query));
  }, [playlistQuery, playlists]);

  const selectSource = (nextSource) => {
    setSource(nextSource);
    setPlaylistQuery("");
    setPickedPlaylist(null);
    setPlaylistNameDraft(null);
    setYoutubeUrl("");
    youtubePreview.reset();
  };

  const loadLastfmPlaylists = (requestedUsername) => {
    const username = String(requestedUsername || "").trim();
    if (!username) return;
    setLastfmUsernameDraft(username);
    setLastfmRequestedUsername(username);
    if (username === lastfmUsernameRequest && lastfmPlaylistsQuery.isError) {
      void lastfmPlaylistsQuery.refetch();
    }
  };

  const changeLastfmUsername = () => {
    setLastfmRequestedUsername("");
    setLastfmUsernameDraft("");
    setPickedPlaylist(null);
  };

  const handleSelectPlaylist = (playlist) => {
    setPickedPlaylist(playlist);
    setPlaylistNameDraft(null);
  };

  const handlePreviewYoutube = () => {
    const url = youtubeUrl.trim();
    if (!url || previewLoading || importing) return;
    setPlaylistNameDraft(null);
    youtubePreview.mutate(url, {
      onError: (error) => {
        showError?.(errorMessage(error, "Failed to preview YouTube Music playlist"));
      },
    });
  };

  const handleYoutubeUrlChange = (value) => {
    setYoutubeUrl(value);
    setPlaylistNameDraft(null);
    youtubePreview.reset();
  };

  const handleJsonFileChange = async (event) => {
    const file = event.target.files?.[0];
    if (!file) return;
    try {
      const content = await file.text();
      const flows = parseTracklistImportFile(content).map((flow) => ({
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

  const handleImportExternal = () => {
    if (!selectedPlaylist?.id || importing) return;
    const baseName = String(playlistName || selectedPlaylist.name || "").trim();
    if (!baseName) {
      showError?.("Playlist name is required");
      return;
    }
    const finalName = reserveUniqueName(new Set(reservedNameKeys), baseName);
    const isListenBrainz = source === "listenbrainz";
    const isLastfm = source === "lastfm";
    const isYoutube = source === "youtube";
    const providerLabel = isListenBrainz
      ? "ListenBrainz"
      : isLastfm
        ? "Last.fm"
        : isYoutube
          ? "YouTube Music"
          : "Spotify";
    const importPlaylist = isListenBrainz
      ? importListenBrainzPlaylist
      : isLastfm
        ? importLastfmPlaylist
        : isYoutube
          ? importYoutubeMusicPlaylist
          : importSpotifyPlaylist;
    externalImport.mutate(
      {
        importPlaylist,
        payload: {
          playlistId: selectedPlaylist.id,
          ...(isListenBrainz && selectedPlaylist.sourceType
            ? { playlistType: selectedPlaylist.sourceType }
            : {}),
          ...(isLastfm ? { username: lastfmUsername } : {}),
          ...(!isYoutube ? { externalName: selectedPlaylist.name } : {}),
          name: finalName,
          syncEnabled: syncIntervalHours > 0,
          syncIntervalHours,
          keepRemovedTracks,
        },
      },
      {
        onSuccess: () => {
          showSuccess?.(`Queued import of ${finalName} from ${providerLabel}`);
          onImported?.();
          onClose?.();
        },
        onError: (error) => {
          handleSpotifyError(error);
          showError?.(errorMessage(error, `Failed to import ${providerLabel} playlist`));
        },
      },
    );
  };

  const handleImportJson = () => {
    if (!jsonReview || importing) return;
    jsonImport.mutate(jsonReview.flows, {
      onSuccess: ({ importedCount, failed }) => {
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
      },
    });
  };

  const canImportExternal = selectedPlaylist?.id && previewTrackCount > 0 && !previewLoading;
  const canImportJson = Boolean(jsonReview?.flows?.length);
  const externalSource =
    source === "listenbrainz"
      ? "ListenBrainz"
      : source === "lastfm"
        ? "Last.fm"
        : source === "youtube"
          ? "YouTube Music"
          : "Spotify";

  return (
    <ModalShell
      open={open}
      title="Import playlist"
      description={
        source === "listenbrainz"
          ? "Weekly playlists use the latest week."
          : source === "youtube"
            ? "Use a public YouTube or YouTube Music playlist URL."
            : undefined
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
              {importing ? <DotLoader size="sm" label={null} /> : <Music2 className="artist-icon-sm" />}
              Import playlist
            </button>
          ) : (
            <button
              type="button"
              onClick={handleImportJson}
              className="btn btn-primary btn-sm"
              disabled={importing || !canImportJson}
            >
              {importing ? <DotLoader size="sm" label={null} /> : <Upload className="artist-icon-sm" />}
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
            { id: "youtube", label: "YouTube Music" },
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
            {source === "youtube" ? (
              <div className="playlist-import__youtube">
                <div className="playlist-modal__fields">
                  <label className="playlist-import__field-label" htmlFor="playlist-import-youtube-url">
                    Playlist URL
                  </label>
                  <input
                    id="playlist-import-youtube-url"
                    type="url"
                    className="input"
                    placeholder="https://music.youtube.com/playlist?list=…"
                    value={youtubeUrl}
                    onChange={(event) => handleYoutubeUrlChange(event.target.value)}
                    onKeyDown={(event) => {
                      if (event.key === "Enter") {
                        event.preventDefault();
                        handlePreviewYoutube();
                      }
                    }}
                    autoComplete="url"
                    disabled={previewLoading || importing}
                    aria-describedby={youtubeError ? "playlist-import-youtube-error" : undefined}
                  />
                  {youtubeError ? (
                    <p id="playlist-import-youtube-error" className="settings-page__error" role="alert">
                      {youtubeError}
                    </p>
                  ) : null}
                </div>
                <button
                  type="button"
                  className="btn btn-primary btn-sm"
                  onClick={handlePreviewYoutube}
                  disabled={previewLoading || importing || !youtubeUrl.trim()}
                >
                  {previewLoading ? <DotLoader size="sm" label={null} /> : null}
                  {previewLoading ? "Loading preview…" : "Load playlist"}
                </button>

                {selectedPlaylist ? (
                  <>
                    <div className="playlist-import__selected">
                      <div className="playlist-import__selected-copy">
                        <span className="playlist-import__selected-name">{selectedPlaylist.name}</span>
                        <span className="playlist-import__selected-meta">
                          {getPlaylistMeta(selectedPlaylist)}
                        </span>
                      </div>
                    </div>
                    <PlaylistImportConfig
                      externalSource={externalSource}
                      importing={importing}
                      keepRemovedTracks={keepRemovedTracks}
                      playlistName={playlistName}
                      previewLoading={previewLoading}
                      previewSkipped={previewSkipped}
                      previewTrackCount={previewTrackCount}
                      previewTracks={previewTracks}
                      setKeepRemovedTracks={setKeepRemovedTracks}
                      setPlaylistName={setPlaylistNameDraft}
                      setSyncIntervalHours={setSyncIntervalHours}
                      syncIntervalHours={syncIntervalHours}
                    />
                  </>
                ) : null}
              </div>
            ) : source === "spotify" && !spotifyStatus.connected ? (
              <div className="playlist-import__empty">
                <div className="playlist-import__empty-icon" aria-hidden="true">
                  <Music2 />
                </div>
                <p className="playlist-import__empty-title">Connect your Spotify account</p>
                <button
                  type="button"
                  className="btn btn-primary btn-sm"
                  onClick={() => connectSpotify.mutate()}
                  disabled={spotifyLoading || importing}
                >
                  {spotifyLoading ? <DotLoader size="sm" label={null} /> : null}
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
                  Connect ListenBrainz in Settings → Playback to import playlists.
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
                    Loads your Library, Mix, and Recommended stations.
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
                    onChange={(event) => setLastfmUsernameDraft(event.target.value)}
                    onKeyDown={(event) => {
                      if (event.key === "Enter") loadLastfmPlaylists(lastfmUsernameInput);
                    }}
                    autoComplete="off"
                    disabled={lastfmProfileLoading || lastfmLoading || importing}
                  />
                  <p className="settings-page__hint">
                    Saved for future syncs.
                  </p>
                </div>
                <button
                  type="button"
                  className="btn btn-primary btn-sm"
                  onClick={() => loadLastfmPlaylists(lastfmUsernameInput)}
                  disabled={lastfmProfileLoading || lastfmLoading || !lastfmUsernameInput.trim() || importing}
                >
                  {lastfmProfileLoading || lastfmLoading ? (
                    <DotLoader size="sm" label={null} />
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
                      onClick={() => disconnectSpotifyAccount.mutate()}
                      disabled={spotifyLoading || importing}
                    >
                      Disconnect
                    </button>
                  ) : source === "lastfm" ? (
                    <button
                      type="button"
                      className="btn btn-ghost btn-sm"
                      onClick={changeLastfmUsername}
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
                      onClick={() => setPickedPlaylist(null)}
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
                          <DotLoader size="sm" label={null} />
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
                  <PlaylistImportConfig
                    externalSource={externalSource}
                    importing={importing}
                    keepRemovedTracks={keepRemovedTracks}
                    playlistName={playlistName}
                    previewLoading={previewLoading}
                    previewSkipped={previewSkipped}
                    previewTrackCount={previewTrackCount}
                    previewTracks={previewTracks}
                    setKeepRemovedTracks={setKeepRemovedTracks}
                    setPlaylistName={setPlaylistNameDraft}
                    setSyncIntervalHours={setSyncIntervalHours}
                    syncIntervalHours={syncIntervalHours}
                  />
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
