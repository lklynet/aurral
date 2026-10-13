const range = (count) => Array.from({ length: count }, (_, index) => index);

export function SkeletonStatus({ label, as: Tag = "div", className = "", children }) {
  return (
    <Tag className={`skeleton-status${className ? ` ${className}` : ""}`} role="status" aria-busy="true">
      <span className="sr-only">{label}</span>
      <div className="skeleton-status__body" aria-hidden="true">
        {children}
      </div>
    </Tag>
  );
}

export function SkeletonLine({ size = "md", className = "" }) {
  return <span className={`skeleton-block skeleton-line skeleton-line--${size}${className ? ` ${className}` : ""}`} />;
}

export function SkeletonCard({ square = false }) {
  return (
    <div className={`discover-skeleton-card${square ? " discover-skeleton-card--square" : ""}`}>
      <div className="discover-skeleton-card__cover" />
      <div className="discover-skeleton-card__line" />
      <div className="discover-skeleton-card__line discover-skeleton-card__line--short" />
    </div>
  );
}

export function SkeletonCardGrid({ count = 12, square = false, className = "skeleton-card-grid" }) {
  return (
    <div className={className}>
      {range(count).map((index) => (
        <SkeletonCard key={index} square={square} />
      ))}
    </div>
  );
}

export function SkeletonRail({ count = 8, square = false }) {
  return (
    <section className="artist-discover-rail discover-rail--placeholder skeleton-rail">
      <div className="artist-discover-rail__header">
        <SkeletonLine size="title" />
      </div>
      <div className="artist-discover-rail__content">
        {range(count).map((index) => (
          <div key={index} className="artist-discover-shelf-card">
            <SkeletonCard square={square} />
          </div>
        ))}
      </div>
    </section>
  );
}

export function SkeletonRows({ count = 8, art = true }) {
  return (
    <div className="skeleton-rows">
      {range(count).map((index) => (
        <div key={index} className="skeleton-row">
          {art ? <span className="skeleton-block skeleton-row__art" /> : null}
          <span className="skeleton-row__text">
            <SkeletonLine size={index % 3 === 0 ? "lg" : "md"} />
            <SkeletonLine size="sm" />
          </span>
          <SkeletonLine size="xs" className="skeleton-row__meta" />
        </div>
      ))}
    </div>
  );
}

export function SkeletonCollectionHeader() {
  return (
    <div className="native-library-detail__hero collection-header">
      <div className="native-library-detail__cover skeleton-block" />
      <div className="native-library-detail__body skeleton-collection-header__body">
        <SkeletonLine size="sm" />
        <SkeletonLine size="title" />
        <SkeletonLine size="md" />
      </div>
    </div>
  );
}

export function SkeletonPageHeader() {
  return (
    <div className="skeleton-page-header">
      <SkeletonLine size="title" />
    </div>
  );
}
