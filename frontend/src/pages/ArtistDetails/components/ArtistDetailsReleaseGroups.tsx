import { useMemo, useState } from "react";
import { RefreshCw } from "../../../components/icons";
import { DotLoader } from "../../../components/DotLoader";
import { useActiveDownloads } from "../../../hooks/useActiveDownloads";
import { getReleaseGroupLink } from "../../../utils/searchNavigation";
import {
  getPopularReleaseGroups,
  getReleaseGroupCoverUrl,
  type LibraryReleaseGroup,
  type ReleaseGroup,
} from "../utils";
import type { ArtistDetailsResponse } from "../../../utils/api/endpoints/artists.ts";
import type { ArtistDetailsLibrary } from "../hooks/useArtistDetailsLibrary";
import { useArtistReleaseShelf } from "../hooks/useResponsiveReleaseLimit";
import RouteLink from "../../../components/RouteLink";
import { albumPath } from "../../../../../lib/albumPath.ts";
import { matchesReleaseGroupTab } from "../releaseFilters.ts";
import { ArtistReleaseCard } from "./ArtistReleaseCard";

const viewModes = [
  { value: "popular", label: "Popular" },
  { value: "albums", label: "Albums" },
  { value: "singles", label: "Singles and EPs" },
  { value: "compilations", label: "Compilations" },
  { value: "library", label: "In Library" },
] as const;

type ReleaseViewMode = (typeof viewModes)[number]["value"];

const sortLatest = <T extends ReleaseGroup>(items: T[]): T[] =>
  [...items].sort((a, b) =>
    String(b["first-release-date"] || "").localeCompare(String(a["first-release-date"] || "")),
  );

const releasesForMode = (
  releaseGroups: LibraryReleaseGroup[],
  libraryReleaseGroups: LibraryReleaseGroup[],
  viewMode: ReleaseViewMode,
) => {
  if (viewMode === "library") return libraryReleaseGroups;
  if (viewMode === "popular") return releaseGroups;
  return releaseGroups.filter((releaseGroup) =>
    matchesReleaseGroupTab(releaseGroup, viewMode, true),
  );
};

export function ArtistDetailsReleaseGroups({
  artist,
  loadingReleases,
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
  viewAllLink,
}: {
  artist: Partial<ArtistDetailsResponse>;
  loadingReleases?: boolean;
  artistCoverImage: string | null | undefined;
  getAlbumStatus: ArtistDetailsLibrary["getAlbumStatus"];
  libraryReleaseGroups: LibraryReleaseGroup[];
  missingDownloadCount: number;
  reSearchingMissingAlbums: boolean;
  onReSearchMissingDownloads: (() => void) | null;
  canAddAlbum: boolean;
  handleRequestAlbum: ArtistDetailsLibrary["handleRequestAlbum"];
  requestingAlbum: string | null;
  artistName: string;
  viewAllLink: { to: string; state?: object };
}) {
  const { isAlbumDownloading } = useActiveDownloads();
  const [selectedViewMode, setViewMode] = useState<ReleaseViewMode>("popular");
  const [releaseGridRef, previewLimit] = useArtistReleaseShelf();
  const releaseGroups = useMemo(() => artist["release-groups"] || [], [artist]);
  const hasLibrary = libraryReleaseGroups.length > 0;
  const viewMode: ReleaseViewMode =
    selectedViewMode === "library" && !hasLibrary
      ? "popular"
      : hasLibrary && !loadingReleases && releaseGroups.length === 0
        ? "library"
        : selectedViewMode;
  const counts = useMemo(
    () =>
      Object.fromEntries(
        viewModes.map(({ value }) => [
          value,
          releasesForMode(releaseGroups, libraryReleaseGroups, value).length,
        ]),
      ) as Record<ReleaseViewMode, number>,
    [libraryReleaseGroups, releaseGroups],
  );
  const visibleReleaseGroups = useMemo(() => {
    const releases = releasesForMode(releaseGroups, libraryReleaseGroups, viewMode);
    return viewMode === "popular"
      ? getPopularReleaseGroups(releases, previewLimit)
      : sortLatest(releases).slice(0, previewLimit);
  }, [libraryReleaseGroups, previewLimit, releaseGroups, viewMode]);

  if (releaseGroups.length === 0 && !hasLibrary && !loadingReleases) return null;

  const showFindMissing =
    onReSearchMissingDownloads && (missingDownloadCount > 0 || reSearchingMissingAlbums);
  const missingLabel = `Find ${missingDownloadCount} missing album${missingDownloadCount === 1 ? "" : "s"}`;

  return (
    <section className="artist-section">
      <div className="artist-section-head">
        <h2 className="artist-section-title">
          Discography
          {loadingReleases && <DotLoader size="sm" label={null} />}
        </h2>
        <div className="artist-section-head__tools">
          {showFindMissing ? (
            <button
              type="button"
              className="btn btn-ghost btn-sm artist-find-missing"
              onClick={onReSearchMissingDownloads}
              disabled={reSearchingMissingAlbums}
              aria-label={missingLabel}
            >
              {reSearchingMissingAlbums ? (
                <DotLoader size="sm" label={null} />
              ) : (
                <RefreshCw aria-hidden="true" />
              )}
              <span className="artist-find-missing__long">{missingLabel}</span>
              <span className="artist-find-missing__short">Find missing</span>
            </button>
          ) : null}
          <RouteLink
            to={viewMode === "library" ? `${viewAllLink.to}?tab=library` : viewAllLink.to}
            state={viewAllLink.state}
            className="section-show-all"
          >
            Show all
          </RouteLink>
        </div>
      </div>

      <div className="artist-filters" role="group" aria-label="Release types">
        {viewModes.map((mode) =>
          mode.value !== "popular" && counts[mode.value] === 0 ? null : (
            <button
              key={mode.value}
              type="button"
              onClick={() => setViewMode(mode.value)}
              className="artist-filter"
              aria-pressed={viewMode === mode.value}
            >
              {mode.label}
              {mode.value === "popular" ? null : (
                <span className="artist-filter__count">{counts[mode.value]}</span>
              )}
            </button>
          ),
        )}
      </div>

      <div
        ref={releaseGridRef}
        className="artist-release-row"
        style={{ "--artist-release-columns": previewLimit }}
      >
        {visibleReleaseGroups.map((releaseGroup) => {
          const coverUrl = getReleaseGroupCoverUrl(releaseGroup);
          return (
            <ArtistReleaseCard
              key={releaseGroup.id}
              releaseGroup={releaseGroup}
              coverUrl={coverUrl}
              fallbackCoverUrl={artistCoverImage}
              link={
                releaseGroup.libraryAlbumId
                  ? { to: albumPath(releaseGroup.libraryAlbumId) }
                  : getReleaseGroupLink(releaseGroup, {
                      artistMbid: artist?.id,
                      artistName: artistName || artist?.name || "",
                      coverUrl: coverUrl || artistCoverImage || "",
                    })
              }
              detail={releaseGroup["primary-type"]}
              status={getAlbumStatus(releaseGroup.id)}
              busy={requestingAlbum === releaseGroup.id || isAlbumDownloading(releaseGroup.id)}
              onDownload={
                canAddAlbum
                  ? () => handleRequestAlbum(releaseGroup.id, releaseGroup.title ?? "")
                  : null
              }
            />
          );
        })}
      </div>
    </section>
  );
}
