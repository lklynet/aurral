import * as v from "valibot";
import { BlockList, isIP } from "node:net";
import { isDeepStrictEqual } from "node:util";
import { http } from "../../lib/http.ts";
import { dbOps } from "../db/helpers/index.ts";
import createCache from "./apiClients/simpleCache.ts";
import { getTicketmasterApiKey } from "./apiClients/index.ts";
import { runSharedInflight, type InflightRequests } from "./sharedInflight.ts";
import { readMany, readOne } from "./integrationData.ts";

type NearbyLocation = {
  source: string;
  resolved: boolean;
  postalCode: string | null;
  city: string | null;
  region: string | null;
  regionCode: string | null;
  countryCode: string | null;
  latitude: number | null;
  longitude: number | null;
  label?: string;
};

const optionalString = v.optional(v.string());
const coordinateSchema = v.nullish(v.union([v.number(), v.string()]));

const imageSchema = v.looseObject({
  ratio: optionalString,
  url: optionalString,
  width: v.optional(v.number()),
});
const imagesSchema = v.optional(v.array(imageSchema));

const ticketmasterEventSchema = v.looseObject({
  id: optionalString,
  name: optionalString,
  url: optionalString,
  images: imagesSchema,
  distance: v.optional(v.number()),
  dates: v.optional(
    v.looseObject({
      start: v.optional(
        v.looseObject({
          localDate: optionalString,
          localTime: optionalString,
          dateTime: optionalString,
        }),
      ),
    }),
  ),
  _embedded: v.optional(
    v.looseObject({
      attractions: v.optional(
        v.array(v.looseObject({ name: optionalString, url: optionalString, images: imagesSchema })),
      ),
      venues: v.optional(
        v.array(
          v.looseObject({
            name: optionalString,
            city: v.optional(v.looseObject({ name: optionalString })),
            state: v.optional(v.looseObject({ stateCode: optionalString, name: optionalString })),
            country: v.optional(v.looseObject({ countryCode: optionalString })),
          }),
        ),
      ),
    }),
  ),
});

const ticketmasterPageSchema = v.looseObject({
  _embedded: v.optional(v.looseObject({ events: v.optional(v.array(v.unknown())) })),
  page: v.optional(v.looseObject({ totalPages: v.optional(v.number()) })),
});

const zipLookupSchema = v.looseObject({
  places: v.optional(
    v.array(
      v.looseObject({
        "place name": optionalString,
        state: optionalString,
        "state abbreviation": optionalString,
        latitude: coordinateSchema,
        longitude: coordinateSchema,
      }),
    ),
  ),
});

const nominatimSearchSchema = v.array(
  v.looseObject({
    lat: coordinateSchema,
    lon: coordinateSchema,
    address: v.optional(
      v.looseObject({
        city: optionalString,
        town: optionalString,
        village: optionalString,
        state: optionalString,
        country_code: optionalString,
      }),
    ),
  }),
);

const ipLookupSchema = v.looseObject({
  error: v.optional(v.unknown()),
  reason: v.nullish(v.string()),
  postal: v.nullish(v.string()),
  city: v.nullish(v.string()),
  region: v.nullish(v.string()),
  region_code: v.nullish(v.string()),
  country_code: v.nullish(v.string()),
  latitude: coordinateSchema,
  longitude: coordinateSchema,
});

type TicketmasterImage = v.InferOutput<typeof imageSchema>;
type TicketmasterEvent = v.InferOutput<typeof ticketmasterEventSchema>;

type ArtistInput = { artistName?: unknown; name?: unknown };

type ArtistSource = "library" | "recommended" | "trending";

const nearbyLocationSchema = v.looseObject({
  zipCode: v.string(),
  countryCode: v.string(),
  ip: v.string(),
});

type NearbyLocationChoice = v.InferOutput<typeof nearbyLocationSchema>;

const nearbyLocationKey = (userId: number) => `user:${userId}:nearbyLocation`;

export const rememberNearbyLocation = (userId: number, choice: NearbyLocationChoice) => {
  const key = nearbyLocationKey(userId);
  if (!isDeepStrictEqual(dbOps.getJSONSetting(key, v.unknown()), choice))
    dbOps.setJSONSetting(key, choice);
};

