import { useLayoutEffect } from "react";
import { useLocation, useViewTransitionState } from "react-router";

const SHARED_ARTWORK_NAME = "shared-artwork";

let pendingArtwork = null;

const reducedMotionQuery =
  typeof window !== "undefined" && typeof window.matchMedia === "function"
    ? window.matchMedia("(prefers-reduced-motion: reduce)")
    : null;

export const routeTransitionsEnabled = () =>
  typeof document !== "undefined" &&
  typeof document.startViewTransition === "function" &&
  !reducedMotionQuery?.matches;

const releaseSourceArtwork = () => {
  if (pendingArtwork?.element) pendingArtwork.element.style.viewTransitionName = "";
};

export function markSharedArtwork(link, pathname) {
  releaseSourceArtwork();
  pendingArtwork = null;
  const artwork = link.closest("[data-artwork-scope]")?.querySelector("[data-artwork]");
  if (!artwork || !pathname) return;
  artwork.style.viewTransitionName = SHARED_ARTWORK_NAME;
  pendingArtwork = { pathname, element: artwork };
}

export function useSharedArtworkStyle() {
  const { pathname } = useLocation();
  const transitioning = useViewTransitionState(pathname);
  const isTarget = transitioning && pendingArtwork?.pathname === pathname;

  useLayoutEffect(() => {
    if (isTarget) releaseSourceArtwork();
  }, [isTarget]);

  useLayoutEffect(() => {
    if (transitioning || pendingArtwork?.pathname !== pathname) return;
    releaseSourceArtwork();
    pendingArtwork = null;
  }, [pathname, transitioning]);

  return isTarget ? { viewTransitionName: SHARED_ARTWORK_NAME } : undefined;
}
