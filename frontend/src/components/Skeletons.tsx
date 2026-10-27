import { Play } from "./icons";
import type { ElementType, ReactNode, Ref } from "react";
import { CollectionHeader } from "./CollectionHeader";

type LibraryCardKind = "album" | "artist" | "playlist";
type RailKind = "album" | "artist" | "news" | "playlist" | "show";
type SearchResultsMode = "all" | "albums" | "artist-list" | "artists" | "round-artists";

const range = (count: number) => Array.from({ length: count }, (_, index) => index);

const TEXT_WIDTHS = ["72%", "58%", "84%", "64%"];
const COVER_CLASS: Partial<Record<LibraryCardKind, string>> = {
  artist: " native-library-card__cover--round",
  playlist: " playlists-page__cover",
};
const isTallCard = (index: number) => index % 3 === 1;
const textWidth = (index: number, offset = 0) => TEXT_WIDTHS[(index + offset) % TEXT_WIDTHS.length];

export function SkeletonStatus({
  label,
  as: Tag = "div",
  className = "",
  children,
}: {
  label: string;
  as?: ElementType;
  className?: string;
  children?: ReactNode;
}) {
  return (
    <Tag
      className={`skeleton-status${className ? ` ${className}` : ""}`}
      role="status"
      aria-busy="true"
    >
      <span className="sr-only">{label}</span>
      <div className="skeleton-status__body" aria-hidden="true">
        {children}
      </div>
    </Tag>
  );
}

export function SkeletonText({ width = "60%" }: { width?: string }) {
  return (
    <span className="skeleton-text" style={{ "--skeleton-width": width }}>
      {"\u200b"}
    </span>
  );
}

export function SkeletonShape({
  as: Tag = "span",
  className = "",
  children = null,
}: {
  as?: ElementType;
  className?: string;
  children?: ReactNode;
}) {
  return <Tag className={`${className} skeleton-shape`}>{children}</Tag>;
}

export function SkeletonDiscoverCard({
  kind = "artist",
  index = 0,
}: {
  kind?: RailKind;
  index?: number;
}) {
  const cover = <SkeletonShape as="div" className="artist-discover-card__cover" />;
  return (
    <div className={`artist-discover-card artist-discover-card--${kind}`}>
      {kind === "album" ? <div className="artist-discover-card__cover-wrap">{cover}</div> : cover}
      <div className="artist-discover-card__content">
        <div className="artist-discover-card__text">
          <div className="artist-card-title-row--discover">
            <span className="artist-card-title--discover skeleton-grow">
              {isTallCard(index) ? <SkeletonText width="100%" /> : null}
              <SkeletonText width={textWidth(index)} />
            </span>
          </div>
          <p className="artist-card-meta--discover">
            <SkeletonText width={textWidth(index, 2)} />
          </p>
          {kind === "album" ? (
            <p className="artist-card-meta--discover">
              <SkeletonText width="35%" />
            </p>
          ) : null}
        </div>
        {kind === "artist" ? <div className="artist-discover-card__menu" /> : null}
      </div>
    </div>
  );
}

export function SkeletonShowCard({ index = 0 }: { index?: number }) {
  return (
    <article className="artist-show-card--discover">
      <SkeletonShape as="div" className="artist-show-card__image-wrap--discover" />
      <div className="artist-show-card__body--discover">
        <div className="artist-show-card__body-heading">
          {isTallCard(index) ? (
            <p className="artist-show-card__body-artist--discover artist-truncate">
              <SkeletonText width="50%" />
            </p>
          ) : null}
          <h3 className="artist-show-card__body-title--discover">
            <SkeletonText width={textWidth(index)} />
          </h3>
        </div>
        <div className="artist-show-card__body-details--discover">
          <p className="artist-show-card__detail--discover">
            <SkeletonText width="45%" />
          </p>
          <p className="artist-show-card__detail--discover artist-show-card__detail--discover-location">
            <SkeletonText width={textWidth(index, 1)} />
          </p>
        </div>
      </div>
    </article>
  );
}

