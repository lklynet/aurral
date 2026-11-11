import { useMemo } from "react";
import { DotLoader } from "../../../components/DotLoader";
import { useActiveDownloads } from "../../../hooks/useActiveDownloads";
import { getReleaseGroupLink } from "../../../utils/searchNavigation";
import { getReleaseGroupCoverUrl, getReleaseYear, type ReleaseGroup } from "../utils";
import type { ArtistDetailsResponse } from "../../../utils/api/endpoints/artists.ts";
import type { ArtistDetailsLibrary } from "../hooks/useArtistDetailsLibrary";
import { useArtistReleaseShelf } from "../hooks/useResponsiveReleaseLimit";
import RouteLink from "../../../components/RouteLink";
import { ArtistReleaseCard } from "./ArtistReleaseCard";

const sortLatest = <T extends ReleaseGroup>(items: T[]): T[] =>
  [...items].sort((a, b) =>
    String(b["first-release-date"] || "").localeCompare(String(a["first-release-date"] || "")),
  );

export function ArtistDetailsAppearsOn({
  artist,
  loadingAppearsOn = false,
  artistCoverImage,
  getAlbumStatus,
  canAddAlbum,
  handleRequestAlbum,
  requestingAlbum,
  artistName,
  viewAllLink,
}: {
  artist: Partial<ArtistDetailsResponse>;
  loadingAppearsOn?: boolean;
  artistCoverImage: string | null | undefined;
  getAlbumStatus: ArtistDetailsLibrary["getAlbumStatus"];
  canAddAlbum: boolean;
  handleRequestAlbum: ArtistDetailsLibrary["handleRequestAlbum"];
  requestingAlbum: string | null;
  artistName: string;
  viewAllLink?: { to: string; state?: object } | null;
}) {
  const { isAlbumDownloading } = useActiveDownloads();
  const [releaseGridRef, previewLimit] = useArtistReleaseShelf();
  const releaseGroups = useMemo(() => artist["appears-on-release-groups"] || [], [artist]);
  const visibleReleaseGroups = useMemo(
    () => sortLatest(releaseGroups).slice(0, previewLimit),
    [previewLimit, releaseGroups],
  );

  if (releaseGroups.length === 0 && !loadingAppearsOn) return null;

  return (
    <section className="artist-section">
      <div className="artist-section-head">
        <h2 className="artist-section-title">
          Appears on
          {loadingAppearsOn && <DotLoader size="sm" label={null} />}
        </h2>
        {viewAllLink ? (
          <RouteLink to={viewAllLink.to} state={viewAllLink.state} className="section-show-all">
            Show all
          </RouteLink>
        ) : null}
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
              link={getReleaseGroupLink(releaseGroup, {
                artistMbid: artist?.id,
                artistName: artistName || artist?.name || "",
                coverUrl: coverUrl || artistCoverImage || "",
              })}
              meta={[
                getReleaseYear(releaseGroup),
                releaseGroup["artist-credit"]?.[0]?.name || releaseGroup["primary-type"],
              ]
                .filter(Boolean)
                .join(" · ")}
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
