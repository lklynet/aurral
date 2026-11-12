import type { ComponentProps, ReactNode } from "react";
import { ReleaseCoverImage } from "../../../components/ReleaseCoverImage";
import AddActionButton from "../../../components/AddActionButton";
import SearchLibraryCheck from "../../../components/SearchLibraryCheck";
import Tooltip from "../../../components/Tooltip";
import { OptionalLink } from "../../../components/RouteLink";
import { Clock, Music } from "../../../components/icons";
import { getAlbumAddAction } from "../../../utils/albumAddAction";
import type { ArtistDetailsLibrary } from "../hooks/useArtistDetailsLibrary.ts";
import { getReleaseYear, isNewReleaseGroup } from "../utils";
import type { ReleaseGroup, ReleaseMetricValue } from "../utils";
import { ReleaseMetric } from "./ReleaseMetric";

type AlbumStatus = ReturnType<ArtistDetailsLibrary["getAlbumStatus"]>;

export function ReleaseMeta({
  releaseGroup,
  detail,
}: {
  releaseGroup: ReleaseGroup;
  detail: string | null | undefined;
}) {
  const lead = isNewReleaseGroup(releaseGroup) ? (
    <span className="artist-release-new">New</span>
  ) : (
    getReleaseYear(releaseGroup)
  );
  return (
    <>
      {lead}
      {lead && detail ? " · " : null}
      {detail}
    </>
  );
}

function ReleaseStatusLine({
  status,
  busy,
  meta,
}: {
  status: AlbumStatus;
  busy: boolean;
  meta: ReactNode;
}) {
  if (busy) return <p className="artist-release-tile__meta is-busy">Downloading</p>;
  if (status?.status === "available" && status.partial) {
    const { trackCount = 0, trackFileCount = 0 } = status;
    return (
      <p className="artist-release-tile__meta">
        <SearchLibraryCheck size="sm" className="library-check--partial" aria-hidden="true" />
        <span className="is-partial">
          {trackCount > 0 ? `${trackFileCount} of ${trackCount} tracks` : "Incomplete"}
        </span>
      </p>
    );
  }
  if (status?.status === "available") {
    return (
      <p className="artist-release-tile__meta">
        <SearchLibraryCheck size="sm" />
        {meta}
      </p>
    );
  }
  if (status?.status === "waiting") {
    return (
      <p className="artist-release-tile__meta">
        <Clock className="is-scheduled" aria-hidden="true" />
        <span className="is-scheduled">{status.label}</span>
      </p>
    );
  }
  return <p className="artist-release-tile__meta">{meta}</p>;
}

export function ArtistReleaseCard({
  releaseGroup,
  coverUrl,
  fallbackCoverUrl = null,
  link,
  detail,
  status,
  busy,
  onDownload,
  metric = null,
  headingLevel: Heading = "h3",
}: {
  releaseGroup: ReleaseGroup;
  coverUrl: string | null | undefined;
  fallbackCoverUrl?: string | null;
  link: ComponentProps<typeof OptionalLink>["link"];
  detail: string | null | undefined;
  status: AlbumStatus;
  busy: boolean;
  onDownload: (() => void) | null;
  metric?: ReleaseMetricValue | null;
  headingLevel?: "h2" | "h3";
}) {
  const title = releaseGroup.title || "Untitled release";
  const canDownload =
    onDownload && (!status || status.status === "monitored" || status.status === "unmonitored");
  return (
    <article className="artist-release-tile" data-artwork-scope>
      <div className="artist-release-tile__cover" data-artwork>
        <ReleaseCoverImage
          src={coverUrl}
          fallback={fallbackCoverUrl}
          alt=""
          loading="lazy"
          decoding="async"
          placeholder={
            <span className="artist-release-tile__placeholder" aria-hidden="true">
              <Music />
            </span>
          }
        />
        {canDownload || busy ? (
          <AddActionButton
            {...getAlbumAddAction({ releaseDate: releaseGroup["first-release-date"] })}
            className={`artist-release-tile__get${busy ? " is-busy" : ""}`}
            aria-label={`Download ${title}`}
            onAdd={() => onDownload?.()}
            isLoading={busy}
            loadingLabel="Downloading"
            disabled={busy}
          />
        ) : null}
      </div>
      <Heading className="artist-release-tile__title">
        <OptionalLink link={link} className="card-link">
          <Tooltip content={title}>
            <span className="card-link__label">{title}</span>
          </Tooltip>
        </OptionalLink>
      </Heading>
      <ReleaseStatusLine
        status={status}
        busy={busy}
        meta={<ReleaseMeta releaseGroup={releaseGroup} detail={detail} />}
      />
      {metric?.label ? (
        <Tooltip content={metric.title}>
          <p className="artist-release-tile__metric">
            <ReleaseMetric metric={metric} />
          </p>
        </Tooltip>
      ) : null}
    </article>
  );
}
