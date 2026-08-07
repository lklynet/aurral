import { useCallback, useEffect, useState } from "react";

const RELEASE_CARD_MIN_WIDTH = 144;
const RELEASE_GRID_GAP = 12;

export const getResponsiveReleaseLimit = (width) =>
  Math.max(
    1,
    Math.floor((Math.max(0, Number(width)) + RELEASE_GRID_GAP) / (RELEASE_CARD_MIN_WIDTH + RELEASE_GRID_GAP)),
  );

export function useResponsiveReleaseLimit() {
  const [gridElement, setGridElement] = useState(null);
  const [limit, setLimit] = useState(6);
  const gridRef = useCallback((element) => setGridElement(element), []);

  useEffect(() => {
    if (!gridElement) return undefined;

    const updateLimit = () => {
      setLimit(getResponsiveReleaseLimit(gridElement.clientWidth));
    };
    updateLimit();

    if (typeof ResizeObserver === "undefined") {
      window.addEventListener("resize", updateLimit);
      return () => window.removeEventListener("resize", updateLimit);
    }

    const observer = new ResizeObserver(updateLimit);
    observer.observe(gridElement);
    return () => observer.disconnect();
  }, [gridElement]);

  return [gridRef, limit];
}
