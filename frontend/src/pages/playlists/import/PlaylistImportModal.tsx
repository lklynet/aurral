import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useMutation, useQuery } from "@tanstack/react-query";
import { ChevronRight } from "../../../components/icons";
import { SettingsLink } from "../../Settings/settingsRoute";
import {
  SettingsGroup,
  SettingsNote,
  SettingsPane,
  SettingsRow,
  SettingsShell,
} from "../../Settings/SettingsLayout.tsx";
import { DotLoader } from "../../../components/DotLoader";
import PillToggle from "../../../components/PillToggle";
import { Select } from "../../../components/Select";
import { parseResponse, type InferRequestType, type InferResponseType } from "hono/client";
import { playlistImportsClient } from "../../../utils/api/clients/playlistImports.ts";
import { shareLinksClient } from "../../../utils/api/clients/shareLinks.ts";
import { staticPlaylistsClient } from "../../../utils/api/clients/staticPlaylists.ts";
import { parseM3u, type M3uTrack } from "../../../../../lib/m3u.ts";
import { scrobblingClient } from "../../../utils/api/clients/scrobbling.ts";
import { formatTrackTotal } from "../playlistPageUtils.ts";
import { getAppBasePath, normalizeBasePathWithTrailingSlash } from "../../../utils/basePath";
import { useAuth } from "../../../contexts/AuthContext";
import { queryClient, queryKeys } from "../../../queryClient.ts";
import { listeningHistoryQueryOptions } from "../../../queryOptions.ts";
import { reserveUniqueName, normalizeNameKey } from "../flowPageUtils";
import { apiFetchWithin, type ApiError } from "../../../utils/api/core.ts";
import { getApiErrorBody, getApiErrorMessage } from "../../../utils/api/errors.ts";

declare global {
  interface Window {
    onCompleteOauth?: (query: string, onComplete?: () => void) => void;
  }
}

const IMPORT_SOURCES = [
  { id: "spotify", label: "Spotify" },
  { id: "lastfm", label: "Last.fm" },
  { id: "listenbrainz", label: "ListenBrainz" },
  { id: "youtube", label: "YouTube Music" },
  { id: "aurral", label: "Aurral share" },
  { id: "file", label: "M3U file" },
] as const;
type ImportSource = (typeof IMPORT_SOURCES)[number]["id"];
type ImportTrack = { artistName: string; title: string };
type FilePlaylist = { name: string; tracks: M3uTrack[]; skipped: number };
type ImportPlaylist = {
  id: string;
  name: string;
  trackCount?: number;
  sourceType?: string | null;
};
const importApi = playlistImportsClient.import;
const youtubeFetch = apiFetchWithin(5 * 60 * 1000);

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

const SKIPPED_REASONS: Partial<Record<ImportSource, string>> = {
  spotify: "Skipped unavailable tracks, podcasts, and duplicates.",
  youtube: "Skipped unavailable entries, podcasts, incomplete videos, and duplicates.",
};