export const getRememberedNearbyLocation = (userId: number) =>
  dbOps.getJSONSetting(nearbyLocationKey(userId), nearbyLocationSchema);

const ticketmasterEventCache = createCache<ReturnType<typeof toEventRecord>[]>(15 * 60);
const ipLocationCache = createCache<NearbyLocation>(30 * 60);
const zipLocationCache = createCache<NearbyLocation>(24 * 60 * 60);
const nearbyShowsResponseCache = createCache<{
  location: NearbyLocation;
  shows: ReturnType<typeof matchShows>;
}>(5 * 60, 100);
const nearbyShowsInflight: InflightRequests = new Map();

const DEFAULT_RADIUS_MILES = 250;
const EVENT_PAGE_SIZE = 200;
const MAX_EVENT_PAGES = 5;
const TICKETMASTER_BASE_URL = "https://app.ticketmaster.com/discovery/v2";

const toArtistKey = (value: unknown) =>
  String(value || "")
    .normalize("NFKD")
    .replace(/\p{M}/gu, "")
    .toLowerCase()
    .replace(/&/g, " and ")
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .trim()
    .replace(/^the /, "")
    .replace(/ /g, "");

const sanitizeZipCode = (value: unknown) =>
  String(value || "")
    .trim()
    .replace(/[^a-zA-Z0-9 -]/g, "")
    .slice(0, 12);

const isLikelyUsZip = (value: unknown) => /^\d{5}(-\d{4})?$/.test(String(value || "").trim());

const normalizeUsZip = (value: unknown) =>
  String(value || "")
    .trim()
    .split("-")[0] ?? "";

const sanitizeCountryCode = (value: unknown) => {
  const country = String(value || "")
    .trim()
    .replace(/[^a-zA-Z]/g, "")
    .toUpperCase();
  return country.length === 2 ? country : "";
};

const nonPublicAddresses = new BlockList();
for (const [network, prefix] of [
  ["0.0.0.0", 8],
  ["10.0.0.0", 8],
  ["100.64.0.0", 10],
  ["127.0.0.0", 8],
  ["169.254.0.0", 16],
  ["172.16.0.0", 12],
  ["192.168.0.0", 16],
] as const) {
  nonPublicAddresses.addSubnet(network, prefix, "ipv4");
}
for (const [network, prefix] of [
  ["::", 128],
  ["::1", 128],
  ["fc00::", 7],
  ["fe80::", 10],
] as const) {
  nonPublicAddresses.addSubnet(network, prefix, "ipv6");
}

const getPublicRequestIp = (req: { ip?: string } | undefined) => {
  const ip = String(req?.ip || "")
    .trim()
    .replace(/^::ffff:/i, "")
    .toLowerCase();
  const family = isIP(ip);
  if (!family) return "";
  return nonPublicAddresses.check(ip, family === 6 ? "ipv6" : "ipv4") ? "" : ip;
};

const buildLocationLabel = (location: NearbyLocation) =>
  [location.city, location.regionCode || location.region, location.countryCode]
    .filter(Boolean)
    .join(", ") ||
  location.postalCode ||
  "Your area";

const selectImage = (images: TicketmasterImage[] = []) => {
  if (!Array.isArray(images) || images.length === 0) return null;
  for (const ratio of ["16_9", "3_2", "4_3"]) {
    const match = images
      .filter((image) => image?.ratio === ratio && image?.url)
      .sort((a, b) => (b.width || 0) - (a.width || 0))[0];
    if (match?.url) return match.url;
  }
  return images.find((image) => image?.url)?.url || null;
};

