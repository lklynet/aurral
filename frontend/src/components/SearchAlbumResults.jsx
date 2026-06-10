import { Fragment, useCallback, useEffect, useMemo, useState } from "react";
import PropTypes from "prop-types";
import { CheckCircle, Music } from "lucide-react";
import AddAlbumButton from "./AddAlbumButton";
import { useToast } from "../contexts/ToastContext";
import {
  addSharedPlaylistTracks,
  createSharedPlaylist,
  getFlowStatus,
  getLibraryTracks,
  getReleaseGroupTracks,
} from "../utils/api";
import { ArtistDetailsReleaseTrackList } from "../pages/ArtistDetails/components/ArtistDetailsReleaseTrackList";

const normalizePlaylistNameKey = (value) =>
  String(value || "")
    .trim()
    .toLowerCase();

const reserveUniquePlaylistName = (playlists, baseName = "Playlist") => {
  const normalizedBase = String(baseName || "").trim() || "Playlist";
  const existing = new Set(
    (Array.isArray(playlists) ? playlists : [])
      .map((playlist) => normalizePlaylistNameKey(playlist?.name))
      .filter(Boolean),
  );
  if (!existing.has(normalizedBase.toLowerCase())) {
    return normalizedBase;
  }
  let index = 2;
  while (index < 10000) {
    const candidate = `${normalizedBase} ${index}`;
    if (!existing.has(candidate.toLowerCase())) {
      return candidate;
    }
    index += 1;
  }
  return `${normalizedBase} ${Date.now()}`;
};

function isAlbumActionDisabled(album, isPending, canAddAlbum) {
  if (!canAddAlbum) return true;
  return isPending || ["searching", "downloading", "processing"].includes(album.status);
}

function getReleaseYear(releaseDate) {
  const value = String(releaseDate || "").trim();
  if (!value) return null;
  return value.split("-")[0] || null;
}

function getReleaseTypeLabel(album) {
  const primary = album.primaryType || null;
  const secondary = Array.isArray(album.secondaryTypes)
    ? album.secondaryTypes.filter(Boolean)
    : [];
  const types = [primary, ...secondary].filter(Boolean);
  return types.length ? types.join(" · ") : null;
}

function toReleaseShape(album) {
  return {
    id: album.id,
    title: album.title,
    "primary-type": album.primaryType || null,
    "first-release-date": album.releaseDate || null,
  };
}

function getGridColumnCount() {
  if (typeof window === "undefined") return 2;
  if (window.matchMedia("(min-width: 1280px)").matches) return 6;
  if (window.matchMedia("(min-width: 1024px)").matches) return 6;
  if (window.matchMedia("(min-width: 640px)").matches) return 3;
  return 2;
}

function AlbumCover({ src, alt }) {
  const [failed, setFailed] = useState(false);

  if (!src || failed) {
    return (
      <div className="artist-release-card__placeholder">
        <Music className="artist-icon-lg" />
      </div>
    );
  }

  return (
    <img
      src={src}
      alt={alt}
      loading="lazy"
      decoding="async"
      onError={() => setFailed(true)}
    />
  );
}

function AlbumAction({ album, isPending, canAddAlbum, onAlbumAction }) {
  const actionDisabled = isAlbumActionDisabled(album, isPending, canAddAlbum);
  const isComplete = album.status === "available";
  const actionLabel =
    album.status === "inLibrary" ? "Search Album" : "Add to Lidarr";

  if (isComplete) {
    return (
      <span className="artist-release-card__status" title="In Library">
        <CheckCircle className="artist-icon-sm" />
        <span className="sr-only">In Library</span>
      </span>
    );
  }

  if (!canAddAlbum) return null;

  return (
    <AddAlbumButton
      onClick={(event) => {
        event.stopPropagation();
        onAlbumAction(album);
      }}
      isLoading={isPending}
      disabled={actionDisabled}
      label={actionLabel}
    />
  );
}