function ImportTracks({
  tracks,
  total,
  skipped = 0,
  skippedReason,
  loading = false,
  meta,
}: {
  tracks: ImportTrack[];
  total: number;
  skipped?: number;
  skippedReason?: string;
  loading?: boolean;
  meta?: string;
}) {
  const shown = tracks.slice(0, 5);
  return (
    <SettingsGroup
      title="Tracks"
      actions={
        loading ? null : (
          <span className="settings-group__meta" aria-live="polite">
            {meta ??
              [`${total} importable`, skipped > 0 ? `${skipped} skipped` : null]
                .filter(Boolean)
                .join(" · ")}
          </span>
        )
      }
    >
      {loading ? (
        <p className="settings-loading">
          <DotLoader size="sm" label={null} />
          Counting importable tracks…
        </p>
      ) : total === 0 ? (
        <SettingsNote tone="warning">
          No downloadable tracks. Check the source playlist.
        </SettingsNote>
      ) : (
        <>
          {shown.map((track, index) => (
            <div key={index} className="playlist-import__track">
              <span className="playlist-import__track-title">{track.title}</span>
              <span className="playlist-import__track-artist">{track.artistName}</span>
            </div>
          ))}
          {total > shown.length ? (
            <p className="playlist-import__track-more">
              {formatTrackTotal(total - shown.length)} more
            </p>
          ) : null}
          {skipped > 0 && skippedReason ? <SettingsNote>{skippedReason}</SettingsNote> : null}
        </>
      )}
    </SettingsGroup>
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
  onClose: () => void;
  onImported?: () => void;
  showError?: (message: string) => void;
  showSuccess?: (message: string) => void;
  existingPlaylistNames?: string[];
  initialShareUrl?: string;
}

export function PlaylistImportModal({
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
  const [view, setView] = useState<"nav" | "pane">(initialShareUrl ? "pane" : "nav");
  const [shareSync, setShareSync] = useState(true);
  const [shareFiles, setShareFiles] = useState(false);
  const [lastfmUsernameDraft, setLastfmUsernameDraft] = useState<string | null>(null);
  const [lastfmRequestedUsername, setLastfmRequestedUsername] = useState<string | null>(null);
  const [youtubeUrl, setYoutubeUrl] = useState("");
  const [filePlaylist, setFilePlaylist] = useState<FilePlaylist | null>(null);
  const [fileError, setFileError] = useState("");
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
    setFilePlaylist(null);
    setFileError("");
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
    staleTime: 0,
  });
  const spotifyConnected = Boolean(spotifyStatusQuery.data?.connected);
  const spotifyPlaylistsQuery = useQuery({
    queryKey: queryKeys.playlistImportList("spotify"),
    queryFn: () => parseResponse(importApi.spotify.playlists.$get()),
    enabled: source === "spotify" && spotifyConnected,
  });
  const spotifyStatus = {
    connected: spotifyConnected,
    displayName: spotifyPlaylistsQuery.data?.user || spotifyStatusQuery.data?.displayName || null,
  };

  const scrobbleStatusQuery = useQuery({
    queryKey: queryKeys.scrobbleStatus,
    queryFn: () => parseResponse(scrobblingClient.status.$get()),
    enabled: source === "listenbrainz",
    staleTime: 0,
  });
  const listenBrainzAccount = scrobbleStatusQuery.data?.listenbrainz;
  const listenBrainzPlaylistsQuery = useQuery({
    queryKey: queryKeys.playlistImportList("listenbrainz"),
    queryFn: () => parseResponse(importApi.listenbrainz.playlists.$get()),
    enabled: source === "listenbrainz" && Boolean(listenBrainzAccount?.connected),
  });
  const listenBrainzStatus = {
    connected: Boolean(listenBrainzAccount?.connected) && !listenBrainzPlaylistsQuery.isError,
    displayName: listenBrainzPlaylistsQuery.data?.user || listenBrainzAccount?.displayName || null,
  };

  const lastfmProfileQuery = useQuery({
    ...listeningHistoryQueryOptions(user?.id),
    enabled: user?.id != null && source === "lastfm" && lastfmRequestedUsername === null,
  });
  const profileLastfmUsername = lastfmProfileQuery.data?.lastfm ?? "";
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
    enabled: source === "lastfm" && Boolean(lastfmUsernameRequest),
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
    enabled: ["spotify", "listenbrainz", "lastfm"].includes(source) && Boolean(pickedPlaylist?.id),
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
    enabled: source === "aurral" && Boolean(requestedShareUrl),
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

  const fileImport = useMutation({
    mutationFn: (
      json: InferRequestType<(typeof staticPlaylistsClient)["shared-playlists"]["$post"]>["json"],
    ) => parseResponse(staticPlaylistsClient["shared-playlists"].$post({ json })),
  });

  const importing = externalImport.isPending || shareImport.isPending || fileImport.isPending;
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
        : source === "file"
          ? filePlaylist && { id: filePlaylist.name, name: filePlaylist.name }
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
    setFilePlaylist(null);
    setFileError("");
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

  const handleChooseFile = async (file: File | undefined) => {
    if (!file) return;
    setPlaylistNameDraft(null);
    const { name, tracks, skipped } = parseM3u(await file.text());
    if (!tracks.length) {
      setFilePlaylist(null);
      setFileError("No tracks with an artist and title in this file.");
      return;
    }
    setFileError("");
    setFilePlaylist({ name: name || file.name.replace(/\.m3u8?$/i, ""), tracks, skipped });
  };

  const handleImportFile = () => {
    if (!filePlaylist || importing) return;
    const baseName = String(playlistName || filePlaylist.name).trim();
    if (!baseName) {
      showError?.("Playlist name is required");
      return;
    }
    const name = reserveUniqueName(new Set(reservedNameKeys), baseName);
    fileImport.mutate(
      { name, sourceName: "M3U file", tracks: filePlaylist.tracks },
      {
        onSuccess: () => {
          showSuccess?.(`Queued import of ${name}`);
          onImported?.();
          onClose?.();
        },
        onError: (error) => {
          showError?.(getApiErrorMessage(error, "Could not import this file."));
        },
      },
    );
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

  const sourceLabel = IMPORT_SOURCES.find((entry) => entry.id === source)?.label ?? "";
  const canImport = Boolean(
    source === "aurral"
      ? sharedPlaylist
      : source === "file"
        ? filePlaylist
        : selectedPlaylist?.id && previewTrackCount > 0 && !previewLoading,
  );
  const importCount =
    source === "aurral"
      ? (sharedPlaylist?.tracks.length ?? 0)
      : source === "file"
        ? (filePlaylist?.tracks.length ?? 0)
        : previewTrackCount;

  const clearSelection = () => {
    setPlaylistNameDraft(null);
    if (source === "youtube") youtubePreview.reset();
    else if (source === "aurral") handleChangeShare();
    else if (source === "file") setFilePlaylist(null);
    else setPickedPlaylist(null);
  };

  const nameRow = (
    <SettingsRow label="Name" htmlFor="playlist-import-name">
      <input
        id="playlist-import-name"
        type="text"
        className="input"
        value={playlistName}
        onChange={(event) => setPlaylistNameDraft(event.target.value)}
        disabled={importing}
      />
    </SettingsRow>
  );

  const loadRow = ({
    id,
    label,
    help,
    error,
    value,
    placeholder,
    loading,
    onChange,
    onLoad,
  }: {
    id: string;
    label: string;
    help: string;
    error: string;
    value: string;
    placeholder: string;
    loading: boolean;
    onChange: (value: string) => void;
    onLoad: () => void;
  }) => (
    <SettingsGroup>
      <SettingsRow
        label={label}
        htmlFor={id}
        help={error || help}
        tone={error ? "error" : "default"}
        stack
      >
        <div className="playlist-import__load">
          <input
            id={id}
            type="text"
            className="input"
            placeholder={placeholder}
            value={value}
            onChange={(event) => onChange(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === "Enter") {
                event.preventDefault();
                onLoad();
              }
            }}
            autoComplete="off"
            disabled={loading || importing}
          />
          <button
            type="button"
            className="btn btn-secondary"
            onClick={onLoad}
            disabled={loading || importing || !value.trim()}
          >
            {loading ? <DotLoader size="sm" label={null} /> : null}
            Load
          </button>
        </div>
      </SettingsRow>
    </SettingsGroup>
  );

  const renderSelected = () => {
    if (source === "aurral" && sharedPlaylist) {
      return (
        <>
          <SettingsGroup>
            {nameRow}
            <SettingsRow
              label="Keep synced"
              htmlFor="playlist-import-share-sync"
              help="Checks daily. New tracks download with your sources."
            >
              <input
                id="playlist-import-share-sync"
                type="radio"
                name="playlist-import-share-mode"
                className="artist-checkbox"
                checked={shareSync}
                onChange={() => setShareSync(true)}
                disabled={importing}
              />
            </SettingsRow>
            <SettingsRow
              label="Import once"
              htmlFor="playlist-import-share-once"
              help={
                shareFiles && sharedPlaylist.canDownload
                  ? "Saves today's tracklist with the sender's files."
                  : "Saves today's tracklist without downloading."
              }
            >
              <input
                id="playlist-import-share-once"
                type="radio"
                name="playlist-import-share-mode"
                className="artist-checkbox"
                checked={!shareSync}
                onChange={() => setShareSync(false)}
                disabled={importing}
              />
            </SettingsRow>
            {!shareSync && sharedPlaylist.canDownload && sharedPlaylist.downloads > 0 ? (
              <SettingsRow
                label="Use the sender's files"
                help={[
                  formatTrackTotal(sharedPlaylist.downloads),
                  sharedPlaylist.downloadBytes
                    ? `${Math.max(1, Math.round(sharedPlaylist.downloadBytes / 1024 / 1024)).toLocaleString()} MB`
                    : null,
                ]
                  .filter(Boolean)
                  .join(", ")}
              >
                <PillToggle
                  checked={shareFiles}
                  aria-label="Use the sender's files"
                  onChange={(event) => setShareFiles(event.target.checked)}
                  disabled={importing}
                />
              </SettingsRow>
            ) : null}
          </SettingsGroup>
          <ImportTracks
            tracks={sharedPlaylist.tracks}
            total={sharedPlaylist.tracks.length}
            meta={[
              formatTrackTotal(sharedPlaylist.tracks.length),
              sharedPlaylist.ready ? `${sharedPlaylist.ready} in your Library` : null,
            ]
              .filter(Boolean)
              .join(" · ")}
          />
        </>
      );
    }
    if (source === "file" && filePlaylist) {
      return (
        <>
          <SettingsGroup>{nameRow}</SettingsGroup>
          <ImportTracks
            tracks={filePlaylist.tracks.map((track) => ({
              artistName: track.artistName,
              title: track.trackName,
            }))}
            total={filePlaylist.tracks.length}
            skipped={filePlaylist.skipped}
            skippedReason="Skipped entries with missing artist or track details."
          />
        </>
      );
    }
    return (
      <>
        <SettingsGroup>
          {nameRow}
          <SettingsRow label="Sync" htmlFor="playlist-import-interval">
            <Select
              id="playlist-import-interval"
              value={syncIntervalHours}
              onChange={setSyncIntervalHours}
              disabled={importing}
              options={SYNC_INTERVAL_OPTIONS}
            />
          </SettingsRow>
          <SettingsRow label={`Keep tracks ${sourceLabel} removes`}>
            <PillToggle
              checked={keepRemovedTracks}
              aria-label={`Keep tracks ${sourceLabel} removes`}
              onChange={(event) => setKeepRemovedTracks(event.target.checked)}
              disabled={importing}
            />
          </SettingsRow>
        </SettingsGroup>
        <ImportTracks
          tracks={previewTracks.map((track) => ({
            artistName: track.artistName,
            title: track.trackName,
          }))}
          total={previewTrackCount}
          skipped={previewSkipped}
          skippedReason={
            SKIPPED_REASONS[source] ?? "Skipped entries with missing artist or track details."
          }
          loading={previewLoading}
        />
      </>
    );
  };

  const renderSource = () => {
    if (source === "file") {
      return (
        <SettingsGroup>
          <SettingsRow
            label="Playlist file"
            htmlFor="playlist-import-file"
            help={fileError || "Choose an M3U playlist exported from any player."}
            tone={fileError ? "error" : "default"}
            stack
          >
            <input
              id="playlist-import-file"
              type="file"
              className="input"
              accept=".m3u,.m3u8,audio/x-mpegurl,audio/mpegurl"
              onChange={(event) => void handleChooseFile(event.target.files?.[0])}
              disabled={importing}
            />
          </SettingsRow>
        </SettingsGroup>
      );
    }
    if (source === "aurral") {
      return loadRow({
        id: "playlist-import-share-url",
        label: "Share link or code",
        help: "Paste a share link or code from aurral.org.",
        error: shareError,
        value: shareUrl,
        placeholder: "https://aurral.org/s/… or code",
        loading: sharePreview.isFetching,
        onChange: setShareUrl,
        onLoad: handleLoadShare,
      });
    }
    if (source === "youtube") {
      return loadRow({
        id: "playlist-import-youtube-url",
        label: "Playlist URL",
        help: "Use a public YouTube or YouTube Music playlist.",
        error: youtubeError,
        value: youtubeUrl,
        placeholder: "https://music.youtube.com/playlist?list=…",
        loading: previewLoading,
        onChange: handleYoutubeUrlChange,
        onLoad: handlePreviewYoutube,
      });
    }
    if (source === "spotify" && !spotifyStatus.connected) {
      return (
        <SettingsGroup>
          <SettingsRow label="Spotify account" help="Connect to see your playlists.">
            <button
              type="button"
              className="btn btn-primary btn-sm"
              onClick={() => connectSpotify.mutate()}
              disabled={spotifyLoading || importing}
            >
              {spotifyLoading ? <DotLoader size="sm" label={null} /> : null}
              Connect Spotify
            </button>
          </SettingsRow>
        </SettingsGroup>
      );
    }
    if (source === "listenbrainz" && !listenBrainzStatus.connected) {
      return (
        <SettingsGroup>
          <SettingsRow
            label="ListenBrainz account"
            help={listenBrainzLoading ? "Checking…" : "Connect ListenBrainz in Settings first."}
          >
            <SettingsLink
              to="listening/listenbrainz"
              className="btn btn-secondary btn-sm"
              onClick={onClose}
            >
              Open Settings
            </SettingsLink>
          </SettingsRow>
        </SettingsGroup>
      );
    }
    if (source === "lastfm" && !lastfmUsername) {
      return (
        <SettingsGroup>
          <SettingsRow
            label="Last.fm username"
            htmlFor="playlist-import-lastfm-username"
            help="Loads your Library, Mix, and Recommended stations. Saved for future syncs."
            stack
          >
            <div className="playlist-import__load">
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
              <button
                type="button"
                className="btn btn-secondary"
                onClick={() => loadLastfmPlaylists(lastfmUsernameInput)}
                disabled={
                  lastfmProfileLoading || lastfmLoading || !lastfmUsernameInput.trim() || importing
                }
              >
                {lastfmProfileLoading || lastfmLoading ? (
                  <DotLoader size="sm" label={null} />
                ) : null}
                Load
              </button>
            </div>
          </SettingsRow>
        </SettingsGroup>
      );
    }
    const listLoading =
      source === "spotify"
        ? spotifyLoading
        : source === "listenbrainz"
          ? listenBrainzLoading
          : lastfmLoading;
    return (
      <>
        <SettingsGroup>
          <SettingsRow
            label={`Signed in as ${
              (source === "spotify"
                ? spotifyStatus
                : source === "listenbrainz"
                  ? listenBrainzStatus
                  : { displayName: lastfmUsername }
              ).displayName || sourceLabel
            }`}
          >
            {source === "spotify" ? (
              <button
                type="button"
                className="btn btn-secondary btn-sm"
                onClick={() => disconnectSpotifyAccount.mutate()}
                disabled={spotifyLoading || importing}
              >
                Disconnect
              </button>
            ) : source === "lastfm" ? (
              <button
                type="button"
                className="btn btn-secondary btn-sm"
                onClick={changeLastfmUsername}
                disabled={lastfmLoading || importing}
              >
                Change
              </button>
            ) : null}
          </SettingsRow>
        </SettingsGroup>
        <SettingsGroup
          title={source === "lastfm" ? "Stations" : "Playlists"}
          note={source === "listenbrainz" ? "Weekly playlists use the latest week." : undefined}
        >
          {playlists.length > 0 ? (
            <div>
              <input
                type="search"
                className="input"
                placeholder="Search playlists"
                aria-label="Search playlists"
                value={playlistQuery}
                onChange={(event) => setPlaylistQuery(event.target.value)}
                disabled={importing}
              />
            </div>
          ) : null}
          {listLoading && playlists.length === 0 ? (
            <p className="settings-loading">
              <DotLoader size="sm" label={null} />
              Loading playlists…
            </p>
          ) : filteredPlaylists.length === 0 ? (
            <SettingsNote>No playlists found</SettingsNote>
          ) : (
            filteredPlaylists.map((playlist) => (
              <button
                key={playlist.id}
                type="button"
                className="settings-service"
                onClick={() => handleSelectPlaylist(playlist)}
                disabled={importing}
              >
                <span className="settings-service__name">{playlist.name}</span>
                <span className="settings-service__status settings-service__status--muted">
                  {getPlaylistMeta(playlist)}
                </span>
                <ChevronRight className="settings-service__chevron" aria-hidden="true" />
              </button>
            ))
          )}
        </SettingsGroup>
      </>
    );
  };

  return (
    <SettingsShell
      label="Import"
      view={view}
      onClose={onClose}
      closeDisabled={importing}
      nav={
        <nav className="settings-dialog__group" aria-label="Import from">
          {IMPORT_SOURCES.map((entry) => {
            const active = entry.id === source;
            return (
              <button
                key={entry.id}
                type="button"
                className={`settings-dialog__link${active ? " is-active" : ""}`}
                aria-current={active ? "page" : undefined}
                onClick={() => {
                  if (!active) selectSource(entry.id);
                  setView("pane");
                }}
                disabled={importing}
              >
                {entry.label}
              </button>
            );
          })}
        </nav>
      }
    >
      <SettingsPane
        crumbs={
          selectedPlaylist
            ? [{ label: "Import" }, { label: sourceLabel, onClick: clearSelection }]
            : [{ label: "Import" }]
        }
        title={selectedPlaylist ? selectedPlaylist.name : sourceLabel}
        backLabel={selectedPlaylist ? `Back to ${sourceLabel}` : "Back to import"}
        onBack={selectedPlaylist ? clearSelection : () => setView("nav")}
        closeLabel="Close import"
        onClose={onClose}
        closeDisabled={importing}
        actions={
          selectedPlaylist ? (
            <button
              type="button"
              className="btn btn-primary btn-sm"
              onClick={
                source === "aurral"
                  ? handleImportShare
                  : source === "file"
                    ? handleImportFile
                    : handleImportExternal
              }
              disabled={importing || !canImport}
            >
              {importing ? <DotLoader size="sm" label={null} /> : null}
              {importCount > 0 ? `Import ${formatTrackTotal(importCount)}` : "Import"}
            </button>
          ) : null
        }
      >
        {selectedPlaylist ? renderSelected() : renderSource()}
      </SettingsPane>
    </SettingsShell>
  );
}
