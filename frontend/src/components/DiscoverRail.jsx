import { useState, useEffect, useCallback, useRef } from "react";
import { ChevronLeft, ChevronRight } from "lucide-react";
import RouteLink from "./RouteLink";
import TooltipButton from "./TooltipButton";

export function DiscoverRail({
  title,
  subtitle,
  mobileTitle,
  viewAllTo,
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
    setCanScrollLeft(node.scrollLeft > 2);
    setCanScrollRight(node.scrollLeft < maxScrollLeft - 2);
  }, []);

  const scrollByAmount = useCallback((direction) => {
    if (!scrollRef.current) return;
    const width = scrollRef.current.clientWidth;
    const reduceMotion = window.matchMedia?.("(prefers-reduced-motion: reduce)").matches;
    scrollRef.current.scrollBy({
      left: direction * Math.max(width * 0.85, 280),
      behavior: reduceMotion ? "auto" : "smooth",
    });
  }, []);

  useEffect(() => {
    const node = scrollRef.current;
    if (!node) return undefined;
    updateScrollState();
    node.addEventListener("scroll", updateScrollState, { passive: true });
    const observer = new ResizeObserver(updateScrollState);
    observer.observe(node);
    return () => {
      node.removeEventListener("scroll", updateScrollState);
      observer.disconnect();
    };
  }, [children, footer, updateScrollState]);

  const titleText = (
    <>
      <span className="artist-section-title--discover-mobile">{mobileTitle || title}</span>
      <span className="artist-section-title--discover-desktop">{title}</span>
    </>
  );
  const overflows = canScrollLeft || canScrollRight;

  return (
    <section className={`artist-discover-rail ${className}`} style={style}>
      <div className={`artist-discover-rail__header ${headerClassName}`}>
        <div className="artist-discover-rail__title-group">
          <h2 className="artist-section-title--discover">
            {viewAllTo ? (
              <RouteLink to={viewAllTo} className="artist-discover-rail__title-link">
                {titleText}
              </RouteLink>
            ) : (
              titleText
            )}
          </h2>
          {subtitle ? <p className="artist-discover-rail__subtitle">{subtitle}</p> : null}
          {afterTitle}
        </div>
        <div className="artist-discover-rail__actions">
          {headerActions}
          {viewAllTo ? (
            <RouteLink
              to={viewAllTo}
              className="artist-discover-rail__show-all"
              aria-hidden="true"
              tabIndex={-1}
            >
              Show all
            </RouteLink>
          ) : null}
          {overflows ? (
            <div className="artist-discover-rail__scroll" role="group" aria-label={`Scroll ${title}`}>
              <TooltipButton
                type="button"
                onClick={() => scrollByAmount(-1)}
                className="artist-discover-rail__scroll-button"
                label="Previous"
                disabled={!canScrollLeft}
              >
                <ChevronLeft aria-hidden="true" />
              </TooltipButton>
              <TooltipButton
                type="button"
                onClick={() => scrollByAmount(1)}
                className="artist-discover-rail__scroll-button"
                label="Next"
                disabled={!canScrollRight}
              >
                <ChevronRight aria-hidden="true" />
              </TooltipButton>
            </div>
          ) : null}
        </div>
      </div>
      <div ref={scrollRef} className="artist-discover-rail__content">
        {children}
      </div>
      {footer}
    </section>
  );
}