function SearchAlbumResults({
  albums,
  albumCovers,
  canAddAlbum,
  pendingAlbumIds,
  onAlbumAction,
  navigate,
  viewMode = "grid",
}) {
  const { showError, showSuccess } = useToast();
  const [expandedAlbumId, setExpandedAlbumId] = useState(null);
  const [albumTracks, setAlbumTracks] = useState({});
  const [loadingTracks, setLoadingTracks] = useState({});
  const [gridColumnCount, setGridColumnCount] = useState(getGridColumnCount);
  const [sharedPlaylists, setSharedPlaylists] = useState([]);
  const [playlistModalLoading, setPlaylistModalLoading] = useState(false);
  const [playlistModalError, setPlaylistModalError] = useState("");
  const [playlistMenuSavingKey, setPlaylistMenuSavingKey] = useState("");

  useEffect(() => {
    const updateGridColumnCount = () => setGridColumnCount(getGridColumnCount());
    updateGridColumnCount();
    window.addEventListener("resize", updateGridColumnCount);
    return () => window.removeEventListener("resize", updateGridColumnCount);
  }, []);

  useEffect(() => {
    setExpandedAlbumId(null);
  }, [albums]);

  const openArtist = useCallback(
    (album, event) => {
      event?.stopPropagation();
      if (!album.artistMbid) return;
      navigate(`/artist/${album.artistMbid}`, {
        state: { artistName: album.artistName },
      });
    },
    [navigate],
  );

  const handleAlbumClick = useCallback(
    async (album) => {
      const albumId = album?.id;
      if (!albumId) return;

      if (expandedAlbumId === albumId) {
        setExpandedAlbumId(null);
        return;
      }

      setExpandedAlbumId(albumId);
      const trackKey = album.libraryAlbumId || albumId;

      if (albumTracks[trackKey]) return;

      setLoadingTracks((prev) => ({ ...prev, [trackKey]: true }));
      try {
        const tracks = album.libraryAlbumId
          ? await getLibraryTracks(album.libraryAlbumId, albumId, {
              artistName: album.artistName || "",
              albumTitle: album.title || "",
              releaseType: album.primaryType || "",
              releaseDate: album.releaseDate || "",
            })
          : await getReleaseGroupTracks(albumId, {
              artistMbid: album.artistMbid || "",
              artistName: album.artistName || "",
              albumTitle: album.title || "",
              releaseType: album.primaryType || "",
              releaseDate: album.releaseDate || "",
            });
        setAlbumTracks((prev) => ({ ...prev, [trackKey]: tracks }));
      } catch (err) {
        console.error("Failed to fetch tracks:", err);
        showError("Failed to fetch track list");
      } finally {
        setLoadingTracks((prev) => ({ ...prev, [trackKey]: false }));
      }
    },
    [albumTracks, expandedAlbumId, showError],
  );

  const expandedAlbum = useMemo(
    () => albums.find((album) => album.id === expandedAlbumId) || null,
    [albums, expandedAlbumId],
  );

  const loadSharedPlaylists = useCallback(async () => {
    setPlaylistModalLoading(true);
    try {
      const data = await getFlowStatus();
      const playlists = Array.isArray(data?.sharedPlaylists)
        ? data.sharedPlaylists
        : [];
      setSharedPlaylists(playlists);
      return playlists;
    } catch (err) {
      const message =
        err.response?.data?.message ||
        err.response?.data?.error ||
        err.message ||
        "Failed to load playlists";
      setPlaylistModalError(message);
      showError(message);
      return null;
    } finally {
      setPlaylistModalLoading(false);
    }
  }, [showError]);

  const getDefaultTrackPlaylistName = useCallback(
    (track) =>
      reserveUniquePlaylistName(
        sharedPlaylists,
        `${expandedAlbum?.artistName || track?.artistName || "Artist"} Picks`,
      ),
    [expandedAlbum?.artistName, sharedPlaylists],
  );

  const saveTrackToPlaylist = useCallback(
    async (trackPayload, target, savingKey) => {
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
            reserveUniquePlaylistName(
              sharedPlaylists,
              `${trackPayload.artistName} Picks`,
            );
          const response = await createSharedPlaylist({
            name,
            tracks: [trackPayload],
          });
          showSuccess(`Track saved to ${response?.playlist?.name || name}`);
        } else {
          const targetPlaylist = sharedPlaylists.find(
            (playlist) => playlist.id === target?.playlistId,
          );
          await addSharedPlaylistTracks(target.playlistId, {
            tracks: [trackPayload],
          });
          showSuccess(`Track added to ${targetPlaylist?.name || "playlist"}`);
        }
        const nextPlaylists = await loadSharedPlaylists();
        if (nextPlaylists) {
          setSharedPlaylists(nextPlaylists);
        }
      } catch (err) {
        const message =
          err.response?.data?.message ||
          err.response?.data?.error ||
          err.message ||
          "Failed to save track to playlist";
        setPlaylistModalError(message);
        showError(message);
      } finally {
        setPlaylistMenuSavingKey("");
      }
    },
    [loadSharedPlaylists, sharedPlaylists, showError, showSuccess],
  );

  const handleReleaseTrackAdd = useCallback(
    (track, release, target) => {
      const album = expandedAlbum;
      const year = String(release?.["first-release-date"] || "").slice(0, 4);
      const payload = {
        artistName: album?.artistName || "",
        trackName: track?.trackName || track?.title || "",
        albumName: release?.title || album?.title || "",
        artistMbid: album?.artistMbid || "",
        albumMbid: release?.id || album?.id || "",
        trackMbid: track?.mbid || track?.id || "",
        releaseYear: year || null,
        durationMs:
          track?.length != null && Number.isFinite(Number(track.length))
            ? Number(track.length)
            : null,
        reason: null,
        artistAliases: [],
      };
      const savingKey = String(track?.id ?? track?.mbid ?? "");
      return saveTrackToPlaylist(payload, target, savingKey);
    },
    [expandedAlbum, saveTrackToPlaylist],
  );

  const expandedTrackKey = expandedAlbum?.libraryAlbumId || expandedAlbum?.id;
  const expandedTracks = expandedTrackKey ? albumTracks[expandedTrackKey] : null;
  const expandedLoading = expandedTrackKey
    ? !!loadingTracks[expandedTrackKey]
    : false;

  const expandedAlbumIndex = expandedAlbum
    ? albums.findIndex((album) => album.id === expandedAlbum.id)
    : -1;

  const expandedRenderAfterIndex =
    expandedAlbumIndex < 0
      ? -1
      : viewMode === "grid"
        ? Math.min(
            expandedAlbumIndex +
              (gridColumnCount - 1 - (expandedAlbumIndex % gridColumnCount)),
            albums.length - 1,
          )
        : expandedAlbumIndex;

  const renderAlbum = (album) => {
    const isPending = !!pendingAlbumIds[album.id];
    const coverSrc = albumCovers[album.id] || album.coverUrl;
    const releaseYear = getReleaseYear(album.releaseDate);
    const releaseTypeLabel = getReleaseTypeLabel(album);
    const releaseMeta = [releaseYear, releaseTypeLabel]
      .filter(Boolean)
      .join(" · ");
    if (viewMode === "list") {
      return (
        <div
          className="artist-release-list-item"
          onClick={() => handleAlbumClick(album)}
        >
          <div className="artist-media-cell artist-list-cover">
            {coverSrc ? (
              <img src={coverSrc} alt={album.title} loading="lazy" decoding="async" />
            ) : (
              <div className="artist-media-placeholder">
                <Music className="artist-icon-md" />
              </div>
            )}
          </div>
          <div className="artist-min-0">
            <h2 className="artist-release-card__title artist-truncate">
              {album.title}
            </h2>
            <div className="artist-release-card__meta artist-truncate">
              {album.artistName ? (
                <button
                  type="button"
                  className="artist-link-button"
                  onClick={(event) => openArtist(album, event)}
                >
                  {album.artistName}
                </button>
              ) : null}
              {album.artistName && releaseMeta ? " · " : null}
              {releaseMeta ? <span>{releaseMeta}</span> : null}
            </div>
          </div>
          <div
            className="artist-row-actions"
            onClick={(event) => event.stopPropagation()}
          >
            <AlbumAction
              album={album}
              isPending={isPending}
              canAddAlbum={canAddAlbum}
              onAlbumAction={onAlbumAction}
            />
          </div>
        </div>
      );
    }

    return (
      <article
        className="artist-release-card"
        onClick={() => handleAlbumClick(album)}
      >
        <div className="artist-release-card__cover">
          {coverSrc ? (
            <AlbumCover src={coverSrc} alt={album.title} />
          ) : (
            <div className="artist-release-card__placeholder">
              <Music className="artist-icon-lg" />
            </div>
          )}
          <div
            className="artist-release-card__action"
            onClick={(event) => event.stopPropagation()}
          >
            <AlbumAction
              album={album}
              isPending={isPending}
              canAddAlbum={canAddAlbum}
              onAlbumAction={onAlbumAction}
            />
          </div>
        </div>
        <h2 className="artist-release-card__title artist-clamp-2">
          {album.title}
        </h2>
        {album.artistName ? (
          <button
            type="button"
            className="artist-card-button"
            onClick={(event) => openArtist(album, event)}
          >
            <p className="artist-release-card__meta artist-truncate">
              {album.artistName}
            </p>
          </button>
        ) : null}
        {releaseMeta && (
          <p className="artist-release-card__meta artist-truncate">
            {releaseMeta}
          </p>
        )}
      </article>
    );
  };

  return (
    <div
      className={
        viewMode === "grid" ? "artist-albums-grid" : "artist-release-list"
      }
    >
      {albums.map((album, index) => (
        <Fragment key={album.id}>
          {renderAlbum(album)}
          {expandedAlbum && expandedRenderAfterIndex === index && (
            <div className={viewMode === "grid" ? "artist-grid-full" : ""}>
              <ArtistDetailsReleaseTrackList
                release={toReleaseShape(expandedAlbum)}
                trackKey={expandedTrackKey}
                tracks={expandedTracks}
                loading={expandedLoading}
                playbackSource={{
                  type: "search",
                  id: expandedAlbum?.id,
                  label: expandedAlbum?.title || "Search",
                }}
                artistName={expandedAlbum?.artistName || ""}
                onAddTrackToPlaylist={handleReleaseTrackAdd}
                playlists={sharedPlaylists}
                playlistsLoading={playlistModalLoading}
                playlistSavingKey={playlistMenuSavingKey}
                playlistError={playlistModalError}
                getDefaultPlaylistName={getDefaultTrackPlaylistName}
                onLoadPlaylists={loadSharedPlaylists}
              />
            </div>
          )}
        </Fragment>
      ))}
    </div>
  );
}

SearchAlbumResults.propTypes = {
  albums: PropTypes.arrayOf(PropTypes.object).isRequired,
  albumCovers: PropTypes.object.isRequired,
  canAddAlbum: PropTypes.bool.isRequired,
  pendingAlbumIds: PropTypes.object.isRequired,
  onAlbumAction: PropTypes.func.isRequired,
  navigate: PropTypes.func.isRequired,
  viewMode: PropTypes.oneOf(["grid", "list"]),
};

AlbumCover.propTypes = {
  src: PropTypes.string,
  alt: PropTypes.string,
};

AlbumAction.propTypes = {
  album: PropTypes.object.isRequired,
  isPending: PropTypes.bool.isRequired,
  canAddAlbum: PropTypes.bool.isRequired,
  onAlbumAction: PropTypes.func.isRequired,
};

export default SearchAlbumResults;
