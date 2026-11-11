import { deezer } from "./deezer.ts";
import { lastfm } from "./lastfm.ts";
import { listenbrainz } from "./listenbrainz.ts";
import { appleCharts, lrclib, places, ticketmaster } from "./local.ts";
import type { Outside } from "./music.ts";
import { musicbrainz } from "./musicbrainz.ts";

// Every outside service Eden answers for. A host that is not here gets a 502.
export const outsideByHost = new Map<string, Outside>(
  [appleCharts, deezer, lastfm, listenbrainz, lrclib, musicbrainz, places, ticketmaster].flatMap(
    (service) => service.hosts.map((host) => [host, service]),
  ),
);
