import { airsonic, feishin } from "./clients.ts";
import { gotify } from "./gotify.ts";
import { jellyfin } from "./jellyfin.ts";
import { koito } from "./koito.ts";
import { lidarr } from "./lidarr.ts";
import { navidrome } from "./navidrome.ts";
import { plugins } from "./plugins.ts";
import { nzbget } from "./nzbget.ts";
import { prowlarr } from "./prowlarr.ts";
import { qbittorrent } from "./qbittorrent.ts";
import { sabnzbd } from "./sabnzbd.ts";
import type { Service } from "./service.ts";
import { slskd } from "./slskd.ts";
import { sso } from "./sso.ts";
import { webhooks } from "./webhooks.ts";

export const services = {
  navidrome,
  jellyfin,
  koito,
  prowlarr,
  nzbget,
  sabnzbd,
  qbittorrent,
  slskd,
  gotify,
  webhooks,
  plugins,
  lidarr,
  sso,
  feishin,
  airsonic,
} satisfies Record<string, Service>;

export type ServiceName = keyof typeof services;

export const isService = (name: string): name is ServiceName => Object.hasOwn(services, name);

export const serviceNames = Object.keys(services).filter(isService);

// The asked-for services plus everything they need, in the order they must be set up.
export function withNeeds(names: Iterable<ServiceName>) {
  const ordered: ServiceName[] = [];
  const visit = (name: ServiceName) => {
    if (ordered.includes(name)) return;
    const service: Service = services[name];
    for (const need of service.needs ?? []) {
      if (isService(need)) visit(need);
    }
    ordered.push(name);
  };
  for (const name of names) visit(name);
  return ordered;
}
