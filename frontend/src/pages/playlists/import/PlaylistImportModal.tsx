import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useMutation, useQuery } from "@tanstack/react-query";
import { Music2 } from "../../../components/icons";
import { SettingsLink } from "../../Settings/settingsRoute";
import { ModalShell } from "../../../components/PlaylistModals";
import { DotLoader } from "../../../components/DotLoader";
import { parseResponse, type InferRequestType, type InferResponseType } from "hono/client";
import { playlistImportsClient } from "../../../utils/api/clients/playlistImports.ts";
import { shareLinksClient } from "../../../utils/api/clients/shareLinks.ts";
import { scrobblingClient } from "../../../utils/api/clients/scrobbling.ts";
import { usersClient } from "../../../utils/api/clients/users.ts";
import { formatTrackTotal } from "../playlistPageUtils.ts";
import { getAppBasePath, normalizeBasePathWithTrailingSlash } from "../../../utils/basePath";
import { useAuth } from "../../../contexts/AuthContext";
import { queryClient, queryKeys } from "../../../queryClient.ts";
import { reserveUniqueName, normalizeNameKey } from "../flowPageUtils";
import { apiFetchWithin, type ApiError } from "../../../utils/api/core.ts";
import { getApiErrorBody, getApiErrorMessage } from "../../onboardingUtils.tsx";

declare global {
  interface Window {
    onCompleteOauth?: (query: string, onComplete?: () => void) => void;
  }
}

type ImportSource = "spotify" | "listenbrainz" | "lastfm" | "youtube" | "aurral";
type ImportPlaylist = {
  id: string;
  name: string;
  trackCount?: number;
  sourceType?: string | null;
};
const importApi = playlistImportsClient.import;
const youtubeFetch = apiFetchWithin(5 * 60 * 1000);

type ImportPreviewTrack = InferResponseType<
  typeof importApi.spotify.preview.$post,
  200
>["previewTracks"][number];
type YoutubePreview = InferResponseType<
  (typeof importApi)["youtube-music"]["preview"]["$post"],
  200
>;
type SpotifyTokens = {
  accessToken: string;
  refreshToken: string;
  expiresIn: string | number | null | undefined;
};

const SYNC_INTERVAL_OPTIONS = [
  { value: 0, label: "None" },
  { value: 6, label: "Every 6 hours" },
  { value: 12, label: "Every 12 hours" },
  { value: 24, label: "Every 24 hours" },
  { value: 72, label: "Every 3 days" },
];

const SPOTIFY_OAUTH_BROADCAST_CHANNEL = "aurral-spotify-oauth";
const SPOTIFY_AUTH_REQUIRED_CODE = "SPOTIFY_AUTH_REQUIRED";

function getPlaylistMeta(playlist: ImportPlaylist) {
  const parts = [playlist?.trackCount != null ? `${playlist.trackCount} tracks` : "Playlist"];
  if (playlist?.sourceType === "lastfm-station") parts.push("Updates from Last.fm");
  else if (playlist?.sourceType) parts.push("Updates weekly");
  return parts.join(" · ");
}

