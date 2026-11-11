import { useCallback, useEffect, useState } from "react";
import { useMediaQuery } from "../../../hooks/useMediaQuery.ts";

const RELEASE_CARD_MIN_WIDTH = 144;
const RELEASE_GRID_GAP = 12;

export const getResponsiveReleaseLimit = (width: number, cardMinWidth = RELEASE_CARD_MIN_WIDTH) =>
  Math.max(
    1,
    Math.floor((Math.max(0, Number(width)) + RELEASE_GRID_GAP) / (cardMinWidth + RELEASE_GRID_GAP)),
  );

function useGridLimit(getLimit: (width: number) => number) {
  const [gridElement, setGridElement] = useState<HTMLElement | null>(null);
  const [limit, setLimit] = useState(6);
  const gridRef = useCallback((element: HTMLElement | null) => setGridElement(element), []);

  useEffect(() => {
    if (!gridElement) return undefined;

    const updateLimit = () => setLimit(getLimit(gridElement.clientWidth));
    updateLimit();

    if (typeof ResizeObserver === "undefined") {
      window.addEventListener("resize", updateLimit);
      return () => window.removeEventListener("resize", updateLimit);
    }

    const observer = new ResizeObserver(updateLimit);
    observer.observe(gridElement);
    return () => observer.disconnect();
  }, [getLimit, gridElement]);

  return [gridRef, limit] as const;
}

export function useResponsiveReleaseLimit({ cardMinWidth = RELEASE_CARD_MIN_WIDTH } = {}) {
  const getLimit = useCallback(
    (width: number) => getResponsiveReleaseLimit(width, cardMinWidth),
    [cardMinWidth],
  );
  return useGridLimit(getLimit);
}

const PHONE_SHELF_LIMIT = 12;
const WIDE_SHELF_CARD_WIDTH = 165;
const SHELF_TIERS = [
  [916, 6],
  [696, 5],
] as const;

export const getArtistShelfLimit = (width: number) =>
  width >= 1116
    ? Math.max(7, Math.floor((width + 20) / WIDE_SHELF_CARD_WIDTH))
    : (SHELF_TIERS.find(([minWidth]) => width >= minWidth)?.[1] ?? 4);

export function useArtistReleaseShelf() {
  const [gridRef, limit] = useGridLimit(getArtistShelfLimit);
  const phone = useMediaQuery("(max-width: 767px)");
  return [gridRef, phone ? PHONE_SHELF_LIMIT : limit] as const;
}
