import { forwardRef, useEffect, useRef, type MouseEvent, type ReactNode } from "react";
import { Link, useLocation, useNavigate, type LinkProps, type To } from "react-router";
import { useOptionalAuth } from "../contexts/AuthContext";
import { isRouteModuleLoaded, prefetchRoute } from "../navigation/routePrefetch.ts";
import { markSharedArtwork, routeTransitionsEnabled } from "../navigation/viewTransitions.ts";

const HOVER_INTENT_MS = 100;

const isPlainClick = (event: MouseEvent<HTMLAnchorElement>, target: string | undefined) =>
  event.button === 0 &&
  !event.defaultPrevented &&
  !event.metaKey &&
  !event.ctrlKey &&
  !event.shiftKey &&
  !event.altKey &&
  (!target || target === "_self");

const RouteLink = forwardRef<HTMLAnchorElement, LinkProps>(function RouteLink(
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
  const userId = useOptionalAuth()?.user?.id ?? null;
  const navigate = useNavigate();
  const location = useLocation();
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const cancel = () => {
    if (timerRef.current) clearTimeout(timerRef.current);
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

  useEffect(
    () => () => {
      if (timerRef.current) clearTimeout(timerRef.current);
    },
    [],
  );

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

type OptionalLinkProps = Omit<LinkProps, "to"> & {
  link?: { to: To; state?: unknown } | null;
  children?: ReactNode;
};

export function OptionalLink({ link, children, ...props }: OptionalLinkProps) {
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