export function SkeletonNewsCard({ compact = false }: { compact?: boolean }) {
  return (
    <article className="discover-news-card-shell">
      <div className={`discover-news-card${compact ? " discover-news-card--compact" : ""}`}>
        <div className="discover-news-card__link">
          <SkeletonShape as="div" className="discover-news-card__image-wrap" />
          <div className="discover-news-card__content">
            {compact ? (
              <span className="discover-news-card__artist">
                <SkeletonText width="30%" />
              </span>
            ) : null}
            <h3 className="discover-news-card__title">
              <SkeletonText width="100%" />
              <SkeletonText width="65%" />
            </h3>
            {compact ? null : (
              <p className="discover-news-card__description">
                <SkeletonText width="100%" />
                <SkeletonText width="100%" />
                <SkeletonText width="80%" />
              </p>
            )}
          </div>
        </div>
        <div className="discover-news-card__footer">
          <span className="discover-news-card__block" />
          <span className="discover-news-card__meta">
            <SkeletonText width="45%" />
          </span>
        </div>
      </div>
    </article>
  );
}

export function SkeletonReleaseCard({
  index = 0,
  search = false,
}: {
  index?: number;
  search?: boolean;
}) {
  const cover = search ? (
    <div className="search-album-results__cover-wrap">
      <SkeletonShape
        as="div"
        className="artist-release-card__cover search-album-results__cover-link"
      />
    </div>
  ) : (
    <SkeletonShape as="div" className="artist-release-card__cover" />
  );
  return (
    <article className={`artist-release-card${search ? " search-album-results__item" : ""}`}>
      {cover}
      <h2 className="artist-release-card__title artist-truncate">
        <SkeletonText width={textWidth(index)} />
      </h2>
      <p className="artist-release-card__meta artist-truncate">
        <SkeletonText width={textWidth(index, 2)} />
      </p>
      {search ? (
        <p className="artist-release-card__meta artist-truncate">
          <SkeletonText width="40%" />
        </p>
      ) : (
        <p className="artist-release-card__metric">
          <SkeletonText width="2.5em" />
        </p>
      )}
    </article>
  );
}

export function SkeletonSearchResults({
  mode = "all",
  count = 12,
  gridColumns,
}: {
  mode?: SearchResultsMode;
  count?: number;
  gridColumns?: number;
}) {
  if (mode === "albums") {
    return (
      <div className="artist-albums-grid">
        {range(count).map((index) => (
          <SkeletonReleaseCard key={index} index={index} search />
        ))}
      </div>
    );
  }
  if (mode === "artist-list") {
    return (
      <div className="artist-release-list search-artist-list">
        {range(count).map((index) => (
          <article key={index} className="artist-release-list-item search-artist-results__item">
            <SkeletonShape as="div" className="artist-discover-card__cover artist-list-cover" />
            <div className="artist-min-0">
              <h2 className="artist-release-card__title artist-truncate">
                <SkeletonText width={textWidth(index)} />
              </h2>
              <p className="artist-release-card__meta artist-truncate">
                <SkeletonText width={textWidth(index, 2)} />
              </p>
            </div>
            <div className="artist-discover-card__menu" />
          </article>
        ))}
      </div>
    );
  }
  if (mode === "artists" || mode === "round-artists") {
    return (
      <div
        className={`artist-release-grid${mode === "round-artists" ? " search-artist-grid--round" : ""}`}
        style={
          gridColumns
            ? { gridTemplateColumns: `repeat(${gridColumns}, minmax(0, 1fr))` }
            : undefined
        }
      >
        {range(count).map((index) => (
          <SkeletonDiscoverCard key={index} index={index} />
        ))}
      </div>
    );
  }
  return (
    <div className="search-page__unified">
      <article className="search-top-artist">
        <div className="search-top-artist__main">
          <span className="search-top-artist__content">
            <SkeletonShape className="search-top-artist__image-wrap" />
            <span className="search-top-artist__copy">
              <span className="search-top-artist__eyebrow">
                <SkeletonText width="5em" />
              </span>
              <span className="search-top-artist__title-row">
                <span className="search-top-artist__name">
                  <SkeletonText width="6em" />
                </span>
              </span>
              <span className="search-top-artist__meta-row">
                <span className="search-top-artist__meta">
                  <SkeletonText width="4em" />
                </span>
              </span>
            </span>
          </span>
        </div>
      </article>
      <ul className="search-mixed-results">
        {range(8).map((index) => (
          <li key={index}>
            <div className="search-mixed-results__row">
              <div className="search-mixed-results__main">
                <SkeletonShape className="search-mixed-results__thumb" />
                <span className="search-mixed-results__copy">
                  <span className="search-mixed-results__title">
                    <SkeletonText width={textWidth(index)} />
                  </span>
                  <span className="search-mixed-results__subtitle">
                    <SkeletonText width={textWidth(index, 2)} />
                  </span>
                </span>
              </div>
              <span className="search-mixed-results__type-col">
                <span className="search-mixed-results__type">
                  <SkeletonText width="3em" />
                </span>
              </span>
              <span className="search-mixed-results__actions" />
            </div>
          </li>
        ))}
      </ul>
    </div>
  );
}

