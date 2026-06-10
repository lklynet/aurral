import { Fragment, useEffect, useMemo, useState } from "react";
import PropTypes from "prop-types";
import {
  ArrowRight,
  CheckCircle,
  Loader,
  Music,
  Star,
} from "lucide-react";
import AddAlbumButton from "../../../components/AddAlbumButton";
import {
  getArtistReleaseGridColumnCount,
  getExpandedReleaseRenderAfterIndex,
  getReleaseMetric,
  getReleaseYear,
} from "../utils";
import { ArtistDetailsReleaseTrackList } from "./ArtistDetailsReleaseTrackList";

const viewModes = [
  { value: "popular", label: "Popular Releases" },
  { value: "albums", label: "Albums" },
  { value: "singles", label: "Singles & EPs" },
  { value: "compilations", label: "Compilations" },
];

const isCompilation = (releaseGroup) =>
  releaseGroup?.["primary-type"] === "Compilation" ||
  (releaseGroup?.["secondary-types"] || []).includes("Compilation");

const isSingleOrEp = (releaseGroup) =>
  releaseGroup?.["primary-type"] === "Single" ||
  releaseGroup?.["primary-type"] === "EP";

const sortLatest = (items) =>
  [...items].sort((a, b) =>
    String(b["first-release-date"] || "").localeCompare(
      String(a["first-release-date"] || ""),
    ),
  );

const getVisibleReleases = (releaseGroups, viewMode) => {
  if (viewMode === "popular") {
    return [...releaseGroups]
      .sort((a, b) => getReleaseMetric(b).sortValue - getReleaseMetric(a).sortValue)
      .slice(0, 6);
  }
  if (viewMode === "albums") {
    return sortLatest(
      releaseGroups.filter(
        (releaseGroup) =>
          releaseGroup?.["primary-type"] === "Album" &&
          !isCompilation(releaseGroup),
      ),
    ).slice(0, 6);
  }
  if (viewMode === "singles") {
    return sortLatest(
      releaseGroups.filter(
        (releaseGroup) => isSingleOrEp(releaseGroup) && !isCompilation(releaseGroup),
      ),
    ).slice(0, 6);
  }
  return sortLatest(releaseGroups.filter(isCompilation)).slice(0, 6);
};

