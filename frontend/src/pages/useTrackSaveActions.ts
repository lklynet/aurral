import { useCallback, useState } from "react";
import { useAuth } from "../contexts/AuthContext";
import { useToast } from "../contexts/ToastContext";
import { useStaticPlaylists } from "../hooks/useStaticPlaylists";
import { downloadTrackToLibrary } from "../utils/api/endpoints/library.ts";
import { parseResponse } from "hono/client";
import { staticPlaylistsClient } from "../utils/api/clients/staticPlaylists.ts";
import { reserveUniquePlaylistName } from "./ArtistDetails/utils";
import { normalizePlaylistTrackEntry } from "./playlists/flowPageUtils";
import { getApiErrorMessage } from "./onboardingUtils";

type SaveTrack = { id: string; artistName: string; trackName: string };
type PlaylistSaveTarget =
  | { mode: "new"; name?: string | null }
  | { mode?: "existing"; playlistId: string };

export function useTrackSaveActions() {
  const { hasPermission } = useAuth();
  const { showSuccess, showError } = useToast();
  const {
    staticPlaylists,
    setStaticPlaylists,
    playlistsLoading,
    playlistsError,
    setPlaylistsError,
    loadStaticPlaylists,
  } = useStaticPlaylists();
  const [playlistSavingKey, setPlaylistSavingKey] = useState("");
  const [libraryTrackSavingKey, setLibraryTrackSavingKey] = useState("");
  const [bulkActionLoading, setBulkActionLoading] = useState(false);

  const getDefaultPlaylistName = useCallback(
    (track: Pick<SaveTrack, "artistName"> | undefined) =>
      reserveUniquePlaylistName(staticPlaylists, `${track?.artistName || "Artist"} Picks`),
    [staticPlaylists],
  );

  const saveToPlaylist = useCallback(
    async (tracks: SaveTrack[], target: PlaylistSaveTarget) => {
      const payloads = tracks
        .map(normalizePlaylistTrackEntry)
        .filter((payload) => payload !== null);
      if (payloads.length === 0) {
        showError("No valid tracks to add");
        return;
      }
      setPlaylistsError("");
      try {
        let name;
        if (target?.mode === "new") {
          const requested =
            String(target?.name || "").trim() || getDefaultPlaylistName(payloads[0]);
          await parseResponse(
            staticPlaylistsClient["shared-playlists"].$post({
              json: { name: requested, tracks: payloads },
            }),
          );
          name = requested;
        } else {
          await parseResponse(
            staticPlaylistsClient["shared-playlists"][":playlistId"].tracks.$post({
              param: { playlistId: encodeURIComponent(target.playlistId) },
              json: { tracks: payloads },
            }),
          );
          name =
            staticPlaylists.find((entry) => entry.id === target.playlistId)?.name || "playlist";
        }
        showSuccess(
          payloads.length === 1
            ? `Added ${payloads[0].trackName} to ${name}`
            : `Added ${payloads.length} tracks to ${name}`,
        );
        const nextPlaylists = await loadStaticPlaylists();
        if (nextPlaylists) setStaticPlaylists(nextPlaylists);
      } catch (error) {
        const message = getApiErrorMessage(
          error,
          "Couldn't add to the playlist. Nothing was added.",
        );
        setPlaylistsError(message);
        showError(message);
      }
    },
    [
      getDefaultPlaylistName,
      loadStaticPlaylists,
      setPlaylistsError,
      setStaticPlaylists,
      staticPlaylists,
      showError,
      showSuccess,
    ],
  );

  const handleAddTrackToPlaylist = useCallback(
    async (track: SaveTrack, target: PlaylistSaveTarget) => {
      setPlaylistSavingKey(String(track?.id ?? ""));
      try {
        await saveToPlaylist([track], target);
      } finally {
        setPlaylistSavingKey("");
      }
    },
    [saveToPlaylist],
  );

  const handleBulkAddToPlaylist = useCallback(
    async (tracks: SaveTrack[], target: PlaylistSaveTarget) => {
      setBulkActionLoading(true);
      try {
        await saveToPlaylist(tracks, target);
      } finally {
        setBulkActionLoading(false);
      }
    },
    [saveToPlaylist],
  );

  const handleAddTrackToLibrary = useCallback(
    async (track: SaveTrack) => {
      if (libraryTrackSavingKey) return;
      const payload = normalizePlaylistTrackEntry(track);
      if (!payload) {
        showError("Track details are incomplete");
        return;
      }
      setLibraryTrackSavingKey(String(track?.id ?? ""));
      try {
        const result = await downloadTrackToLibrary(payload);
        showSuccess(
          result?.alreadyOwned
            ? `${payload.trackName} is already in your library`
            : `Queued ${payload.trackName} for your library`,
        );
      } catch (error) {
        showError(getApiErrorMessage(error, "Couldn't add the track to your library"));
      } finally {
        setLibraryTrackSavingKey("");
      }
    },
    [libraryTrackSavingKey, showError, showSuccess],
  );

  const handleBulkAddToLibrary = useCallback(
    async (tracks: SaveTrack[]) => {
      const payloads = tracks
        .map(normalizePlaylistTrackEntry)
        .filter((payload) => payload !== null);
      if (payloads.length === 0) return;
      setBulkActionLoading(true);
      let queued = 0;
      let owned = 0;
      let failed = 0;
      for (const payload of payloads) {
        try {
          const result = await downloadTrackToLibrary(payload);
          if (result?.alreadyOwned) owned += 1;
          else queued += 1;
        } catch {
          failed += 1;
        }
      }
      setBulkActionLoading(false);
      const parts = [];
      if (queued)
        parts.push(`Queued ${queued} ${queued === 1 ? "track" : "tracks"} for your library`);
      if (owned) parts.push(`${owned} already in your library`);
      if (failed) {
        showError(
          `${failed} ${failed === 1 ? "track" : "tracks"} couldn't be added.${parts.length ? ` ${parts.join(". ")}.` : ""}`,
        );
      } else {
        showSuccess(`${parts.join(". ")}.`);
      }
    },
    [showError, showSuccess],
  );

  const canUsePlaylists = hasPermission("accessFlow");
  const canAddToLibrary = hasPermission("addAlbum");
  return {
    playlists: staticPlaylists,
    playlistsLoading,
    playlistMenuError: playlistsError,
    playlistSavingKey,
    getDefaultPlaylistName,
    onLoadPlaylists: loadStaticPlaylists,
    onAddTrackToPlaylist: canUsePlaylists ? handleAddTrackToPlaylist : undefined,
    allowBulkEdit: canUsePlaylists || canAddToLibrary,
    onBulkAddToPlaylist: canUsePlaylists ? handleBulkAddToPlaylist : undefined,
    bulkAddLabel: "Add to playlist",
    onBulkAddToLibrary: canAddToLibrary ? handleBulkAddToLibrary : undefined,
    bulkActionLoading,
    onAddTrackToLibrary: canAddToLibrary ? handleAddTrackToLibrary : undefined,
    libraryTrackSavingKey,
  };
}
