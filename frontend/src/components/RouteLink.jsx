import { forwardRef, useEffect, useRef } from "react";
import { Link } from "react-router";
import { useAuth } from "../contexts/AuthContext";
import { prefetchRoute } from "../navigation/routePrefetch.js";

const HOVER_INTENT_MS = 100;

const RouteLink = forwardRef(function RouteLink(
  { to, onPointerEnter, onPointerLeave, onFocus, onTouchStart, onTouchMove, onTouchEnd, ...props },
  ref,
) {
  const userId = useAuth()?.user?.id ?? null;
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