const RAIL_CARDS: Partial<Record<RailKind, (index: number) => ReactNode>> = {
  show: (index) => (
    <div key={index} className="artist-discover-show-rail-card">
      <SkeletonShowCard index={index} />
    </div>
  ),
  news: (index) => (
    <div key={index} className="artist-discover-shelf-card artist-discover-shelf-card--news">
      <SkeletonNewsCard compact />
    </div>
  ),
};

export function SkeletonRail({ count = 8, kind = "artist" }: { count?: number; kind?: RailKind }) {
  return (
    <section className="artist-discover-rail">
      <div className="artist-discover-rail__header">
        <div className="artist-discover-rail__title-group">
          <h2 className="artist-section-title--discover">
            <SkeletonText width="9em" />
          </h2>
        </div>
      </div>
      <div className="artist-discover-rail__content">
        {range(count).map((index) =>
          RAIL_CARDS[kind] ? (
            RAIL_CARDS[kind](index)
          ) : (
            <div key={index} className="artist-discover-shelf-card">
              <SkeletonDiscoverCard kind={kind} index={index} />
            </div>
          ),
        )}
      </div>
    </section>
  );
}

export function SkeletonLibraryCard({
  kind = "album",
  index = 0,
}: {
  kind?: LibraryCardKind;
  index?: number;
}) {
  return (
    <article className="native-library-card">
      <div className="native-library-card__cover-wrap">
        <SkeletonShape className={`native-library-card__cover${COVER_CLASS[kind] || ""}`} />
      </div>
      <div className="native-library-card__body">
        {kind === "playlist" ? (
          <span className="native-library-card__title playlists-page__title">
            <SkeletonText width={textWidth(index)} />
          </span>
        ) : (
          <div className="native-library-card__title-row">
            <span className="native-library-card__title">
              <SkeletonText width={textWidth(index)} />
            </span>
            <span className="native-library-favorite" />
          </div>
        )}
        {kind === "album" ? (
          <span className="native-library-card__artist">
            <SkeletonText width={textWidth(index, 1)} />
          </span>
        ) : null}
        <span className="native-library-card__meta">
          <SkeletonText width="42%" />
        </span>
      </div>
    </article>
  );
}

export function SkeletonLibraryGrid({
  ref,
  count = 14,
  kind = "album",
  className = "native-library-grid",
}: {
  ref?: Ref<HTMLDivElement>;
  count?: number;
  kind?: LibraryCardKind;
  className?: string;
}) {
  return (
    <div ref={ref} className={className}>
      {range(count).map((index) => (
        <SkeletonLibraryCard key={index} kind={kind} index={index} />
      ))}
    </div>
  );
}

export function SkeletonTrackList({
  count = 10,
  variant = "collection",
}: {
  count?: number;
  variant?: "collection" | "release";
}) {
  const isCollection = variant === "collection";
  return (
    <div className={`native-library-track-list native-library-track-list--${variant}`}>
      <div className="native-library-track native-library-track--heading">
        <span />
        <span className="native-library-track__number">#</span>
        {isCollection ? <span /> : null}
        <span>Title</span>
        {isCollection ? <span>Artist</span> : null}
        {isCollection ? <span>Album</span> : null}
        <span className="native-library-track__time">Time</span>
        <span />
        <span />
        <span />
      </div>
      <div>
        {range(count).map((index) => (
          <div key={index} className="native-library-track">
            <span />
            <span className="native-library-track__number">
              <SkeletonText width="1em" />
            </span>
            {isCollection ? (
              <SkeletonShape className="native-library-track__cover">
                <span />
              </SkeletonShape>
            ) : null}
            <span className="native-library-track__title">
              <span>
                <SkeletonText width={textWidth(index)} />
              </span>
            </span>
            {isCollection ? (
              <span className="native-library-track__link native-library-track__artist">
                <SkeletonText width={textWidth(index, 1)} />
              </span>
            ) : null}
            {isCollection ? (
              <span className="native-library-track__link native-library-track__album">
                <SkeletonText width={textWidth(index, 2)} />
              </span>
            ) : null}
            <span className="native-library-track__time">
              <SkeletonText width="2.25em" />
            </span>
            <span />
            <span />
            <span />
          </div>
        ))}
      </div>
    </div>
  );
}