interface PlaylistImportConfigProps {
  externalSource: string;
  importing: boolean;
  keepRemovedTracks: boolean;
  playlistName: string;
  previewLoading: boolean;
  previewSkipped: number;
  previewTrackCount: number;
  previewTracks: ImportPreviewTrack[];
  setKeepRemovedTracks: (value: boolean) => void;
  setPlaylistName: (value: string) => void;
  setSyncIntervalHours: (value: number) => void;
  syncIntervalHours: number;
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
}: PlaylistImportConfigProps) {
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

type HandoffPayload = {
  access_token?: string | null;
  refresh_token?: string | null;
  expires_in?: string | number | null;
};

function tokensFromHandoffPayload(
  payload: HandoffPayload | null | undefined,
): SpotifyTokens | null {
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

function openSpotifyOAuthPopup(oauthUrl: string) {
  return new Promise<SpotifyTokens>((resolve, reject) => {
    const popup = window.open(oauthUrl, "spotify-oauth", "width=480,height=720");
    if (!popup || popup.closed || typeof popup.closed === "undefined") {
      reject(new Error("Allow popups to connect Spotify."));
      return;
    }

    let settled = false;
    let channel: BroadcastChannel | null | undefined;
    const cleanup = () => {
      delete window.onCompleteOauth;
      if (channel) {
        channel.close();
        channel = null;
      }
      clearTimeout(timeout);
    };
    const finish = (tokens: SpotifyTokens) => {
      if (settled) return;
      settled = true;
      cleanup();
      resolve(tokens);
    };
    const fail = (message: string) => {
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

    const timeout = setTimeout(
      () => {
        fail("Spotify sign-in timed out");
      },
      5 * 60 * 1000,
    );
  });
}

const EMPTY_PLAYLISTS: ImportPlaylist[] = [];

function isSpotifyAuthRequired(error: ApiError | null | undefined) {
  return getApiErrorBody(error)?.code === SPOTIFY_AUTH_REQUIRED_CODE;
}

function validYoutubePreview(payload: YoutubePreview) {
  const playlist = payload?.playlist;
  if (!playlist?.id || !playlist?.name)
    throw new Error("YouTube Music returned an invalid playlist");
  return payload;
}

function useErrorToast(
  error: ApiError | null | undefined,
  fallback: string,
  showError: ((message: string) => void) | undefined,
  onError?: (error: ApiError) => void,
) {
  const handledRef = useRef<ApiError | null | undefined>(null);
  useEffect(() => {
    if (!error || handledRef.current === error) return;
    handledRef.current = error;
    onError?.(error);
    showError?.(getApiErrorMessage(error, fallback));
  }, [error, fallback, onError, showError]);
}

interface PlaylistImportModalProps {
  open: boolean;
  onClose: () => void;
  onImported?: () => void;
  showError?: (message: string) => void;
  showSuccess?: (message: string) => void;
  existingPlaylistNames?: string[];
  initialShareUrl?: string;
}

export function PlaylistImportModal({
  open,
  onClose,
  onImported,
  showError,
  showSuccess,
  existingPlaylistNames = [],
  initialShareUrl = "",
}: PlaylistImportModalProps) {
  const { user } = useAuth();
  const [source, setSource] = useState<ImportSource>(initialShareUrl ? "aurral" : "spotify");
  const [shareUrl, setShareUrl] = useState(initialShareUrl);
  const [requestedShareUrl, setRequestedShareUrl] = useState(initialShareUrl);
  const [shareSync, setShareSync] = useState(true);
  const [shareFiles, setShareFiles] = useState(false);
  const [lastfmUsernameDraft, setLastfmUsernameDraft] = useState<string | null>(null);
  const [lastfmRequestedUsername, setLastfmRequestedUsername] = useState<string | null>(null);
  const [youtubeUrl, setYoutubeUrl] = useState("");
  const [playlistQuery, setPlaylistQuery] = useState("");
  const [pickedPlaylist, setPickedPlaylist] = useState<ImportPlaylist | null>(null);
  const [playlistNameDraft, setPlaylistNameDraft] = useState<string | null>(null);
  const [syncIntervalHours, setSyncIntervalHours] = useState(24);
  const [keepRemovedTracks, setKeepRemovedTracks] = useState(true);

  const reservedNameKeys = useMemo(
    () => new Set(existingPlaylistNames.map((name) => normalizeNameKey(name)).filter(Boolean)),
    [existingPlaylistNames],
  );

  const youtubePreview = useMutation({
    mutationFn: (url: string) =>
      parseResponse(
        importApi["youtube-music"].preview.$post({ json: { url } }, { fetch: youtubeFetch }),
      ).then(validYoutubePreview),
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
    resetYoutubePreview();
  }, [resetYoutubePreview]);

  const handleSpotifyError = useCallback(
    (error: ApiError) => {
      if (!isSpotifyAuthRequired(error)) return;
      queryClient.removeQueries({ queryKey: queryKeys.playlistImportPrefix("spotify") });
      queryClient.setQueryData(queryKeys.spotifyImportStatus, {
        connected: false,
        displayName: null,
        connectedAt: null,
      });
      resetState();
    },
    [resetState],
  );

  const spotifyStatusQuery = useQuery({
    queryKey: queryKeys.spotifyImportStatus,
    queryFn: () => parseResponse(importApi.spotify.status.$get()),
    enabled: open,
    staleTime: 0,
  });
  const spotifyConnected = Boolean(spotifyStatusQuery.data?.connected);
  const spotifyPlaylistsQuery = useQuery({
    queryKey: queryKeys.playlistImportList("spotify"),
    queryFn: () => parseResponse(importApi.spotify.playlists.$get()),
    enabled: open && source === "spotify" && spotifyConnected,
  });
  const spotifyStatus = {
    connected: spotifyConnected,
    displayName: spotifyPlaylistsQuery.data?.user || spotifyStatusQuery.data?.displayName || null,
  };

  const scrobbleStatusQuery = useQuery({
    queryKey: queryKeys.scrobbleStatus,
    queryFn: () => parseResponse(scrobblingClient.status.$get()),
    enabled: open && source === "listenbrainz",
    staleTime: 0,
  });
  const listenBrainzAccount = scrobbleStatusQuery.data?.listenbrainz;
  const listenBrainzPlaylistsQuery = useQuery({
    queryKey: queryKeys.playlistImportList("listenbrainz"),
    queryFn: () => parseResponse(importApi.listenbrainz.playlists.$get()),
    enabled: open && source === "listenbrainz" && Boolean(listenBrainzAccount?.connected),
  });
  const listenBrainzStatus = {
    connected: Boolean(listenBrainzAccount?.connected) && !listenBrainzPlaylistsQuery.isError,
    displayName: listenBrainzPlaylistsQuery.data?.user || listenBrainzAccount?.displayName || null,
  };

  const lastfmProfileQuery = useQuery({
    queryKey: queryKeys.listeningHistory(user?.id),
    queryFn: ({ signal }) =>
      parseResponse(usersClient.me["listening-history"].$get({}, { init: { signal } })),
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
    queryFn: () =>
      parseResponse(
        importApi.lastfm.playlists.$get({
          query: lastfmUsernameRequest ? { username: lastfmUsernameRequest } : {},
        }),
      ),
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
      parseResponse(
        source === "spotify"
          ? importApi.spotify.preview.$post({ json: { playlistId: pickedPlaylist!.id } })
          : source === "listenbrainz"
            ? importApi.listenbrainz.preview.$post({
                json: {
                  playlistId: pickedPlaylist!.id,
                  ...(pickedPlaylist!.sourceType
                    ? { playlistType: pickedPlaylist!.sourceType }
                    : {}),
                },
              })
            : importApi.lastfm.preview.$post({
                json: { playlistId: pickedPlaylist!.id, username: lastfmUsername },
              }),
      ),
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
    source === "listenbrainz"
      ? scrobbleStatusQuery.error || listenBrainzPlaylistsQuery.error
      : null,
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
      const { oauthUrl } = await parseResponse(
        importApi.spotify.oauth.start.$post({ json: { callbackUrl: getOAuthCallbackUrl() } }),
      );
      const tokens = await openSpotifyOAuthPopup(oauthUrl);
      return parseResponse(importApi.spotify.oauth.complete.$post({ json: tokens }));
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
      showError?.(getApiErrorMessage(error, "Failed to connect Spotify"));
    },
  });

  const disconnectSpotifyAccount = useMutation({
    mutationFn: () => parseResponse(importApi.spotify.$delete()),
    onSuccess: () => {
      queryClient.removeQueries({ queryKey: queryKeys.playlistImportPrefix("spotify") });
      queryClient.setQueryData(queryKeys.spotifyImportStatus, {
        connected: false,
        displayName: null,
      });
      setPickedPlaylist(null);
    },
    onError: (error) => {
      showError?.(error?.message || "Failed to disconnect Spotify");
    },
  });

  const sharePreview = useQuery({
    queryKey: ["share-import", requestedShareUrl],
    queryFn: () =>
      parseResponse(shareLinksClient.import.preview.$post({ json: { url: requestedShareUrl } })),
    enabled: open && source === "aurral" && Boolean(requestedShareUrl),
    retry: false,
    staleTime: 60_000,
  });
  const sharedPlaylist = sharePreview.data?.manifest.kind === "playlist" ? sharePreview.data : null;
  const shareError = sharePreview.error
    ? getApiErrorMessage(sharePreview.error, "Could not load this share.")
    : sharePreview.data && !sharedPlaylist
      ? "This link is not a playlist. Open the link to import it."
      : "";

  const externalImport = useMutation({
    mutationFn: (runImport: () => Promise<unknown>) => runImport(),
  });
  const shareImport = useMutation({
    mutationFn: (json: InferRequestType<typeof shareLinksClient.import.$post>["json"]) =>
      parseResponse(shareLinksClient.import.$post({ json })),
  });

  const importing = externalImport.isPending || shareImport.isPending;
  const spotifyLoading =
    connectSpotify.isPending ||
    disconnectSpotifyAccount.isPending ||
    spotifyPlaylistsQuery.isLoading;
  const listenBrainzLoading = scrobbleStatusQuery.isLoading || listenBrainzPlaylistsQuery.isLoading;

  const youtubePlaylist: ImportPlaylist | null = youtubePreview.data
    ? {
        ...youtubePreview.data.playlist,
        trackCount: Number(youtubePreview.data.trackCount || 0),
      }
    : null;
  const youtubeError = youtubePreview.error
    ? getApiErrorMessage(youtubePreview.error, "Failed to preview YouTube Music playlist")
    : "";
  const selectedPlaylist: ImportPlaylist | null =
    source === "youtube"
      ? youtubePlaylist
      : source === "aurral"
        ? sharedPlaylist && {
            id: sharedPlaylist.url,
            name: sharedPlaylist.manifest.title,
            trackCount: sharedPlaylist.tracks.length,
          }
        : pickedPlaylist;
  const previewPayload = source === "youtube" ? youtubePreview.data : previewQuery.data;
  const previewLoading = source === "youtube" ? youtubePreview.isPending : previewQuery.isLoading;
  const previewTrackCount = Number(previewPayload?.trackCount || 0);
  const previewSkipped = Number(previewPayload?.skipped || 0);
  const previewTracks = Array.isArray(previewPayload?.previewTracks)
    ? previewPayload.previewTracks
    : [];
  const playlistName = playlistNameDraft ?? selectedPlaylist?.name ?? "";

  const activePlaylistsData =
    source === "spotify"
      ? spotifyPlaylistsQuery.data
      : source === "listenbrainz"
        ? listenBrainzStatus.connected
          ? listenBrainzPlaylistsQuery.data
          : null
        : source === "lastfm"
          ? lastfmPlaylistsQuery.data
          : null;
  const playlists: ImportPlaylist[] = Array.isArray(activePlaylistsData?.playlists)
    ? activePlaylistsData.playlists
    : EMPTY_PLAYLISTS;

  const filteredPlaylists = useMemo(() => {
    const query = playlistQuery.trim().toLowerCase();
    if (!query) return playlists;
    return playlists.filter((playlist) => playlist.name.toLowerCase().includes(query));
  }, [playlistQuery, playlists]);

  const selectSource = (nextSource: ImportSource) => {
    setSource(nextSource);
    setPlaylistQuery("");
    setPickedPlaylist(null);
    setPlaylistNameDraft(null);
    setYoutubeUrl("");
    youtubePreview.reset();
    setShareUrl("");
    setRequestedShareUrl("");
  };

  const loadLastfmPlaylists = (requestedUsername: string) => {
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

  const handleSelectPlaylist = (playlist: ImportPlaylist) => {
    setPickedPlaylist(playlist);
    setPlaylistNameDraft(null);
  };

  const handlePreviewYoutube = () => {
    const url = youtubeUrl.trim();
    if (!url || previewLoading || importing) return;
    setPlaylistNameDraft(null);
    youtubePreview.mutate(url, {
      onError: (error) => {
        showError?.(getApiErrorMessage(error, "Failed to preview YouTube Music playlist"));
      },
    });
  };

  const handleYoutubeUrlChange = (value: string) => {
    setYoutubeUrl(value);
    setPlaylistNameDraft(null);
    youtubePreview.reset();
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
    const payload = {
      playlistId: selectedPlaylist.id,
      name: finalName,
      syncEnabled: syncIntervalHours > 0,
      syncIntervalHours,
      keepRemovedTracks,
    };
    const externalName = selectedPlaylist.name;
    const runImport = () =>
      parseResponse(
        isListenBrainz
          ? importApi.listenbrainz.$post({
              json: {
                ...payload,
                externalName,
                ...(selectedPlaylist.sourceType
                  ? { playlistType: selectedPlaylist.sourceType }
                  : {}),
              },
            })
          : isLastfm
            ? importApi.lastfm.$post({
                json: { ...payload, externalName, username: lastfmUsername },
              })
            : isYoutube
              ? importApi["youtube-music"].$post({ json: payload }, { fetch: youtubeFetch })
              : importApi.spotify.$post({ json: { ...payload, externalName } }),
      );
    externalImport.mutate(runImport, {
      onSuccess: () => {
        showSuccess?.(`Queued import of ${finalName} from ${providerLabel}`);
        onImported?.();
        onClose?.();
      },
      onError: (error) => {
        handleSpotifyError(error);
        showError?.(getApiErrorMessage(error, `Failed to import ${providerLabel} playlist`));
      },
    });
  };

  const handleLoadShare = () => {
    const url = shareUrl.trim();
    if (!url || importing) return;
    setPlaylistNameDraft(null);
    setRequestedShareUrl(url);
    if (url === requestedShareUrl) void sharePreview.refetch();
  };

  const handleChangeShare = () => {
    setRequestedShareUrl("");
    setPlaylistNameDraft(null);
    setShareFiles(false);
  };

  const handleImportShare = () => {
    if (!sharedPlaylist || importing) return;
    const baseName = String(playlistName || sharedPlaylist.manifest.title).trim();
    if (!baseName) {
      showError?.("Playlist name is required");
      return;
    }
    const name = reserveUniqueName(new Set(reservedNameKeys), baseName);
    shareImport.mutate(
      {
        url: sharedPlaylist.url,
        name,
        sync: shareSync,
        includeFiles: !shareSync && shareFiles && sharedPlaylist.canDownload,
      },
      {
        onSuccess: () => {
          showSuccess?.(`Queued import of ${name}`);
          onImported?.();
          onClose?.();
        },
        onError: (error) => {
          showError?.(getApiErrorMessage(error, "Could not import this share."));
        },
      },
    );
  };

  const canImportExternal = selectedPlaylist?.id && previewTrackCount > 0 && !previewLoading;
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
            : source === "aurral"
              ? "Paste a share link or code from aurral.org."
              : undefined
      }
      onClose={onClose}
      disableClose={importing}
      footer={
        <>
          <button
            type="button"
            onClick={onClose}
            className="btn btn-secondary"
            disabled={importing}
          >
            Cancel
          </button>
          <button
            type="button"
            onClick={source === "aurral" ? handleImportShare : handleImportExternal}
            className="btn btn-primary"
            disabled={importing || !(source === "aurral" ? sharedPlaylist : canImportExternal)}
          >
            {importing ? (
              <DotLoader size="sm" label={null} />
            ) : (
              <Music2 className="artist-icon-sm" />
            )}
            Import playlist
          </button>
        </>
      }
    >
      <div className="playlist-import">
        <div
          className="artist-segmented playlist-import__segmented"
          role="group"
          aria-label="Import source"
        >
          {(
            [
              { id: "spotify", label: "Spotify" },
              { id: "lastfm", label: "Last.fm" },
              { id: "listenbrainz", label: "ListenBrainz" },
              { id: "youtube", label: "YouTube Music" },
              { id: "aurral", label: "Aurral share" },
            ] as const
          ).map((option) => (
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

        {source === "aurral" ? (
          <div className="playlist-import__share">
            {sharedPlaylist ? (
              <>
                <div className="playlist-import__selected">
                  <div className="playlist-import__selected-copy">
                    <span className="playlist-import__selected-name">
                      {sharedPlaylist.manifest.title}
                    </span>
                    <span className="playlist-import__selected-meta">
                      {formatTrackTotal(sharedPlaylist.tracks.length)}
                      {sharedPlaylist.ready ? ` · ${sharedPlaylist.ready} in your Library` : ""}
                    </span>
                  </div>
                  <button
                    type="button"
                    className="btn btn-ghost btn-sm"
                    onClick={handleChangeShare}
                    disabled={importing}
                  >
                    Change
                  </button>
                </div>
                <div className="playlist-import__choices" role="radiogroup" aria-label="Import">
                  <label className="playlist-import__choice">
                    <input
                      type="radio"
                      name="playlist-import-share-mode"
                      className="artist-checkbox"
                      checked={shareSync}
                      onChange={() => setShareSync(true)}
                      disabled={importing}
                    />
                    <span className="playlist-import__retention-copy">
                      <span className="playlist-import__retention-title">Keep synced</span>
                      <span className="playlist-import__choice-hint">
                        Checks daily. New tracks download with your sources.
                      </span>
                    </span>
                  </label>
                  <label className="playlist-import__choice">
                    <input
                      type="radio"
                      name="playlist-import-share-mode"
                      className="artist-checkbox"
                      checked={!shareSync}
                      onChange={() => setShareSync(false)}
                      disabled={importing}
                    />
                    <span className="playlist-import__retention-copy">
                      <span className="playlist-import__retention-title">Import once</span>
                      <span className="playlist-import__choice-hint">
                        {shareFiles && sharedPlaylist.canDownload
                          ? "Saves today's tracklist with the sender's files."
                          : "Saves today's tracklist without downloading."}
                      </span>
                    </span>
                  </label>
                  {!shareSync && sharedPlaylist.canDownload && sharedPlaylist.downloads > 0 ? (
                    <label className="playlist-import__choice-option">
                      <input
                        type="checkbox"
                        className="artist-checkbox"
                        checked={shareFiles}
                        onChange={(event) => setShareFiles(event.target.checked)}
                        disabled={importing}
                      />
                      Use the sender&apos;s files ({formatTrackTotal(sharedPlaylist.downloads)}
                      {sharedPlaylist.downloadBytes
                        ? `, ${Math.max(1, Math.round(sharedPlaylist.downloadBytes / 1024 / 1024)).toLocaleString()} MB`
                        : ""}
                      )
                    </label>
                  ) : null}
                </div>
                <div className="playlist-modal__fields">
                  <label
                    className="playlist-import__field-label"
                    htmlFor="playlist-import-share-name"
                  >
                    Name in Aurral
                  </label>
                  <input
                    id="playlist-import-share-name"
                    type="text"
                    className="input"
                    value={playlistName}
                    onChange={(event) => setPlaylistNameDraft(event.target.value)}
                    disabled={importing}
                  />
                </div>
              </>
            ) : (
              <>
                <div className="playlist-modal__fields">
                  <label
                    className="playlist-import__field-label"
                    htmlFor="playlist-import-share-url"
                  >
                    Share link or code
                  </label>
                  <input
                    id="playlist-import-share-url"
                    type="text"
                    className="input"
                    placeholder="https://aurral.org/s/… or code"
                    value={shareUrl}
                    onChange={(event) => setShareUrl(event.target.value)}
                    onKeyDown={(event) => {
                      if (event.key === "Enter") {
                        event.preventDefault();
                        handleLoadShare();
                      }
                    }}
                    autoComplete="off"
                    disabled={sharePreview.isFetching || importing}
                    aria-describedby={shareError ? "playlist-import-share-error" : undefined}
                  />
                  {shareError ? (
                    <p
                      id="playlist-import-share-error"
                      className="settings-page__error"
                      role="alert"
                    >
                      {shareError}
                    </p>
                  ) : null}
                </div>
                <button
                  type="button"
                  className="btn btn-primary btn-sm"
                  onClick={handleLoadShare}
                  disabled={sharePreview.isFetching || importing || !shareUrl.trim()}
                >
                  {sharePreview.isFetching ? <DotLoader size="sm" label={null} /> : null}
                  {sharePreview.isFetching ? "Loading share…" : "Load share"}
                </button>
              </>
            )}
          </div>
        ) : (
          <div className="playlist-import__spotify">
            {source === "youtube" ? (
              <div className="playlist-import__youtube">
                <div className="playlist-modal__fields">
                  <label
                    className="playlist-import__field-label"
                    htmlFor="playlist-import-youtube-url"
                  >
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
                    <p
                      id="playlist-import-youtube-error"
                      className="settings-page__error"
                      role="alert"
                    >
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
                        <span className="playlist-import__selected-name">
                          {selectedPlaylist.name}
                        </span>
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
                  Connect ListenBrainz in Settings → Listening to import playlists.
                </p>
                <SettingsLink
                  to="listening/listenbrainz"
                  className="btn btn-primary btn-sm"
                  onClick={onClose}
                >
                  Open ListenBrainz settings
                </SettingsLink>
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
                  <label
                    className="playlist-import__field-label"
                    htmlFor="playlist-import-lastfm-username"
                  >
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
                  <p className="settings-page__hint">Saved for future syncs.</p>
                </div>
                <button
                  type="button"
                  className="btn btn-primary btn-sm"
                  onClick={() => loadLastfmPlaylists(lastfmUsernameInput)}
                  disabled={
                    lastfmProfileLoading ||
                    lastfmLoading ||
                    !lastfmUsernameInput.trim() ||
                    importing
                  }
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
                    Signed in as{" "}
                    <strong>
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
                      <span className="playlist-import__selected-name">
                        {selectedPlaylist.name}
                      </span>
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
                    <div
                      className="playlist-import__playlist-list"
                      role="listbox"
                      aria-label={`${externalSource} playlists`}
                    >
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
                            aria-selected={false}
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
        )}
      </div>
    </ModalShell>
  );
}
