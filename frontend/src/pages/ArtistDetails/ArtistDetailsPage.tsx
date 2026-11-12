import { useCallback, useId, useMemo, useState } from "react";
import type { Dispatch, SetStateAction } from "react";
import { createPortal } from "react-dom";
import type { ReleaseGroupTrack } from "../../utils/api/endpoints/artists.ts";
import { useMutation, useQuery } from "@tanstack/react-query";
import { getArtistPreview, updateArtistOverrides } from "../../utils/api/endpoints/artists.ts";
import { useAddTrackToLibrary } from "../../hooks/useAddTrackToLibrary";
import { parseResponse } from "hono/client";
import { artistsClient } from "../../utils/api/clients/artists.ts";
import { staticPlaylistsClient } from "../../utils/api/clients/staticPlaylists.ts";
import { buildTasteArtist, getArtistHeroImage, getCoverImage } from "./utils";
import { useArtworkWash } from "../../utils/imageColors";
import { useArtistTasteFeedback } from "../../hooks/useArtistTasteFeedback";
import { useStaticPlaylists } from "../../hooks/useStaticPlaylists";

import { useParams } from "react-router";
import { AlertCircle, X } from "../../components/icons";
import { DotLoader } from "../../components/DotLoader";
import { normalizeMediaUrl } from "../../utils/normalizeMediaUrl";
import { useToast } from "../../contexts/ToastContext";
import { useAuth } from "../../contexts/AuthContext";
import { useDocumentTitle } from "../../hooks/useDocumentTitle";
import { useModalDialog } from "../../hooks/useModalDialog.ts";
import { useArtistDetails } from "./hooks/useArtistDetails";
import { useArtistRouteState } from "./hooks/useArtistRouteState.ts";
import { usePreviewPlayer } from "./hooks/usePreviewPlayer";
import { useArtistDetailsLibrary } from "./hooks/useArtistDetailsLibrary";
import { ArtistDetailsHero } from "./components/ArtistDetailsHero";
import { ArtistDetailsActionBar } from "./components/ArtistDetailsActionBar";
import { ArtistDetailsVideos } from "./components/ArtistDetailsVideos";
import { useArtistVideos } from "./artistVideosSetting.ts";
import { matchesReleaseGroupTab } from "./releaseFilters.ts";
import "./ArtistDetailsPage.css";
import { ArtistDetailsDownloadTargets } from "./components/ArtistDetailsDownloadTargets";
import { ArtistDetailsReleaseGroups } from "./components/ArtistDetailsReleaseGroups";
import { ArtistDetailsAppearsOn } from "./components/ArtistDetailsAppearsOn";
import { ArtistDetailsPreviewTracks } from "./components/ArtistDetailsPreviewTracks";
import { ArtistDetailsAbout } from "./components/ArtistDetailsAbout";
import { ArtistDetailsSimilar } from "./components/ArtistDetailsSimilar";
import { ArtistDetailsPlaylists } from "./components/ArtistDetailsPlaylists";
import { queryKeys } from "../../queryClient.ts";
import TooltipButton from "../../components/TooltipButton";
import RouteLink from "../../components/RouteLink";
import type { PlaylistSelection, PlaylistTrackIdentity } from "../../components/TrackPlaylistMenu";
import type { ArtistPreviewTrack } from "./hooks/usePreviewPlayer";
import type { ReleaseGroup } from "./utils";
import { releaseTrackPayload } from "../album/releaseTracks.tsx";
import type { ArtistFeedbackSource } from "../../utils/artistTaste.ts";
import StatePanel from "../../components/StatePanel";
import { getApiErrorMessage } from "../../utils/api/errors.ts";
import {
  buildStaticPlaylistTrackPayload,
  reserveUniquePlaylistName,
} from "../../utils/staticPlaylists.ts";
const MBID_REGEX = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function ArtistDetailsPage() {
  const { mbid } = useParams();
  const {
    artistName: artistNameFromNav,
    artistImage: artistImageFromNav,
    inLibrary,
  } = useArtistRouteState();
  const { showSuccess, showError, showInfo } = useToast();
  const { hasPermission } = useAuth();
  const [showEditIdsModal, setShowEditIdsModal] = useState(false);
  const [idsError, setIdsError] = useState("");
  const [idsValues, setIdsValues] = useState({
    musicbrainzId: "",
    deezerArtistId: "",
  });
  const {
    staticPlaylists,
    setStaticPlaylists,
    playlistsLoading: playlistModalLoading,
    playlistsError: playlistModalError,
    setPlaylistsError: setPlaylistModalError,
    loadStaticPlaylists,
  } = useStaticPlaylists();
  const [playlistMenuSavingKey, setPlaylistMenuSavingKey] = useState("");
  const { savingKeys: libraryTrackSavingKeys, addTrackToLibrary } = useAddTrackToLibrary();

  const artistOverridesQuery = useQuery({
    queryKey: queryKeys.artistOverrides(mbid),
    queryFn: ({ signal }) =>
      parseResponse(
        artistsClient[":mbid"].overrides.$get(
          { param: { mbid: encodeURIComponent(mbid ?? "") } },
          { init: { signal } },
        ),
      ),
    enabled: false,
    staleTime: 30_000,
  });
  const saveArtistOverridesMutation = useMutation({
    mutationFn: ({
      artistMbid,
      values,
    }: {
      artistMbid: string;
      values: Parameters<typeof updateArtistOverrides>[1];
    }) => updateArtistOverrides(artistMbid, values),
  });
  const { mutateAsync: saveArtistOverrides } = saveArtistOverridesMutation;
  const idsLoading = artistOverridesQuery.isFetching;
  const idsSaving = saveArtistOverridesMutation.isPending;

  const details = useArtistDetails(mbid, artistNameFromNav, {
    inLibrary,
    seedImage: artistImageFromNav ? normalizeMediaUrl(artistImageFromNav) || null : null,
    similar: true,
  });
  const canAddArtist = hasPermission("addArtist");
  const {
    lookup: artistFeedbackLookup,
    getFeedbackFlags,
    submitFeedback,
  } = useArtistTasteFeedback();
  type TasteAction = keyof ReturnType<typeof getFeedbackFlags>;
  const [tasteActionPending, setTasteActionPending] = useState<TasteAction | null>(null);
  const canAddAlbum = hasPermission("addAlbum");
  const canChangeMonitoring = hasPermission("changeMonitoring");
  const {
    artist,
    coverImages,
    refreshCover,
    similarArtists,
    error,
    loadingSimilar,
    loadingLibrary,
    loadingReleases,
    loadingAppearsOn,
    existsInLibrary,
    libraryArtistId,
  } = details;

  const artistDisplayName = artist?.name || artistNameFromNav || "";
  useDocumentTitle(artistDisplayName);

  const tasteArtist = useMemo(
    () =>
      buildTasteArtist({
        id: artist?.id || mbid,
        name: artistDisplayName,
        tags: artist?.tags,
        genres: artist?.genres,
      }),
    [artist?.genres, artist?.id, artist?.tags, artistDisplayName, mbid],
  );

  const currentArtistFeedback = useMemo(
    () => getFeedbackFlags(tasteArtist),
    [getFeedbackFlags, tasteArtist],
  );

  const handleArtistTasteFeedback = useCallback(
    async (
      targetArtist: ArtistFeedbackSource,
      action: TasteAction,
      { isSelected = false } = {},
    ) => {
      setTasteActionPending(action);
      try {
        return await submitFeedback(targetArtist, action, {
          isSelected,
          sourceContext: "artist_page",
          seedArtistName: tasteArtist.name,
        });
      } finally {
        setTasteActionPending(null);
      }
    },
    [submitFeedback, tasteArtist.name],
  );

  const handleCurrentArtistTasteFeedback = useCallback(
    async (action: TasteAction) => {
      await handleArtistTasteFeedback(tasteArtist, action, {
        isSelected: !!currentArtistFeedback[action],
      });
    },
    [currentArtistFeedback, handleArtistTasteFeedback, tasteArtist],
  );

  const library = useArtistDetailsLibrary({
    ...details,
    showSuccess,
    showError,
    showInfo,
  });

  const preview = usePreviewPlayer(mbid, artistNameFromNav, artist);
  const {
    previewTracks,
    loadingPreview,
    buildingQueue,
    setLoadingPreview,
    playingPreviewId,
    isArtistPlaybackActive,
    handlePreviewPlay,
    handlePreviewPlayAll,
    handlePreviewShuffle,
    canPlayPreviews,
    setPreviewTracks,
  } = preview;
  const showVideos = useArtistVideos();

  const handleOpenEditIds = async () => {
    if (!mbid) return;
    setShowEditIdsModal(true);
    setIdsError("");
    try {
      const { data } = await artistOverridesQuery.refetch({ throwOnError: true });
      setIdsValues({
        musicbrainzId: data?.musicbrainzId || "",
        deezerArtistId: data?.deezerArtistId || "",
      });
    } catch (err) {
      showError(getApiErrorMessage(err, "Failed to load artist IDs"));
    }
  };

  const handleSaveIds = async () => {
    if (!mbid || idsSaving) return;
    const musicbrainzId = idsValues.musicbrainzId.trim();
    const deezerArtistId = idsValues.deezerArtistId.trim();
    if (musicbrainzId && !MBID_REGEX.test(musicbrainzId)) {
      setIdsError("MusicBrainz ID must be a valid UUID.");
      return;
    }
    if (deezerArtistId && !/^\d+$/.test(deezerArtistId)) {
      setIdsError("Deezer artist ID must be numeric.");
      return;
    }
    setIdsError("");
    setLoadingPreview(true);
    try {
      await saveArtistOverrides({
        artistMbid: mbid,
        values: {
          musicbrainzId: musicbrainzId || null,
          deezerArtistId: deezerArtistId || null,
        },
      });
      showSuccess("Artist IDs updated");
      setShowEditIdsModal(false);
      const name = artist?.name || artistNameFromNav || "";
      const [previewData] = await Promise.all([
        getArtistPreview(mbid, name).catch(() => ({ tracks: [] })),
        refreshCover(),
      ]);
      setPreviewTracks(previewData?.tracks || []);
    } catch (err) {
      showError(getApiErrorMessage(err, "Failed to update artist IDs"));
    } finally {
      setLoadingPreview(false);
    }
  };

  const getDefaultTrackPlaylistName = (track: PlaylistTrackIdentity | null | undefined) =>
    reserveUniquePlaylistName(
      staticPlaylists,
      `${artist?.name || artistNameFromNav || track?.artistName || "Artist"} Picks`,
    );

  const buildReleaseTrackPayload = (
    track: ReleaseGroupTrack,
    releaseGroup: ReleaseGroup | undefined,
  ) => releaseTrackPayload(releaseGroup, track, artist?.name || artistNameFromNav || "", mbid);

  const buildPreviewTrackPayload = (track: ArtistPreviewTrack) =>
    buildStaticPlaylistTrackPayload({
      artistName: artist?.name || artistNameFromNav || "",
      trackName: track.title,
      albumName: track.album || "",
      artistMbid: mbid || "",
      albumMbid: "",
      trackMbid: track.id,
      releaseYear: null,
      durationMs: track?.duration_ms,
      reason: "Artist preview",
    });

  const saveTrackToPlaylist = async (
    trackPayload: StaticPlaylistTrackPayload,
    target: PlaylistSelection,
    savingKey: string,
  ) => {
    if (!trackPayload?.artistName || !trackPayload?.trackName) {
      showError("Track details are incomplete");
      return;
    }
    setPlaylistModalError("");
    setPlaylistMenuSavingKey(String(savingKey || ""));
    try {
      if (target?.mode === "new") {
        const name =
          String(target?.name || "").trim() ||
          reserveUniquePlaylistName(staticPlaylists, `${trackPayload.artistName} Picks`);
        await parseResponse(
          staticPlaylistsClient["static-playlists"].$post({
            json: {
              name,
              tracks: [trackPayload],
            },
          }),
        );
        showSuccess(`Track saved to ${name}`);
      } else {
        const targetPlaylist = staticPlaylists.find(
          (playlist) => playlist.id === target?.playlistId,
        );
        await parseResponse(
          staticPlaylistsClient["static-playlists"][":playlistId"].tracks.$post({
            param: { playlistId: encodeURIComponent(target.playlistId) },
            json: {
              tracks: [trackPayload],
            },
          }),
        );
        showSuccess(`Track added to ${targetPlaylist?.name || "playlist"}`);
      }
      const nextPlaylists = await loadStaticPlaylists();
      if (nextPlaylists) {
        setStaticPlaylists(nextPlaylists);
      }
    } catch (err) {
      const message = getApiErrorMessage(err, "Failed to save track to playlist");
      setPlaylistModalError(message);
      showError(message);
    } finally {
      setPlaylistMenuSavingKey("");
    }
  };

  const handleReleaseTrackAdd = (
    track: ReleaseGroupTrack,
    releaseGroup: ReleaseGroup | undefined,
    target: PlaylistSelection,
  ) => {
    const payload = buildReleaseTrackPayload(track, releaseGroup);
    const savingKey = String(track?.id ?? track?.mbid ?? "");
    return saveTrackToPlaylist(payload, target, savingKey);
  };

  const handlePreviewTrackAdd = (track: ArtistPreviewTrack, target: PlaylistSelection) => {
    const payload = buildPreviewTrackPayload(track);
    const savingKey = String(track?.id ?? track?.title ?? "");
    return saveTrackToPlaylist(payload, target, savingKey);
  };

  const heroWash = useArtworkWash(getArtistHeroImage(coverImages));
  const { getAlbumStatus } = library;
  const librarySummary = useMemo(() => {
    if (!existsInLibrary || !libraryArtistId) return null;
    const albums = (artist?.["release-groups"] ?? []).filter((releaseGroup) =>
      matchesReleaseGroupTab(releaseGroup, "albums"),
    );
    const owned = albums.flatMap((releaseGroup) => {
      const status = releaseGroup.id ? getAlbumStatus(releaseGroup.id) : null;
      return status?.status === "available" ? [status] : [];
    });
    return {
      to: `/library/artist/${encodeURIComponent(libraryArtistId)}`,
      owned: owned.length,
      total: albums.length,
      incomplete: owned.filter((status) => status.partial).length,
    };
  }, [artist, existsInLibrary, getAlbumStatus, libraryArtistId]);

  if (error) {
    return (
      <StatePanel
        role="alert"
        icon={<AlertCircle />}
        title="Couldn’t load this artist"
        message={error}
      >
        <RouteLink to="/search" className="btn btn-secondary">
          Back to search
        </RouteLink>
      </StatePanel>
    );
  }

  if (!artist) {
    return null;
  }

  const artistCoverImage = getCoverImage(coverImages);
  const playbackSource = {
    type: "artist",
    id: mbid!,
    label: artistDisplayName,
  } as const;

  return (
    <div
      className="artist-details-page artist-overview"
      style={
        heroWash
          ? {
              "--artwork-wash": `light-dark(${heroWash.light}, ${heroWash.dark})`,
              "--artwork-wash-dark": heroWash.dark,
            }
          : undefined
      }
    >
      <ArtistDetailsHero artist={artist} coverImages={coverImages} onCoverError={refreshCover} />

      <ArtistDetailsActionBar
        library={library}
        mbid={mbid!}
        artistName={artist?.name || artistNameFromNav || ""}
        existsInLibrary={existsInLibrary}
        librarySummary={librarySummary}
        loadingLibrary={loadingLibrary}
        canChangeMonitoring={canChangeMonitoring}
        canAddArtist={canAddArtist}
        buildingQueue={buildingQueue}
        isArtistPlaybackActive={isArtistPlaybackActive}
        handlePreviewPlayAll={handlePreviewPlayAll}
        handlePreviewShuffle={handlePreviewShuffle}
        canPlayPreviews={canPlayPreviews}
        missingDownloads={
          canAddAlbum && (library.missingDownloadCount > 0 || library.reSearchingMissingAlbums)
            ? {
                count: library.missingDownloadCount,
                pending: library.reSearchingMissingAlbums,
                onFind: library.handleReSearchMissingDownloads,
              }
            : null
        }
        onEditIds={handleOpenEditIds}
        onTasteFeedback={handleCurrentArtistTasteFeedback}
        tasteFeedbackUsed={currentArtistFeedback}
        tasteActionPending={tasteActionPending}
      />

      <div className="artist-top">
        <ArtistDetailsPreviewTracks
          mbid={mbid!}
          artistName={artist?.name || artistNameFromNav || ""}
          loadingPreview={loadingPreview}
          previewTracks={previewTracks}
          playingPreviewId={playingPreviewId}
          isArtistPlaybackActive={isArtistPlaybackActive}
          handlePreviewPlay={handlePreviewPlay}
          onAddTrackToPlaylist={handlePreviewTrackAdd}
          onAddTrackToLibrary={(track, trackKey) =>
            addTrackToLibrary(buildPreviewTrackPayload(track), trackKey)
          }
          libraryTrackSavingKeys={libraryTrackSavingKeys}
          resolveMembershipTrack={buildPreviewTrackPayload}
          playlists={staticPlaylists}
          playlistsLoading={playlistModalLoading}
          playlistSavingKey={playlistMenuSavingKey}
          playlistError={playlistModalError}
          getDefaultPlaylistName={getDefaultTrackPlaylistName}
          onLoadPlaylists={loadStaticPlaylists}
        />

        <ArtistDetailsDownloadTargets
          releaseGroups={artist?.["release-groups"] || []}
          getAlbumStatus={library.getAlbumStatus}
          artist={artist}
          artistCoverImage={artistCoverImage}
          canAddAlbum={canAddAlbum}
          requestingAlbum={library.requestingAlbum}
          handleRequestAlbum={library.handleRequestAlbum}
          playbackSource={playbackSource}
          artistName={artistDisplayName}
          onAddTrackToPlaylist={handleReleaseTrackAdd}
          onAddTrackToLibrary={(track, releaseGroup, trackKey) =>
            addTrackToLibrary(buildReleaseTrackPayload(track, releaseGroup), trackKey)
          }
          libraryTrackSavingKeys={libraryTrackSavingKeys}
          resolveMembershipTrack={buildReleaseTrackPayload}
          playlists={staticPlaylists}
          playlistsLoading={playlistModalLoading}
          playlistSavingKey={playlistMenuSavingKey}
          playlistError={playlistModalError}
          getDefaultPlaylistName={getDefaultTrackPlaylistName}
          onLoadPlaylists={loadStaticPlaylists}
        />
      </div>

      {(loadingReleases ||
        Boolean(artist["release-groups"]?.length) ||
        library.libraryReleaseGroups.length > 0) && (
        <ArtistDetailsReleaseGroups
          artist={artist}
          loadingReleases={loadingReleases}
          artistCoverImage={artistCoverImage}
          getAlbumStatus={library.getAlbumStatus}
          libraryReleaseGroups={library.libraryReleaseGroups}
          missingDownloadCount={library.missingDownloadCount}
          reSearchingMissingAlbums={library.reSearchingMissingAlbums}
          onReSearchMissingDownloads={canAddAlbum ? library.handleReSearchMissingDownloads : null}
          canAddAlbum={canAddAlbum}
          handleRequestAlbum={library.handleRequestAlbum}
          requestingAlbum={library.requestingAlbum}
          artistName={artistDisplayName}
          viewAllLink={{
            to: `/artist/${artist.id}/albums`,
            state: { artistName: artist.name, inLibrary: existsInLibrary },
          }}
        />
      )}

      {(loadingAppearsOn ||
        (artist["appears-on-release-groups"] &&
          artist["appears-on-release-groups"].length > 0)) && (
        <ArtistDetailsAppearsOn
          artist={artist}
          loadingAppearsOn={loadingAppearsOn}
          artistCoverImage={artistCoverImage}
          getAlbumStatus={library.getAlbumStatus}
          canAddAlbum={canAddAlbum}
          handleRequestAlbum={library.handleRequestAlbum}
          requestingAlbum={library.requestingAlbum}
          artistName={artistDisplayName}
          viewAllLink={{
            to: `/artist/${artist.id}/appears-on`,
            state: { artistName: artist.name, inLibrary: existsInLibrary },
          }}
        />
      )}

      {showVideos && !loadingPreview && previewTracks.length > 0 ? (
        <ArtistDetailsVideos mbid={mbid!} artistName={artistDisplayName} tracks={previewTracks} />
      ) : null}

      {(loadingSimilar || similarArtists.length > 0) && (
        <ArtistDetailsSimilar
          loadingSimilar={loadingSimilar}
          similarArtists={similarArtists}
          onArtistFeedback={handleArtistTasteFeedback}
          artistFeedbackLookup={artistFeedbackLookup}
        />
      )}

      <ArtistDetailsPlaylists mbid={mbid!} artistName={artistDisplayName} />

      <ArtistDetailsAbout artist={artist} />

      <EditArtistIdsModal
        show={showEditIdsModal}
        loading={idsLoading}
        saving={idsSaving}
        values={idsValues}
        error={idsError}
        artistName={artist?.name}
        onChange={setIdsValues}
        onClose={() => setShowEditIdsModal(false)}
        onSave={handleSaveIds}
      />
    </div>
  );
}