const toEventRecord = (event: TicketmasterEvent & { id: string }) => {
  const attractions = Array.isArray(event?._embedded?.attractions)
    ? event._embedded.attractions
    : [];
  const venue = event?._embedded?.venues?.[0] || {};
  const start = event?.dates?.start || {};
  return {
    id: event?.id,
    eventName: event?.name || null,
    image:
      selectImage(event?.images) ||
      attractions.map((attraction) => selectImage(attraction?.images)).find(Boolean) ||
      null,
    url: event?.url || attractions.find((attraction) => attraction?.url)?.url || null,
    date: start.localDate || null,
    time: start.localTime || null,
    dateTime: start.dateTime || null,
    venueName: venue.name || null,
    city: venue.city?.name || null,
    region: venue.state?.stateCode || venue.state?.name || venue.country?.countryCode || null,
    distance:
      typeof event.distance === "number" && Number.isFinite(event.distance) ? event.distance : null,
    performerKeys: [
      ...new Set(attractions.map((attraction) => toArtistKey(attraction?.name)).filter(Boolean)),
    ],
  };
};

const buildDateRange = () => {
  const start = new Date();
  const end = new Date(start);
  end.setDate(end.getDate() + 90);
  return {
    startDateTime: `${start.toISOString().split(".")[0]}Z`,
    endDateTime: `${end.toISOString().split(".")[0]}Z`,
  };
};

const getTicketmasterLocationParams = (location: NearbyLocation, radiusMiles: number) => {
  const { latitude, longitude } = location;
  if (Number.isFinite(latitude) && Number.isFinite(longitude)) {
    return {
      latlong: `${latitude},${longitude}`,
      radius: radiusMiles,
      unit: "miles",
      sort: "distance,asc",
    };
  }
  if (location.postalCode) {
    const postalCode =
      location.countryCode === "US" ? normalizeUsZip(location.postalCode) : location.postalCode;
    return {
      postalCode,
      countryCode: location.countryCode || undefined,
      radius: radiusMiles,
      unit: "miles",
    };
  }
  throw new Error("Unable to determine a search location");
};

const resolveZipLocation = async (zipCode: unknown, countryCode: unknown) => {
  const zip = sanitizeZipCode(zipCode);
  if (!zip) return null;
  const normalizedCountryCode = sanitizeCountryCode(countryCode);
  const normalizedZip = isLikelyUsZip(zip) ? normalizeUsZip(zip) : zip;
  const cacheKey = `${normalizedCountryCode || "auto"}:${normalizedZip}`;
  const cached = zipLocationCache.get(cacheKey);
  if (cached) return cached;
  return runSharedInflight(nearbyShowsInflight, `zip:${cacheKey}`, async (signal) => {
    try {
      if (
        isLikelyUsZip(normalizedZip) &&
        (!normalizedCountryCode || normalizedCountryCode === "US")
      ) {
        const response = await http.get(
          `https://api.zippopotam.us/us/${encodeURIComponent(normalizedZip)}`,
          {
            timeoutMs: 5000,
            headers: {
              Accept: "application/json",
              "User-Agent": "Aurral/1.0 (+https://github.com/lklynet/aurral)",
            },
            signal,
          },
        );
        const place = readOne(zipLookupSchema, response.data, {
          service: "Zippopotam",
          endpoint: "/us",
        }).places?.[0];
        if (place) {
          const location: NearbyLocation = {
            source: "zip",
            resolved: true,
            postalCode: normalizedZip,
            city: place["place name"] || null,
            region: place.state || null,
            regionCode: place["state abbreviation"] || null,
            countryCode: "US",
            latitude: place.latitude != null ? Number(place.latitude) : null,
            longitude: place.longitude != null ? Number(place.longitude) : null,
          };
          location.label = buildLocationLabel(location);
          zipLocationCache.set(cacheKey, location);
          return location;
        }
      }
    } catch {}
    try {
      const response = await http.get("https://nominatim.openstreetmap.org/search", {
        query: {
          postalcode: normalizedZip,
          countrycodes:
            normalizedCountryCode?.toLowerCase() ||
            (isLikelyUsZip(normalizedZip) ? "us" : undefined),
          format: "jsonv2",
          addressdetails: 1,
          limit: 1,
        },
        timeoutMs: 6000,
        headers: {
          Accept: "application/json",
          "User-Agent": "Aurral/1.0 (+https://github.com/lklynet/aurral)",
        },
        signal,
      });
      const [result] = readOne(nominatimSearchSchema, response.data, {
        service: "Nominatim",
        endpoint: "/search",
      });
      if (!result) return null;
      const address = result.address ?? {};
      const location: NearbyLocation = {
        source: "zip",
        resolved: true,
        postalCode: normalizedZip,
        city: address.city || address.town || address.village || null,
        region: address.state || null,
        regionCode: null,
        countryCode: address.country_code?.toUpperCase() || normalizedCountryCode || null,
        latitude: result.lat != null ? Number(result.lat) : null,
        longitude: result.lon != null ? Number(result.lon) : null,
      };
      location.label = buildLocationLabel(location);
      zipLocationCache.set(cacheKey, location);
      return location;
    } catch {
      return null;
    }
  });
};

