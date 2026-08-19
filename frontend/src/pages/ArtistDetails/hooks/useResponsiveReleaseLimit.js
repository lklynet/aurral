import { useCallback, useEffect, useState } from "react";

const RELEASE_CARD_MIN_WIDTH = 144;
const RELEASE_GRID_GAP = 12;

export const getResponsiveReleaseLimit = (width, cardMinWidth = RELEASE_CARD_MIN_WIDTH) =>
  Math.max(
    1,
    Math.floor(
      (Math.max(0, Number(width)) + RELEASE_GRID_GAP) /
        (cardMinWidth + RELEASE_GRID_GAP),
    ),
  );

export function useResponsiveReleaseLimit({ cardMinWidth = RELEASE_CARD_MIN_WIDTH } = {}) {
  const [gridElement, setGridElement] = useState(null);
  const [limit, setLimit] = useState(6);
  const gridRef = useCallback((element) => setGridElement(element), []);

  useEffect(() => {
    if (!gridElement) return undefined;

    const updateLimit = () => {
      setLimit(getResponsiveReleaseLimit(gridElement.clientWidth, cardMinWidth));
    };
    updateLimit();

    if (typeof ResizeObserver === "undefined") {
      window.addEventListener("resize", updateLimit);
      return () => window.removeEventListener("resize", updateLimit);
    }

    const observer = new ResizeObserver(updateLimit);
    observer.observe(gridElement);
    return () => observer.disconnect();
  }, [cardMinWidth, gridElement]);

  return [gridRef, limit];
}
