import { useEffect, useMemo, useState } from "react";
import { ArrowRight, Music, Star } from "lucide-react";
import { DotLoader } from "../../../components/DotLoader";
import SearchLibraryCheck from "../../../components/SearchLibraryCheck";
import AddActionButton from "../../../components/AddActionButton";
import { useActiveDownloads } from "../../../hooks/useActiveDownloads";
import { getReleaseGroupLink } from "../../../utils/searchNavigation";
import { getPopularReleaseGroups, getReleaseGroupCoverUrl, getReleaseMetric, getReleaseYear } from "../utils";
import { getAlbumAddAction } from "../../../utils/albumAddAction";
import { useResponsiveReleaseLimit } from "../hooks/useResponsiveReleaseLimit";
import Tooltip from "../../../components/Tooltip";
import RouteLink, { OptionalLink } from "../../../components/RouteLink";

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
  libraryDestination,
  requestingAlbum,
  artistName,
  onVisibleCoverIdsChange,
  viewAllLink,
}) {
  const { isAlbumDownloading } = useActiveDownloads();
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

  const releaseLink = (releaseGroup, coverUrl) =>
    getReleaseGroupLink(releaseGroup, {
      artistMbid: artist?.id,
      artistName: artistName || artist?.name || "",
      coverUrl,
    });

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
        <RouteLink to={viewAllLink.to} state={viewAllLink.state} className="artist-link-button">
          View All
          <ArrowRight className="artist-icon-sm" />
        </RouteLink>
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
            <article key={releaseGroup.id} className="artist-release-card">
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
                    <Tooltip content="Complete">
                      <span className="artist-release-card__status" >
                        <SearchLibraryCheck size="overlay" />
                        <span className="sr-only">Complete</span>
                      </span>
                    </Tooltip>
                  ) : canAddAlbum ? (
                    <div>
                      <AddActionButton
                        {...getAlbumAddAction(
                          { status: status?.status, managedBy: status?.albumInfo?.managedBy },
                          libraryDestination,
                        )}
                        ownerConflict={status?.ownerConflict}
                        onAdd={(managedBy) =>
                          handleRequestAlbum(releaseGroup.id, releaseGroup.title, managedBy)}
                        isLoading={requestingAlbum === releaseGroup.id || isAlbumDownloading(releaseGroup.id)}
                        loadingLabel="Downloading"
                        disabled={requestingAlbum === releaseGroup.id || isAlbumDownloading(releaseGroup.id)}
                      />
                    </div>
                  ) : null}
                </div>
              </div>
              <h3 className="artist-release-card__title artist-clamp-2">
                <OptionalLink link={releaseLink(releaseGroup, coverUrl)} className="card-link">
                  {releaseGroup.title}
                </OptionalLink>
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
          );
        })}
      </div>
    </section>
  );
}