export function SkeletonCollectionTracks({
  count = 10,
  toolbar = true,
}: {
  count?: number;
  toolbar?: boolean;
}) {
  return (
    <div className="collection-tracks">
      {toolbar ? (
        <div className="collection-tracks__toolbar">
          <SkeletonShape className="native-library-icon-button" />
        </div>
      ) : null}
      <SkeletonTrackList count={count} />
    </div>
  );
}

export function SkeletonPlayButtons({ icons = 2 }: { icons?: number }) {
  return (
    <>
      <SkeletonShape className="native-library-page-play">
        <Play aria-hidden="true" />
        Play
      </SkeletonShape>
      {range(icons).map((index) => (
        <SkeletonShape key={index} className="native-library-favorite" />
      ))}
    </>
  );
}

export function SkeletonCollectionHeader({
  kicker = true,
  subtitle = false,
  description = false,
  icons = 2,
}: {
  kicker?: boolean;
  subtitle?: boolean;
  description?: boolean;
  icons?: number;
}) {
  return (
    <CollectionHeader
      cover={<SkeletonShape className="skeleton-fill" />}
      kicker={kicker ? <SkeletonText width="4em" /> : null}
      title={<SkeletonText width="8em" />}
      subtitle={
        description ? (
          <p className="collection-header__description">
            <SkeletonText width="24em" />
          </p>
        ) : subtitle ? (
          <span className="native-library-detail__artist">
            <SkeletonText width="7em" />
          </span>
        ) : null
      }
      meta={<SkeletonText width="11em" />}
      actions={<SkeletonPlayButtons icons={icons} />}
    />
  );
}

export function SkeletonAlbumDetail({ label }: { label: string }) {
  return (
    <SkeletonStatus label={label} className="native-library-detail">
      <SkeletonCollectionHeader subtitle icons={4} />
      <SkeletonTrackList count={12} variant="release" />
    </SkeletonStatus>
  );
}

export function SkeletonLibraryArtist({ label }: { label: string }) {
  return (
    <SkeletonStatus label={label} className="native-library-detail">
      <div className="native-library-detail__hero native-library-detail__hero--artist">
        <div className="native-library-detail__cover">
          <SkeletonShape className="skeleton-fill" />
        </div>
        <div className="native-library-detail__body">
          <p className="native-library-kicker">
            <SkeletonText width="3em" />
          </p>
          <h2>
            <SkeletonText width="6em" />
          </h2>
          <p className="native-library-detail__meta">
            <SkeletonText width="8em" />
          </p>
          <div className="native-library-detail__actions">
            <SkeletonPlayButtons icons={3} />
          </div>
        </div>
      </div>
      <section className="native-library-detail__section">
        <div className="native-library-detail__section-heading">
          <h3>Albums</h3>
        </div>
        <SkeletonLibraryGrid count={2} />
      </section>
      <section className="native-library-detail__section">
        <div className="native-library-detail__section-heading">
          <h3>Top tracks</h3>
        </div>
        <SkeletonTrackList count={5} />
      </section>
    </SkeletonStatus>
  );
}

export function SkeletonPageTitle({ label }: { label: string }) {
  return (
    <SkeletonStatus label={label}>
      <h1 className="page-title">
        <SkeletonText width="5em" />
      </h1>
    </SkeletonStatus>
  );
}

export function SkeletonActivityList({
  count = 8,
  dateGroup = false,
  hint = false,
  actions = 1,
}: {
  count?: number;
  dateGroup?: boolean;
  hint?: boolean;
  actions?: number;
}) {
  return (
    <div className="activity-list">
      {dateGroup ? (
        <div className="activity-list__date-group">
          <SkeletonText width="3em" />
        </div>
      ) : null}
      {range(count).map((index) => (
        <article key={index} className="activity-row">
          <SkeletonShape className="activity-row__status" />
          <div className="activity-row__details">
            <h2 className="activity-row__title">
              <SkeletonText width={textWidth(index)} />
            </h2>
            <p className="activity-row__meta">
              <SkeletonText width={textWidth(index, 2)} />
            </p>
            {hint ? (
              <p className="activity-row__hint">
                <SkeletonText width="40%" />
              </p>
            ) : null}
          </div>
          <span className="activity-row__status-label">
            <SkeletonText width="5em" />
          </span>
          <span className="activity-row__time">
            <SkeletonText width="4em" />
          </span>
          <div className="activity-row__actions">
            {range(actions).map((action) => (
              <SkeletonShape key={action} className="native-library-icon-button" />
            ))}
          </div>
        </article>
      ))}
    </div>
  );
}
