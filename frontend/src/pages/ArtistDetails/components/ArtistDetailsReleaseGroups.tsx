import ArtworkImage from "../../../components/ArtworkImage";
import { useEffect, useMemo, useState } from "react";
import { Music, RefreshCw } from "../../../components/icons";
import { ReleaseMetric } from "./ReleaseMetric";
import { DotLoader } from "../../../components/DotLoader";
import ReleaseStatusCheck from "./ReleaseStatusCheck";
import AddActionButton from "../../../components/AddActionButton";
import ReleaseWaitBadge from "../../../components/ReleaseWaitBadge";
import { useActiveDownloads } from "../../../hooks/useActiveDownloads";
import { getReleaseGroupLink } from "../../../utils/searchNavigation";
import {
  getPopularReleaseGroups,
  getReleaseGroupCoverUrl,
  getReleaseMetric,
  getReleaseYear,
  type LibraryReleaseGroup,
  type ReleaseGroup,
} from "../utils";
import type { ArtistDetailsResponse } from "../../../utils/api/endpoints/artists.ts";
import type { useArtistDetailsLibrary } from "../hooks/useArtistDetailsLibrary";
import { getAlbumAddAction } from "../../../utils/albumAddAction";
import { useResponsiveReleaseLimit } from "../hooks/useResponsiveReleaseLimit";
import Tooltip from "../../../components/Tooltip";
import RouteLink, { OptionalLink } from "../../../components/RouteLink";
import { artworkHoverTint } from "../../../utils/imageColors.ts";
import TooltipButton from "../../../components/TooltipButton";
import { albumPath } from "../../../../../lib/albumPath.ts";

const viewModes = [
  { value: "popular", label: "Popular releases" },
  { value: "albums", label: "Albums" },
  { value: "singles", label: "Singles & EPs" },
  { value: "compilations", label: "Compilations" },
  { value: "library", label: "In Library" },
] as const;

type ReleaseViewMode = (typeof viewModes)[number]["value"];

const isCompilation = (releaseGroup: ReleaseGroup | null | undefined) =>
  releaseGroup?.["primary-type"] === "Compilation" ||
  (releaseGroup?.["secondary-types"] || []).includes("Compilation");

const isSingleOrEp = (releaseGroup: ReleaseGroup | null | undefined) =>
  releaseGroup?.["primary-type"] === "Single" || releaseGroup?.["primary-type"] === "EP";

const sortLatest = <T extends ReleaseGroup>(items: T[]): T[] =>
  [...items].sort((a, b) =>
    String(b["first-release-date"] || "").localeCompare(String(a["first-release-date"] || "")),
  );

