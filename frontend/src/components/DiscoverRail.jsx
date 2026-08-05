import { useState, useEffect, useCallback, useRef } from "react";
import { ChevronLeft, ChevronRight } from "lucide-react";

export function DiscoverRail({
  title,
  subtitle,
  mobileTitle,
  onViewAll,
  afterTitle,
  headerActions,
  children,
  className = "",
  headerClassName = "",
  style,
  footer,
}) {
  const scrollRef = useRef(null);
  const [canScrollLeft, setCanScrollLeft] = useState(false);
  const [canScrollRight, setCanScrollRight] = useState(false);

  const updateScrollState = useCallback(() => {
    const node = scrollRef.current;
    if (!node) return;
    const maxScrollLeft = Math.max(node.scrollWidth - node.clientWidth, 0);
    const nextCanScrollLeft = node.scrollLeft > 2;
    const nextCanScrollRight = node.scrollLeft < maxScrollLeft - 2;
    setCanScrollLeft(nextCanScrollLeft);
    setCanScrollRight(nextCanScrollRight);
  }, []);

  const scrollByAmount = useCallback((direction) => {
    if (!scrollRef.current) return;
    const width = scrollRef.current.clientWidth;
    scrollRef.current.scrollBy({
      left: direction * Math.max(width * 0.85, 280),
      behavior: "smooth",
    });
  }, []);

  useEffect(() => {
    const node = scrollRef.current;
    if (!node) return;
    updateScrollState();
    node.addEventListener("scroll", updateScrollState, { passive: true });
    window.addEventListener("resize", updateScrollState);
    return () => {
      node.removeEventListener("scroll", updateScrollState);
      window.removeEventListener("resize", updateScrollState);
    };
  }, [children, footer, updateScrollState]);

  return (
    <section className={`artist-discover-rail ${className}`} style={style}>
      <div className={`artist-discover-rail__header ${headerClassName}`}>
        <div className="artist-discover-rail__title-group">
          <h2 className="artist-section-title--discover">
            <span className="artist-section-title--discover-mobile">{mobileTitle || title}</span>
            <span className="artist-section-title--discover-desktop">{title}</span>
          </h2>
          {subtitle ? (
            <p className="artist-discover-rail__subtitle">{subtitle}</p>
          ) : null}
          {onViewAll ? (
            <button
              type="button"
              onClick={onViewAll}
              className="btn btn-ghost btn-icon-square"
              aria-label={`Open ${title}`}
              title={`Open ${title}`}
            >
              <ChevronRight className="artist-icon-lg" />
            </button>
          ) : null}
          {afterTitle}
        </div>
        <div className="artist-discover-rail__actions">
          {headerActions}
          <button
            type="button"
            onClick={() => scrollByAmount(-1)}
            className="btn btn-ghost btn-icon-square"
            style={{ color: canScrollLeft ? "#6f7685" : "#2d3442" }}
            aria-label={`Scroll ${title} left`}
            title={`Scroll ${title} left`}
            disabled={!canScrollLeft}
          >
            <ChevronLeft className="artist-icon-lg" />
          </button>
          <button
            type="button"
            onClick={() => scrollByAmount(1)}
            className="btn btn-ghost btn-icon-square"
            style={{ color: canScrollRight ? "#d1d5df" : "#2d3442" }}
            aria-label={`Scroll ${title} right`}
            title={`Scroll ${title} right`}
            disabled={!canScrollRight}
          >
            <ChevronRight className="artist-icon-lg" />
          </button>
        </div>
      </div>
      <div ref={scrollRef} className="artist-discover-rail__content">
        {children}
      </div>
      {footer}
    </section>
  );
}
