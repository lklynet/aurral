const PATH_CAPABILITIES = [
  { prefix: "/library/playlists", capability: "flows" },
  { prefix: "/flows", capability: "flows" },
  { prefix: "/playlists", capability: "flows" },
  { prefix: "/flow", capability: "flows" },
  { prefix: "/activity/missing", capability: "flows" },
  { prefix: "/library", capability: "localLibrary" },
];

const pathMatches = (pathname, prefix) => pathname === prefix || pathname.startsWith(`${prefix}/`);

export function hasAppCapability(capabilities, capability) {
  return capabilities?.[capability] !== false;
}

export function filterByCapabilities(items, capabilities) {
  return (Array.isArray(items) ? items : []).filter((item) =>
    (item.requiredCapabilities || []).every((capability) =>
      hasAppCapability(capabilities, capability),
    ),
  );
}

export function getCapabilityForPath(pathname) {
  const normalizedPath = String(pathname || "").split(/[?#]/, 1)[0] || "/";
  return PATH_CAPABILITIES.find(({ prefix }) => pathMatches(normalizedPath, prefix))?.capability || null;
}

export function getUnavailableRouteRedirect(pathname, capabilities) {
  const capability = getCapabilityForPath(pathname);
  return capability && !hasAppCapability(capabilities, capability) ? "/" : null;
}