const resolveIpLocation = async (publicIp: string) => {
  const cacheKey = publicIp || "server";
  const cached = ipLocationCache.get(cacheKey);
  if (cached) return cached;
  const endpoint = publicIp ? `/${publicIp}/json/` : "/json/";
  return runSharedInflight(nearbyShowsInflight, `ip:${cacheKey}`, async (signal) => {
    const response = await http.get(`https://ipapi.co${endpoint}`, {
      timeoutMs: 5000,
      headers: {
        Accept: "application/json",
        "User-Agent": "Aurral/1.0 (+https://github.com/lklynet/aurral)",
      },
      signal,
    });
    const data = readOne(ipLookupSchema, response.data, { service: "ipapi", endpoint });
    if (data.error) {
      throw new Error(data.reason || "IP lookup failed");
    }
    const location: NearbyLocation = {
      source: "ip",
      resolved: true,
      postalCode: sanitizeZipCode(data.postal),
      city: data.city || null,
      region: data.region || null,
      regionCode: data.region_code || null,
      countryCode: data.country_code || null,
      latitude: data.latitude != null ? Number(data.latitude) : null,
      longitude: data.longitude != null ? Number(data.longitude) : null,
    };
    location.label = buildLocationLabel(location);
    ipLocationCache.set(cacheKey, location);
    return location;
  });
};

const fetchTicketmasterEvents = async ({
  location,
  radiusMiles,
}: {
  location: NearbyLocation;
  radiusMiles: number;
}) => {
  const apiKey = getTicketmasterApiKey();
  if (!apiKey) return [];
  const cacheKey = JSON.stringify({
    postalCode: location.postalCode || null,
    countryCode: location.countryCode || null,
    latitude: location.latitude || null,
    longitude: location.longitude || null,
    radiusMiles,
  });
  const cached = ticketmasterEventCache.get(cacheKey);
  if (cached) return cached;
  return runSharedInflight(nearbyShowsInflight, `events:${cacheKey}`, async (signal) => {
    const params = {
      apikey: apiKey,
      classificationName: "music",
      size: EVENT_PAGE_SIZE,
      locale: "*",
      includeTBA: "no",
      includeTBD: "no",
      ...buildDateRange(),
      ...getTicketmasterLocationParams(location, radiusMiles),
    };
    const listedEvents: TicketmasterEvent[] = [];
    for (let page = 0; page < MAX_EVENT_PAGES; page++) {
      const response = await http.get(`${TICKETMASTER_BASE_URL}/events.json`, {
        query: { ...params, page },
        timeoutMs: 10000,
        signal,
      });
      const source = { service: "Ticketmaster", endpoint: "/events.json" };
      const data = readOne(ticketmasterPageSchema, response.data, source);
      listedEvents.push(...readMany(ticketmasterEventSchema, data._embedded?.events ?? [], source));
      if (page + 1 >= (data.page?.totalPages ?? 0)) break;
    }
    const events = listedEvents
      .filter((event): event is TicketmasterEvent & { id: string } => Boolean(event?.id))
      .map(toEventRecord)
      .filter((event: ReturnType<typeof toEventRecord>) => event.performerKeys.length > 0);
    ticketmasterEventCache.set(cacheKey, events);
    return events;
  });
};

