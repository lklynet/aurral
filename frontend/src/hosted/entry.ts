import { hostedBuildPath } from "../../../lib/hostedBuild.ts";
import { activeServer, normalizeAddress, reloadWhenServerChanges } from "../utils/server.ts";
import { checkServer } from "./checkServer.ts";
import type { HostedScreen } from "./screens.tsx";

const show = (screen: HostedScreen) =>
  import("./screens.tsx").then(({ mountScreen }) => mountScreen(screen));

const pairScreen = (): HostedScreen => {
  const fragment = window.location.hash.slice(1);
  const dot = fragment.indexOf(".");
  const address = dot > 0 ? normalizeAddress(fragment.slice(dot + 1)) : null;
  window.history.replaceState(null, "", "/pair");
  return address ? { kind: "pair", code: fragment.slice(0, dot), address } : { kind: "connect" };
};

const loadBuild = async (version: string) => {
  const response = await fetch(hostedBuildPath(version));
  if (!response.ok) return false;
  const page = new DOMParser().parseFromString(await response.text(), "text/html");
  document.documentElement.dataset.aurralBuild = version;
  for (const source of page.head.querySelectorAll(
    'link[rel="stylesheet"], link[rel="modulepreload"], script[type="module"]',
  )) {
    const node = document.createElement(source.tagName);
    for (const { name, value } of source.attributes) node.setAttribute(name, value);
    document.head.append(node);
  }
  return true;
};

const start = async () => {
  if (window.location.pathname === "/pair") {
    window.addEventListener("hashchange", () => window.location.reload(), { once: true });
    return show(pairScreen());
  }
  if (window.location.pathname === "/connect" || !activeServer) return show({ kind: "connect" });
  const { address } = activeServer;
  const server = await checkServer(address).catch(() => null);
  if (!server) return show({ kind: "unreachable", address });
  if (server.onboardingRequired || !server.authRequired) {
    return show({ kind: "ownAddress", address, setup: server.onboardingRequired });
  }
  if (server.version === import.meta.env.VITE_APP_VERSION) {
    reloadWhenServerChanges();
    return import("../main.tsx");
  }
  const loaded =
    !document.documentElement.dataset.aurralBuild &&
    (await loadBuild(server.version).catch(() => false));
  if (!loaded) {
    return show({ kind: "unsupported", address, version: server.version });
  }
};

void start();
