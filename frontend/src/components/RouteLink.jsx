import { forwardRef, useEffect, useRef } from "react";
import { Link, useLocation, useNavigate } from "react-router";
import { useAuth } from "../contexts/AuthContext";
import { isRouteModuleLoaded, prefetchRoute } from "../navigation/routePrefetch.js";
import { markSharedArtwork, routeTransitionsEnabled } from "../navigation/viewTransitions.js";

const HOVER_INTENT_MS = 100;

const isPlainClick = (event, target) =>
  event.button === 0 &&
  !event.defaultPrevented &&
  !event.metaKey &&
  !event.ctrlKey &&
  !event.shiftKey &&
  !event.altKey &&
  (!target || target === "_self");

const RouteLink = forwardRef(function RouteLink(
  {
    to,
    onClick,
    onPointerEnter,
    onPointerLeave,
    onFocus,
    onTouchStart,
    onTouchMove,
    onTouchEnd,
    ...props
  },
  ref,
) {
  const userId = useAuth()?.user?.id ?? null;
  const navigate = useNavigate();
  const location = useLocation();
  const timerRef = useRef(null);

  const cancel = () => {
    clearTimeout(timerRef.current);
    timerRef.current = null;
  };
  const prefetch = () => {
    cancel();
    void prefetchRoute(to, { userId });
  };
  const schedule = () => {
    cancel();
    timerRef.current = setTimeout(prefetch, HOVER_INTENT_MS);
  };

  useEffect(() => () => clearTimeout(timerRef.current), []);

  return (
    <Link
      ref={ref}
      to={to}
      {...props}
      onClick={(event) => {
        onClick?.(event);
        if (
          typeof to !== "string" ||
          props.reloadDocument ||
          !isPlainClick(event, props.target) ||
          !routeTransitionsEnabled() ||
          !isRouteModuleLoaded(to)
        ) {
          return;
        }
        event.preventDefault();
        markSharedArtwork(event.currentTarget, to.split(/[?#]/)[0]);
        void navigate(to, {
          state: props.state,
          replace: props.replace ?? to === location.pathname + location.search + location.hash,
          preventScrollReset: props.preventScrollReset,
          viewTransition: true,
        });
      }}
      onPointerEnter={(event) => {
        onPointerEnter?.(event);
        if (event.pointerType !== "touch") schedule();
      }}
      onPointerLeave={(event) => {
        onPointerLeave?.(event);
        if (event.pointerType !== "touch") cancel();
      }}
      onFocus={(event) => {
        onFocus?.(event);
        prefetch();
      }}
      onTouchStart={(event) => {
        onTouchStart?.(event);
        schedule();
      }}
      onTouchMove={(event) => {
        onTouchMove?.(event);
        cancel();
      }}
      onTouchEnd={(event) => {
        onTouchEnd?.(event);
        if (timerRef.current) prefetch();
      }}
    />
  );
});

export function OptionalLink({ link, children, ...props }) {
  if (!link?.to) {
    const { className } = props;
    return <span className={className}>{children}</span>;
  }
  return (
    <RouteLink to={link.to} state={link.state} {...props}>
      {children}
    </RouteLink>
  );
}

export default RouteLink;