const buildArtistMap = (artistsBySource: [ArtistSource, ArtistInput[] | undefined][]) => {
  const map = new Map<string, { name: string; sourceType: ArtistSource }>();
  for (const [sourceType, artists] of artistsBySource) {
    for (const artist of artists || []) {
      const name = String(artist?.artistName || artist?.name || "").trim();
      const key = toArtistKey(name);
      if (key && !map.has(key)) map.set(key, { name, sourceType });
    }
  }
  return map;
};

const matchShows = (
  events: ReturnType<typeof toEventRecord>[],
  artistMap: ReturnType<typeof buildArtistMap>,
) => {
  const shows = [];
  for (const { performerKeys, ...event } of events) {
    const matches = new Map<string, ArtistSource>();
    for (const key of performerKeys) {
      const match = artistMap.get(key);
      if (match) matches.set(match.name, match.sourceType);
    }
    if (matches.size === 0) continue;
    shows.push({
      ...event,
      artistNames: [...matches.keys()],
      sourceTypes: [...new Set(matches.values())],
    });
  }
  return shows;
};

const sortShows = <
  Show extends { dateTime: string | null; date: string | null; distance: number | null },
>(
  shows: Show[],
) =>
  shows.sort((a, b) => {
    const aTime = a.dateTime || a.date || "";
    const bTime = b.dateTime || b.date || "";
    if (aTime !== bTime) return aTime.localeCompare(bTime);
    return (a.distance ?? Number.POSITIVE_INFINITY) - (b.distance ?? Number.POSITIVE_INFINITY);
  });

export const getNearbyShows = async ({
  req,
  zipCode,
  countryCode,
  libraryArtists = [],
  recommendedArtists = [],
  trendingArtists = [],
  radiusMiles = DEFAULT_RADIUS_MILES,
  responseCacheKey = null,
}: {
  req?: { ip?: string };
  zipCode?: unknown;
  countryCode?: unknown;
  libraryArtists?: ArtistInput[];
  recommendedArtists?: ArtistInput[];
  trendingArtists?: ArtistInput[];
  radiusMiles?: number;
  responseCacheKey?: string | null;
}): Promise<{ location: NearbyLocation; shows: ReturnType<typeof matchShows> }> => {
  const sanitizedZipCode = sanitizeZipCode(zipCode);
  const sanitizedCountryCode = sanitizeCountryCode(countryCode);
  const publicIp = getPublicRequestIp(req);
  const locationKey = sanitizedZipCode
    ? `${sanitizedCountryCode || `auto:${publicIp || "server"}`}:${sanitizedZipCode}`
    : `ip:${publicIp || "server"}`;
  const resultCacheKey = responseCacheKey
    ? JSON.stringify([responseCacheKey, locationKey, radiusMiles])
    : null;
  const cachedResult = resultCacheKey ? nearbyShowsResponseCache.get(resultCacheKey) : null;
  if (cachedResult) return cachedResult;

  let location: NearbyLocation;
  if (sanitizedZipCode) {
    const localCountryCode = sanitizedCountryCode
      ? ""
      : await resolveIpLocation(publicIp).then(
          (ipLocation) => sanitizeCountryCode(ipLocation.countryCode),
          () => "",
        );
    location = (localCountryCode &&
      (await resolveZipLocation(sanitizedZipCode, localCountryCode))) ||
      (await resolveZipLocation(sanitizedZipCode, sanitizedCountryCode)) || {
        source: "zip",
        resolved: false,
        postalCode: sanitizedZipCode,
        city: null,
        region: null,
        regionCode: null,
        countryCode: sanitizedCountryCode || (isLikelyUsZip(sanitizedZipCode) ? "US" : null),
        latitude: null,
        longitude: null,
        label: sanitizedZipCode,
      };
  } else {
    location = await resolveIpLocation(publicIp);
  }

  const shows =
    location.resolved === false
      ? []
      : sortShows(
          matchShows(
            await fetchTicketmasterEvents({ location, radiusMiles }),
            buildArtistMap([
              ["library", libraryArtists],
              ["recommended", recommendedArtists],
              ["trending", trendingArtists],
            ]),
          ),
        );
  const result = { location, shows };
  if (resultCacheKey) nearbyShowsResponseCache.set(resultCacheKey, result);
  return result;
};
