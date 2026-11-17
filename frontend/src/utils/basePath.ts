export const normalizeBasePath = (baseUrl: string | undefined) => {
  const raw = (baseUrl || "/").trim();
  const withLeadingSlash = raw.startsWith("/") ? raw : `/${raw}`;
  if (withLeadingSlash === "/") return "/";
  return withLeadingSlash.endsWith("/") ? withLeadingSlash.slice(0, -1) : withLeadingSlash;
};

export const normalizeBasePathWithTrailingSlash = (baseUrl: string | undefined) => {
  const raw = (baseUrl || "/").trim();
  const withLeadingSlash = raw.startsWith("/") ? raw : `/${raw}`;
  return withLeadingSlash.endsWith("/") ? withLeadingSlash : `${withLeadingSlash}/`;
};

export const getAppBasePath = () =>
  normalizeBasePath(import.meta.env.VITE_BASE_PATH || import.meta.env.BASE_URL);

export const stripBasePath = (pathname: string, base: string) =>
  base === "/" ? pathname : pathname.slice(base.length) || "/";

export const getAppRoutePath = () =>
  stripBasePath(window.location.pathname, getAppBasePath()) + window.location.search;
