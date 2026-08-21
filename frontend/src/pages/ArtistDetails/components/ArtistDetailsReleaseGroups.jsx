import { useEffect, useMemo, useState } from "react";
import { useDiscoverNavigation } from "../../../hooks/useDiscoverNavigation";
import { ArrowRight, Music, Star } from "lucide-react";
import { DotLoader } from "../../../components/DotLoader";
import SearchLibraryCheck from "../../../components/SearchLibraryCheck";
import AddActionButton from "../../../components/AddActionButton";
import { navigateToReleaseGroup } from "../../../utils/searchNavigation";
import { getPopularReleaseGroups, getReleaseGroupCoverUrl, getReleaseMetric, getReleaseYear } from "../utils";
import { getAlbumAddButtonLabel } from "../../../utils/albumAddAction";
import { useResponsiveReleaseLimit } from "../hooks/useResponsiveReleaseLimit";

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
  releaseGroup?.["primary-type"] === "Single" || releaseGroup?.["primary-type"] === "EP";

const sortLatest = (items) =>
  [...items].sort((a, b) =>
    String(b["first-release-date"] || "").localeCompare(String(a["first-release-date"] || "")),
  );

const getVisibleReleases = (releaseGroups, viewMode, limit) => {
  if (viewMode === "popular") {
    return getPopularReleaseGroups(releaseGroups, limit);
  }
  if (viewMode === "albums") {
    return sortLatest(
      releaseGroups.filter(
        (releaseGroup) =>
          releaseGroup?.["primary-type"] === "Album" && !isCompilation(releaseGroup),
      ),
    ).slice(0, limit);
  }
  if (viewMode === "singles") {
    return sortLatest(
      releaseGroups.filter(
        (releaseGroup) => isSingleOrEp(releaseGroup) && !isCompilation(releaseGroup),
      ),
    ).slice(0, limit);
  }
  return sortLatest(releaseGroups.filter(isCompilation)).slice(0, limit);
};

export function ArtistDetailsReleaseGroups({
  artist,
  loadingReleases,
  albumCovers,
  fulfilledCoverIds,
  artistCoverImage,
  getAlbumStatus,
  canAddAlbum,
  handleRequestAlbum,
  requestingAlbum,
  artistName,
  onVisibleCoverIdsChange,
  onViewAll,
}) {
  const navigate = useDiscoverNavigation();
  const [viewMode, setViewMode] = useState("popular");
  const [releaseGridRef, previewLimit] = useResponsiveReleaseLimit();
  const releaseGroups = useMemo(() => artist["release-groups"] || [], [artist]);
  const visibleReleaseGroups = useMemo(
    () => getVisibleReleases(releaseGroups, viewMode, previewLimit),
    [previewLimit, releaseGroups, viewMode],
  );

  useEffect(() => {
    onVisibleCoverIdsChange?.(visibleReleaseGroups.map((item) => item.id).filter(Boolean));
  }, [onVisibleCoverIdsChange, visibleReleaseGroups]);

  const coverOptions = (releaseGroup) => ({
    artistFallback: artistCoverImage,
    resolved: fulfilledCoverIds?.has(releaseGroup.id),
  });

  const openRelease = (releaseGroup) => {
    navigateToReleaseGroup(navigate, releaseGroup, {
      artistMbid: artist?.id,
      artistName: artistName || artist?.name || "",
      coverUrl: getReleaseGroupCoverUrl(releaseGroup, albumCovers, coverOptions(releaseGroup)),
    });
  };

  if (releaseGroups.length === 0 && !loadingReleases) return null;

  return (
    <section className="artist-section">
      <div className="artist-heading-row">
        <div className="artist-min-0">
          <div className="artist-controls-row">
            <h2 className="artist-section-title">Discography</h2>
            {loadingReleases && <DotLoader size="sm" label={null} />}
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
        <button type="button" onClick={onViewAll} className="artist-link-button">
          View All
          <ArrowRight className="artist-icon-sm" />
        </button>
      </div>

      <div ref={releaseGridRef} className="artist-release-grid">
        {visibleReleaseGroups.map((releaseGroup) => {
          const status = getAlbumStatus(releaseGroup.id);
          const metric = getReleaseMetric(releaseGroup);
          const coverUrl = getReleaseGroupCoverUrl(
            releaseGroup,
            albumCovers,
            coverOptions(releaseGroup),
          );
          return (
            <article
              key={releaseGroup.id}
              className="artist-release-card"
              onClick={() => openRelease(releaseGroup)}
            >
              <div className="artist-release-card__cover">
                {coverUrl ? (
                  <img src={coverUrl} alt="" loading="lazy" decoding="async" />
                ) : (
                  <div className="artist-release-card__placeholder">
                    <Music className="artist-icon-lg" />
                  </div>
                )}
                <div className="artist-release-card__action">
                  {status?.status === "available" || status?.status === "added" ? (
                    <span className="artist-release-card__status" title="Complete">
                      <SearchLibraryCheck size="overlay" />
                      <span className="sr-only">Complete</span>
                    </span>
                  ) : canAddAlbum ? (
                    <div onClick={(event) => event.stopPropagation()}>
                      <AddActionButton
                        onClick={(event) => {
                          event.stopPropagation();
                          handleRequestAlbum(releaseGroup.id, releaseGroup.title);
                        }}
                        isLoading={requestingAlbum === releaseGroup.id}
                        disabled={requestingAlbum === releaseGroup.id}
                        label={getAlbumAddButtonLabel({ status: status?.status })}
                      />
                    </div>
                  ) : null}
                </div>
              </div>
              <h3 className="artist-release-card__title artist-clamp-2">{releaseGroup.title}</h3>
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
          );
        })}
      </div>
    </section>
  );
}
