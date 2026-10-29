import { forwardRef, useCallback } from "react";
import { Link, useLocation, useNavigate, type LinkProps, type Location } from "react-router";

export const SETTINGS_PARAM = "settings";

type SettingsHistory = { depth: number; from: string | null };
type SettingsLocation = Pick<Location, "pathname" | "search" | "hash" | "state">;

function readHistory(state: unknown): SettingsHistory {
  if (typeof state !== "object" || state === null) return { depth: 0, from: null };
  return {
    depth:
      "settingsDepth" in state && typeof state.settingsDepth === "number" ? state.settingsDepth : 0,
    from:
      "settingsFrom" in state && typeof state.settingsFrom === "string" ? state.settingsFrom : null,
  };
}

const withHistory = (state: unknown, history: SettingsHistory) => ({
  ...(typeof state === "object" && state !== null ? state : {}),
  settingsDepth: history.depth,
  settingsFrom: history.from,
});

export const readSettingsPath = (search: string) => new URLSearchParams(search).get(SETTINGS_PARAM);

export function withoutSettingsParam(search: string) {
  const params = new URLSearchParams(search);
  params.delete(SETTINGS_PARAM);
  return params.toString();
}

function settingsTarget(location: SettingsLocation, path: string | null) {
  const params = new URLSearchParams(location.search);
  if (path === null) params.delete(SETTINGS_PARAM);
  else params.set(SETTINGS_PARAM, path);
  const search = params.toString();
  return { pathname: location.pathname, search: search ? `?${search}` : "", hash: location.hash };
}

const parentSettingsPath = (path: string) =>
  path.includes("/") ? path.split("/")[0] : path ? "" : null;

const settingsStep = (
  location: SettingsLocation,
  path: string | null,
  history: SettingsHistory,
  replace = true,
) => ({
  to: settingsTarget(location, path),
  replace,
  state: withHistory(location.state, history),
});

export function openSettings(location: SettingsLocation, path: string) {
  const current = readSettingsPath(location.search);
  const history = readHistory(location.state);
  if (current === null) return settingsStep(location, path, { depth: 1, from: null }, false);
  if (parentSettingsPath(path) === current && path !== current) {
    const depth = history.depth === 0 ? 0 : history.depth + 1;
    return settingsStep(location, path, { depth, from: current }, false);
  }
  return settingsStep(location, path, history);
}

export function closeSettings(location: SettingsLocation) {
  const { depth } = readHistory(location.state);
  return depth > 0 ? -depth : settingsStep(location, null, { depth: 0, from: null });
}

export function backSettings(location: SettingsLocation) {
  const path = readSettingsPath(location.search);
  const parent = path === null ? null : parentSettingsPath(path);
  if (parent === null) return null;
  const history = readHistory(location.state);
  return history.from === parent ? -1 : settingsStep(location, parent, history);
}

export function useSettingsRoute() {
  const location = useLocation();
  const navigate = useNavigate();
  const path = readSettingsPath(location.search);

  const go = useCallback(
    (step: number | ReturnType<typeof settingsStep> | null) => {
      if (typeof step === "number") navigate(step);
      else if (step) navigate(step.to, { replace: step.replace, state: step.state });
    },
    [navigate],
  );

  const open = useCallback(
    (nextPath: string) => go(openSettings(location, nextPath)),
    [go, location],
  );
  const close = useCallback(() => go(closeSettings(location)), [go, location]);
  const back = useCallback(() => go(backSettings(location)), [go, location]);

  return { path, open, close, back };
}

type SettingsLinkProps = Omit<LinkProps, "to" | "replace" | "state"> & { to: string };

export const SettingsLink = forwardRef<HTMLAnchorElement, SettingsLinkProps>(function SettingsLink(
  { to, ...props },
  ref,
) {
  const location = useLocation();
  const step = openSettings(location, to);
  return <Link ref={ref} to={step.to} replace={step.replace} state={step.state} {...props} />;
});
