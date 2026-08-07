import { useEffect, useMemo } from "react";
import { useDiscoverNavigation } from "../../../hooks/useDiscoverNavigation";
import { ArrowRight, Loader, Music, Star } from "lucide-react";
import SearchLibraryCheck from "../../../components/SearchLibraryCheck";
import AddActionButton from "../../../components/AddActionButton";
import { navigateToReleaseGroup } from "../../../utils/searchNavigation";
import { getReleaseGroupCoverUrl, getReleaseMetric, getReleaseYear } from "../utils";
import { getAlbumAddButtonLabel } from "../../../utils/albumAddAction";
import { useResponsiveReleaseLimit } from "../hooks/useResponsiveReleaseLimit";

const sortLatest = (items) =>
  [...items].sort((a, b) =>
    String(b["first-release-date"] || "").localeCompare(String(a["first-release-date"] || "")),
  );

export function ArtistDetailsAppearsOn({
  artist,
  loadingAppearsOn = false,
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
  const [releaseGridRef, previewLimit] = useResponsiveReleaseLimit();
  const releaseGroups = useMemo(() => artist["appears-on-release-groups"] || [], [artist]);
  const visibleReleaseGroups = useMemo(
    () => sortLatest(releaseGroups).slice(0, previewLimit),
    [previewLimit, releaseGroups],
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

  if (releaseGroups.length === 0 && !loadingAppearsOn) return null;

  return (
    <section className="artist-section">
      <div className="artist-heading-row">
        <div className="artist-min-0">
          <div className="artist-controls-row">
            <h2 className="artist-section-title">Appears On</h2>
            {loadingAppearsOn && <Loader className="artist-icon-sm animate-spin" />}
          </div>
        </div>
        {onViewAll ? (
          <button type="button" onClick={onViewAll} className="artist-link-button">
            View All
            <ArrowRight className="artist-icon-sm" />
          </button>
        ) : null}
      </div>

      <div ref={releaseGridRef} className="artist-release-grid">
        {visibleReleaseGroups.map((releaseGroup) => {
          const status = getAlbumStatus(releaseGroup.id);
          const metric = getReleaseMetric(releaseGroup);
          const artistCredit = releaseGroup["artist-credit"]?.[0]?.name || "";
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
                {[getReleaseYear(releaseGroup), artistCredit || releaseGroup["primary-type"]]
                  .filter(Boolean)
                  .join(" · ")}
              </p>
              {releaseGroup._appearsOnTrack && (
                <p className="artist-release-card__meta artist-truncate">
                  {releaseGroup._appearsOnTrack}
                </p>
              )}
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