export function ArtistDetailsReleaseGroups({
  artist,
  loadingReleases,
  albumCovers,
  artistCoverImage,
  expandedReleaseGroup,
  albumTracks,
  loadingTracks,
  getAlbumStatus,
  handleReleaseGroupAlbumClick,
  canAddAlbum,
  handleRequestAlbum,
  requestingAlbum,
  playbackSource,
  artistName,
  onAddTrackToPlaylist,
  playlists,
  playlistsLoading,
  playlistSavingKey,
  playlistError,
  getDefaultPlaylistName,
  onLoadPlaylists,
  onVisibleCoverIdsChange,
  onViewAll,
}) {
  const [viewMode, setViewMode] = useState("popular");
  const [gridColumnCount, setGridColumnCount] = useState(
    getArtistReleaseGridColumnCount,
  );
  const releaseGroups = useMemo(
    () => artist["release-groups"] || [],
    [artist],
  );
  const visibleReleaseGroups = useMemo(
    () => getVisibleReleases(releaseGroups, viewMode),
    [releaseGroups, viewMode],
  );

  useEffect(() => {
    onVisibleCoverIdsChange?.(visibleReleaseGroups.map((item) => item.id).filter(Boolean));
  }, [onVisibleCoverIdsChange, visibleReleaseGroups]);

  useEffect(() => {
    const updateGridColumnCount = () =>
      setGridColumnCount(getArtistReleaseGridColumnCount());
    updateGridColumnCount();
    window.addEventListener("resize", updateGridColumnCount);
    return () => window.removeEventListener("resize", updateGridColumnCount);
  }, []);

  const expandedRelease = visibleReleaseGroups.find(
    (releaseGroup) => releaseGroup.id === expandedReleaseGroup,
  );
  const expandedStatus = expandedRelease ? getAlbumStatus(expandedRelease.id) : null;
  const expandedTrackKey = expandedStatus?.libraryId || expandedRelease?.id;
  const expandedTracks = expandedTrackKey ? albumTracks[expandedTrackKey] : null;
  const expandedLoading = expandedTrackKey ? loadingTracks[expandedTrackKey] : false;
  const expandedReleaseIndex = expandedRelease
    ? visibleReleaseGroups.findIndex(
        (releaseGroup) => releaseGroup.id === expandedRelease.id,
      )
    : -1;
  const expandedRenderAfterIndex = getExpandedReleaseRenderAfterIndex(
    expandedReleaseIndex,
    visibleReleaseGroups.length,
    gridColumnCount,
  );

  if (releaseGroups.length === 0) return null;

  return (
    <section className="artist-section">
      <div className="artist-heading-row">
        <div className="artist-min-0">
          <div className="artist-controls-row">
            <h2 className="artist-section-title">Discography</h2>
            {loadingReleases && <Loader className="artist-icon-sm animate-spin" />}
          </div>
          <div className="artist-tabs">
            {viewModes.map((mode) => (
              <button
                key={mode.value}
                type="button"
                onClick={() => setViewMode(mode.value)}
                className={`artist-tab${viewMode === mode.value ? " is-active" : ""}`}
              >
                {mode.label}
              </button>
            ))}
          </div>
        </div>
        <button
          type="button"
          onClick={onViewAll}
          className="artist-link-button"
        >
          View All
          <ArrowRight className="artist-icon-sm" />
        </button>
      </div>

      <div className="artist-release-grid">
        {visibleReleaseGroups.map((releaseGroup, index) => {
          const status = getAlbumStatus(releaseGroup.id);
          const metric = getReleaseMetric(releaseGroup);
          return (
            <Fragment key={releaseGroup.id}>
            <article
              className="artist-release-card"
              onClick={() => handleReleaseGroupAlbumClick(releaseGroup, status?.libraryId)}
            >
              <div className="artist-release-card__cover">
                {albumCovers[releaseGroup.id] || artistCoverImage ? (
                  <img
                    src={albumCovers[releaseGroup.id] || artistCoverImage}
                    alt=""
                    loading="lazy"
                    decoding="async"
                  />
                ) : (
                  <div className="artist-release-card__placeholder">
                    <Music className="artist-icon-lg" />
                  </div>
                )}
                <div className="artist-release-card__action">
                  {status?.status === "available" || status?.status === "added" ? (
                    <span
                      className="artist-release-card__status"
                      title="Complete"
                    >
                      <CheckCircle className="artist-icon-sm" />
                      <span className="sr-only">Complete</span>
                    </span>
                  ) : canAddAlbum ? (
                    <div onClick={(event) => event.stopPropagation()}>
                      <AddAlbumButton
                        onClick={(event) => {
                          event.stopPropagation();
                          handleRequestAlbum(releaseGroup.id, releaseGroup.title);
                        }}
                        isLoading={requestingAlbum === releaseGroup.id}
                        disabled={requestingAlbum === releaseGroup.id}
                      />
                    </div>
                  ) : null}
                </div>
              </div>
              <h3 className="artist-release-card__title artist-clamp-2">
                {releaseGroup.title}
              </h3>
              <p className="artist-release-card__meta artist-truncate">
                {[getReleaseYear(releaseGroup), releaseGroup["primary-type"]]
                  .filter(Boolean)
                  .join(" · ")}
              </p>
              {metric.label && (
                <p className="artist-release-card__metric">
                  <Star className="artist-star-icon" />
                  {metric.label}
                </p>
              )}
            </article>
            {expandedRelease && expandedRenderAfterIndex === index ? (
              <div className="artist-grid-full">
                <ArtistDetailsReleaseTrackList
                  release={expandedRelease}
                  trackKey={expandedTrackKey}
                  tracks={expandedTracks}
                  loading={expandedLoading}
                  playbackSource={playbackSource}
                  artistName={artistName}
                  onAddTrackToPlaylist={onAddTrackToPlaylist}
                  playlists={playlists}
                  playlistsLoading={playlistsLoading}
                  playlistSavingKey={playlistSavingKey}
                  playlistError={playlistError}
                  getDefaultPlaylistName={getDefaultPlaylistName}
                  onLoadPlaylists={onLoadPlaylists}
                />
              </div>
            ) : null}
            </Fragment>
          );
        })}
      </div>
    </section>
  );
}

ArtistDetailsReleaseGroups.propTypes = {
  artist: PropTypes.object.isRequired,
  loadingReleases: PropTypes.bool,
  albumCovers: PropTypes.object,
  artistCoverImage: PropTypes.string,
  expandedReleaseGroup: PropTypes.string,
  albumTracks: PropTypes.object,
  loadingTracks: PropTypes.object,
  getAlbumStatus: PropTypes.func.isRequired,
  handleReleaseGroupAlbumClick: PropTypes.func.isRequired,
  canAddAlbum: PropTypes.bool,
  handleRequestAlbum: PropTypes.func.isRequired,
  requestingAlbum: PropTypes.oneOfType([PropTypes.string, PropTypes.number]),
  playbackSource: PropTypes.shape({
    type: PropTypes.string,
    id: PropTypes.oneOfType([PropTypes.string, PropTypes.number]),
    label: PropTypes.string,
  }),
  artistName: PropTypes.string,
  onAddTrackToPlaylist: PropTypes.func,
  playlists: PropTypes.array,
  playlistsLoading: PropTypes.bool,
  playlistSavingKey: PropTypes.string,
  playlistError: PropTypes.string,
  getDefaultPlaylistName: PropTypes.func,
  onLoadPlaylists: PropTypes.func,
  onVisibleCoverIdsChange: PropTypes.func,
  onViewAll: PropTypes.func.isRequired,
};