export default ArtistDetailsPage;

type StaticPlaylistTrackPayload = ReturnType<typeof buildStaticPlaylistTrackPayload>;

type EditArtistIdsModalProps = {
  show: boolean;
  loading: boolean;
  saving: boolean;
  values: { musicbrainzId: string; deezerArtistId: string };
  error: string;
  artistName: string | undefined;
  onChange: Dispatch<SetStateAction<{ musicbrainzId: string; deezerArtistId: string }>>;
  onClose: () => void;
  onSave: () => void;
};

function EditArtistIdsModal({
  show,
  loading,
  saving,
  values,
  error,
  artistName,
  onChange,
  onClose,
  onSave,
}: EditArtistIdsModalProps) {
  const titleId = useId();
  const { dialogRef, handleBackdropClick } = useModalDialog({
    open: show,
    onClose,
    closeDisabled: saving,
  });

  if (!show) return null;
  return createPortal(
    <div className="artist-modal-backdrop" onClick={handleBackdropClick}>
      <div
        ref={dialogRef}
        className="artist-modal"
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        tabIndex={-1}
      >
        <div className="artist-modal__header">
          <h3 id={titleId} className="artist-modal__title">
            Edit artist IDs
          </h3>
          <TooltipButton
            type="button"
            className="btn btn-ghost btn-icon-square"
            onClick={onClose}
            aria-label="Close"
            title="Close"
          >
            <X className="artist-icon-md" aria-hidden="true" />
          </TooltipButton>
        </div>
        {artistName ? <p className="artist-modal__subcopy">{artistName}</p> : null}
        <div className="artist-modal__fields">
          <div>
            <label className="artist-field-label">MusicBrainz ID</label>
            <input
              type="text"
              value={values.musicbrainzId}
              disabled={loading || saving}
              onChange={(e) =>
                onChange((prev) => ({
                  ...prev,
                  musicbrainzId: e.target.value,
                }))
              }
              placeholder="xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx"
              className="artist-input"
            />
          </div>
          <div>
            <label className="artist-field-label">Deezer artist ID</label>
            <input
              type="text"
              value={values.deezerArtistId}
              disabled={loading || saving}
              onChange={(e) =>
                onChange((prev) => ({
                  ...prev,
                  deezerArtistId: e.target.value,
                }))
              }
              placeholder="Numeric Deezer ID"
              className="artist-input"
            />
          </div>
          <p className="artist-subtext">Leave both fields blank to clear overrides.</p>
          {error && <div className="artist-error-text">{error}</div>}
        </div>
        <div className="artist-modal__actions">
          <button type="button" className="btn btn-secondary" onClick={onClose} disabled={saving}>
            Cancel
          </button>
          <button
            type="button"
            className="btn btn-primary"
            onClick={onSave}
            disabled={loading || saving}
          >
            {saving ? <DotLoader size="sm" label={null} /> : null}
            {saving ? "Saving..." : "Save IDs"}
          </button>
        </div>
      </div>
    </div>,
    document.body,
  );
}