const getVisibleReleases = (
  releaseGroups: LibraryReleaseGroup[],
  libraryReleaseGroups: LibraryReleaseGroup[],
  viewMode: ReleaseViewMode,
  limit: number,
) => {
  if (viewMode === "library") return sortLatest(libraryReleaseGroups).slice(0, limit);
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
  libraryReleaseGroups,
  missingDownloadCount,
  reSearchingMissingAlbums,
  onReSearchMissingDownloads,
  canAddAlbum,
  handleRequestAlbum,
  requestingAlbum,
  artistName,
  onVisibleCoverIdsChange,
  viewAllLink,
}: {
  artist: Partial<ArtistDetailsResponse>;
  loadingReleases?: boolean;
  albumCovers: Record<string, string | undefined>;
  fulfilledCoverIds: ReadonlySet<unknown> | undefined;
  artistCoverImage: string | null | undefined;
  getAlbumStatus: ReturnType<typeof useArtistDetailsLibrary>["getAlbumStatus"];
  libraryReleaseGroups: LibraryReleaseGroup[];
  missingDownloadCount: number;
  reSearchingMissingAlbums: boolean;
  onReSearchMissingDownloads: (() => void) | null;
  canAddAlbum: boolean;
  handleRequestAlbum: ReturnType<typeof useArtistDetailsLibrary>["handleRequestAlbum"];
  requestingAlbum: string | null;
  artistName: string;
  onVisibleCoverIdsChange?: (ids: string[]) => void;
  viewAllLink: { to: string; state?: object };
}) {
  const { isAlbumDownloading } = useActiveDownloads();
  const [selectedViewMode, setViewMode] = useState<ReleaseViewMode>("popular");
  const [releaseGridRef, previewLimit] = useResponsiveReleaseLimit();
  const releaseGroups = useMemo(() => artist["release-groups"] || [], [artist]);
  const hasLibrary = libraryReleaseGroups.length > 0;
  const viewMode: ReleaseViewMode =
    selectedViewMode === "library" && !hasLibrary
      ? "popular"
      : hasLibrary && !loadingReleases && releaseGroups.length === 0
        ? "library"
        : selectedViewMode;
  const visibleReleaseGroups = useMemo(
    () => getVisibleReleases(releaseGroups, libraryReleaseGroups, viewMode, previewLimit),
    [libraryReleaseGroups, previewLimit, releaseGroups, viewMode],
  );

  useEffect(() => {
    onVisibleCoverIdsChange?.(
      visibleReleaseGroups.flatMap((item) => (item.id && !item.libraryAlbumId ? [item.id] : [])),
    );
  }, [onVisibleCoverIdsChange, visibleReleaseGroups]);

  const coverOptions = (releaseGroup: ReleaseGroup) => ({
    artistFallback: artistCoverImage,
    resolved: fulfilledCoverIds?.has(releaseGroup.id),
  });

  const releaseLink = (releaseGroup: ReleaseGroup, coverUrl: string) =>
    releaseGroup.libraryAlbumId
      ? { to: albumPath(releaseGroup.libraryAlbumId) }
      : getReleaseGroupLink(releaseGroup, {
          artistMbid: artist?.id,
          artistName: artistName || artist?.name || "",
          coverUrl,
        });

  if (releaseGroups.length === 0 && !hasLibrary && !loadingReleases) return null;

  return (
    <section className="artist-section">
      <div className="artist-heading-row">
        <div className="artist-min-0">
          <div className="artist-controls-row">
            <h2 className="artist-section-title">Discography</h2>
            {loadingReleases && <DotLoader size="sm" label={null} />}
            {viewMode === "library" &&
              onReSearchMissingDownloads &&
              (missingDownloadCount > 0 || reSearchingMissingAlbums) && (
                <TooltipButton
                  type="button"
                  onClick={onReSearchMissingDownloads}
                  className="btn btn-surface btn-icon-square"
                  aria-label="Re-search missing downloads"
                  title={`Re-search ${missingDownloadCount} missing download${
                    missingDownloadCount === 1 ? "" : "s"
                  }`}
                  disabled={reSearchingMissingAlbums}
                >
                  {reSearchingMissingAlbums ? (
                    <DotLoader size="sm" label={null} />
                  ) : (
                    <RefreshCw className="artist-icon-sm" />
                  )}
                </TooltipButton>
              )}
          </div>
          <div className="artist-tabs">
            {viewModes.map((mode) =>
              mode.value === "library" && !hasLibrary ? null : (
                <button
                  key={mode.value}
                  type="button"
                  onClick={() => setViewMode(mode.value)}
                  className={`artist-tab${viewMode === mode.value ? " is-active" : ""}`}
                >
                  {mode.label}
                  {mode.value === "library" && (
                    <span className="artist-tab__count">{libraryReleaseGroups.length}</span>
                  )}
                </button>
              ),
            )}
          </div>
        </div>
        <RouteLink
          to={viewMode === "library" ? `${viewAllLink.to}?tab=library` : viewAllLink.to}
          state={viewAllLink.state}
          className="section-show-all"
        >
          Show all
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
            <article
              key={releaseGroup.id}
              className="artist-release-card"
              data-artwork-scope
              {...artworkHoverTint}
            >
              <div className="artist-release-card__cover" data-artwork>
                {coverUrl ? (
                  <ArtworkImage src={coverUrl} alt="" loading="lazy" decoding="async" />
                ) : (
                  <div className="artist-release-card__placeholder">
                    <Music className="artist-icon-lg" />
                  </div>
                )}
                <div className="artist-release-card__action">
                  {status?.status === "available" || status?.status === "added" ? (
                    <ReleaseStatusCheck partial={status?.partial} />
                  ) : status?.status === "waiting" ? (
                    <ReleaseWaitBadge releaseDate={releaseGroup["first-release-date"]} />
                  ) : canAddAlbum ? (
                    <div>
                      <AddActionButton
                        {...getAlbumAddAction({
                          releaseDate: releaseGroup["first-release-date"],
                        })}
                        onAdd={() => handleRequestAlbum(releaseGroup.id, releaseGroup.title ?? "")}
                        isLoading={
                          requestingAlbum === releaseGroup.id || isAlbumDownloading(releaseGroup.id)
                        }
                        loadingLabel="Downloading"
                        disabled={
                          requestingAlbum === releaseGroup.id || isAlbumDownloading(releaseGroup.id)
                        }
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
                <Tooltip content={metric.title}>
                  <p className="artist-release-card__metric">
                    <ReleaseMetric metric={metric} />
                  </p>
                </Tooltip>
              )}
            </article>
          );
        })}
      </div>
    </section>
  );
}
