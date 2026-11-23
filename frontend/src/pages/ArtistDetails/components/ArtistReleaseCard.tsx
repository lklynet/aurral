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

function MetaMetric({
  metric,
  separated,
}: {
  metric: ReleaseMetricValue | null;
  separated: boolean;
}) {
  if (!metric?.label) return null;
  return (
    <Tooltip content={metric.title}>
      <span className="artist-release-meta__metric">
        {separated ? <span aria-hidden="true">·</span> : null}
        <ReleaseMetric metric={metric} />
      </span>
    </Tooltip>
  );
}

export function ReleaseMeta({
  releaseGroup,
  credit = null,
  type,
  metric = null,
}: {
  releaseGroup: ReleaseGroup;
  credit?: string | null;
  type: string | null | undefined;
  metric?: ReleaseMetricValue | null;
}) {
  const detail = credit || type;
  const lead = isNewReleaseGroup(releaseGroup) ? (
    <span className="artist-release-new">New</span>
  ) : (
    getReleaseYear(releaseGroup)
  );
  return (
    <>
      <span className="artist-release-meta__text">
        {lead}
        {lead && detail ? (
          <span className={credit ? undefined : "artist-release-meta__type"}>
            {" · "}
            {detail}
          </span>
        ) : (
          detail
        )}
      </span>
      <MetaMetric metric={metric} separated={Boolean(lead || detail)} />
    </>
  );
}

function ReleaseStatusLine({
  status,
  busy,
  meta,
  metric,
}: {
  status: AlbumStatus;
  busy: boolean;
  meta: ReactNode;
  metric: ReleaseMetricValue | null;
}) {
  const statusMetric = <MetaMetric metric={metric} separated />;
  if (busy) {
    return (
      <p className="artist-release-tile__meta is-busy">
        <span className="artist-release-meta__text">Downloading</span>
        {statusMetric}
      </p>
    );
  }
  if (status?.status === "available" && status.partial) {
    const { trackCount = 0, trackFileCount = 0 } = status;
    return (
      <p className="artist-release-tile__meta">
        <SearchLibraryCheck size="sm" className="library-check--partial" aria-hidden="true" />
        <span className="artist-release-meta__text is-partial">
          {trackCount > 0 ? `${trackFileCount} of ${trackCount} tracks` : "Incomplete"}
        </span>
        {statusMetric}
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
        <span className="artist-release-meta__text is-scheduled">{status.label}</span>
        {statusMetric}
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
  credit = null,
  type,
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
  credit?: string | null;
  type: string | null | undefined;
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
        meta={
          <ReleaseMeta releaseGroup={releaseGroup} credit={credit} type={type} metric={metric} />
        }
        metric={metric}
      />
    </article>
  );
}
