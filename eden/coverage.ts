import type { integrationSettingsSchema } from "../backend/db/helpers/integrationSettings.ts";
import type { ServiceName } from "./services/index.ts";

type Coverage = { by: ServiceName | "core" } | { missing: string };

// What in Eden exercises each integration Aurral has settings for. "core" is part of
// every Eden. A new integration fails the typecheck here until it has an entry: a
// service that covers it, or the reason Eden can't.
export const integrationCoverage = {
  webhooks: { by: "webhooks" },
  lastfm: { by: "core" },
  slskd: { by: "slskd" },
  prowlarr: { by: "prowlarr" },
  nzbget: { by: "nzbget" },
  sabnzbd: { by: "sabnzbd" },
  qbittorrent: { by: "qbittorrent" },
  ytdlp: { by: "core" },
  ticketmaster: { by: "core" },
  metadata: { by: "core" },
  musicbrainz: { by: "core" },
  general: { by: "core" },
  tidarr: { missing: "Tidarr downloads from a paid Tidal account" },
  deemix: { missing: "deemix downloads from a Deezer account" },
  google: { missing: "Google sign-in needs a Google account" },
  news: { missing: "Aurral reads news feeds from the real sites, past Eden's proxy" },
} satisfies Record<keyof (typeof integrationSettingsSchema)["entries"], Coverage>;

// Plex has no settings key of its own: it is a history server and a playlist target.
export const notCovered = [
  ...Object.entries(integrationCoverage).flatMap(([name, coverage]) =>
    "missing" in coverage ? [`${name}: ${coverage.missing}`] : [],
  ),
  "plex: Plex needs a plex.tv account",
];
