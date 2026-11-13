import { deezer } from "./deezer.ts";
import { lastfm } from "./lastfm.ts";
import { listenbrainz } from "./listenbrainz.ts";
import { appleCharts, coverArtArchive, lrclib, places, ticketmaster } from "./local.ts";
import type { Outside } from "./music.ts";
import { musicbrainz } from "./musicbrainz.ts";
import { youtube } from "./youtube.ts";

// Every outside service Eden answers for. A host that is not here gets a 502.
export const outsideByHost = new Map<string, Outside>(
  [
    appleCharts,
    coverArtArchive,
    deezer,
    lastfm,
    listenbrainz,
    lrclib,
    musicbrainz,
    places,
    ticketmaster,
    youtube,
  ].flatMap((service) => service.hosts.map((host) => [host, service])),
);
