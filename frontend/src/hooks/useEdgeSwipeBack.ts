import { useEffect, useRef, type RefObject } from "react";

const EDGE_PX = 24;
const COMMIT_RATIO = 0.35;
const COMMIT_VELOCITY = 0.5;
const SETTLE_MS = 220;
const VELOCITY_MAX_AGE_MS = 100;

export function useEdgeSwipeBack(
  targetRef: RefObject<HTMLElement | null>,
  { enabled, onBack, resetKey }: { enabled: boolean; onBack: () => void; resetKey: string },
) {
  const onBackRef = useRef(onBack);
  onBackRef.current = onBack;
  const settleTimerRef = useRef<number | undefined>(undefined);

  useEffect(() => {
    window.clearTimeout(settleTimerRef.current);
    const target = targetRef.current;
    if (!target) return;
    target.style.transition = "";
    target.style.transform = "";
  }, [resetKey, targetRef]);

  useEffect(() => {
    const target = targetRef.current;
    if (!enabled || !target) return undefined;
    const mobile = window.matchMedia("(max-width: 767px)");
    let swipe: { id: number; x: number; y: number; locked: boolean } | null = null;
    let last = { dx: 0, t: 0, velocity: 0 };

    const settle = (to: number, done?: () => void) => {
      target.style.transition = `transform ${SETTLE_MS}ms cubic-bezier(0.2, 0.8, 0.2, 1)`;
      target.style.transform = to ? `translate3d(${to}px, 0, 0)` : "";
      window.clearTimeout(settleTimerRef.current);
      settleTimerRef.current = window.setTimeout(() => {
        if (!to) target.style.transition = "";
        done?.();
      }, SETTLE_MS);
    };

    const handleStart = (event: TouchEvent) => {
      const touch = event.touches[0];
      if (event.touches.length !== 1 || !touch || !mobile.matches || touch.clientX > EDGE_PX) {
        if (swipe?.locked) settle(0);
        swipe = null;
        return;
      }
      swipe = { id: touch.identifier, x: touch.clientX, y: touch.clientY, locked: false };
      last = { dx: 0, t: event.timeStamp, velocity: 0 };
    };

    const handleMove = (event: TouchEvent) => {
      if (!swipe) return;
      const touch = [...event.changedTouches].find((item) => item.identifier === swipe?.id);
      if (!touch) return;
      const dx = touch.clientX - swipe.x;
      const dy = touch.clientY - swipe.y;
      if (!swipe.locked) {
        if (dx <= 0 || Math.abs(dy) >= dx || !event.cancelable) {
          swipe = null;
          return;
        }
        swipe.locked = true;
        target.style.transition = "none";
      }
      event.preventDefault();
      const elapsed = event.timeStamp - last.t;
      if (elapsed > 0) last = { dx, t: event.timeStamp, velocity: (dx - last.dx) / elapsed };
      target.style.transform = `translate3d(${Math.max(0, dx)}px, 0, 0)`;
    };

    const handleEnd = (event: TouchEvent) => {
      if (!swipe?.locked) {
        swipe = null;
        return;
      }
      const cancelled = event.type === "touchcancel";
      swipe = null;
      const width = target.clientWidth;
      const fresh = event.timeStamp - last.t <= VELOCITY_MAX_AGE_MS;
      const commit =
        !cancelled &&
        (last.dx > width * COMMIT_RATIO || (fresh && last.velocity > COMMIT_VELOCITY));
      if (commit) settle(width, () => onBackRef.current());
      else settle(0);
    };

    target.addEventListener("touchstart", handleStart, { passive: true });
    target.addEventListener("touchmove", handleMove, { passive: false });
    target.addEventListener("touchend", handleEnd);
    target.addEventListener("touchcancel", handleEnd);
    return () => {
      target.removeEventListener("touchstart", handleStart);
      target.removeEventListener("touchmove", handleMove);
      target.removeEventListener("touchend", handleEnd);
      target.removeEventListener("touchcancel", handleEnd);
      window.clearTimeout(settleTimerRef.current);
      target.style.transition = "";
      target.style.transform = "";
    };
  }, [enabled, targetRef]);
}
