import { BlockList, isIP } from "node:net";
import axios from "../../lib/axiosFetch.js";
import createCache from "./apiClients/simpleCache.js";
import { getTicketmasterApiKey } from "./apiClients/index.js";
import { runSharedInflight } from "./sharedInflight.js";

const ticketmasterEventCache = createCache(15 * 60);
const ipLocationCache = createCache(30 * 60);
const zipLocationCache = createCache(24 * 60 * 60);
const nearbyShowsResponseCache = createCache(5 * 60, 100);
const nearbyShowsInflight = new Map();

const DEFAULT_RADIUS_MILES = 250;
const MAX_EVENT_RESULTS = 200;
const TICKETMASTER_BASE_URL = "https://app.ticketmaster.com/discovery/v2";

const toArtistKey = (value) =>
  String(value || "")
    .normalize("NFKD")
    .replace(/\p{M}/gu, "")
    .toLowerCase()
    .replace(/&/g, " and ")
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .trim()
    .replace(/^the /, "")
    .replace(/ /g, "");

const sanitizeZipCode = (value) =>
  String(value || "")
    .trim()
    .replace(/[^a-zA-Z0-9 -]/g, "")
    .slice(0, 12);

const isLikelyUsZip = (value) => /^\d{5}(-\d{4})?$/.test(String(value || "").trim());

const normalizeUsZip = (value) =>
  String(value || "")
    .trim()
    .split("-")[0];

const sanitizeCountryCode = (value) => {
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
]) {
  nonPublicAddresses.addSubnet(network, prefix, "ipv4");
}
for (const [network, prefix] of [
  ["::", 128],
  ["::1", 128],
  ["fc00::", 7],
  ["fe80::", 10],
]) {
  nonPublicAddresses.addSubnet(network, prefix, "ipv6");
}

const getPublicRequestIp = (req) => {
  const ip = String(req?.ip || "").trim().replace(/^::ffff:/i, "").toLowerCase();
  const family = isIP(ip);
  if (!family) return "";
  return nonPublicAddresses.check(ip, family === 6 ? "ipv6" : "ipv4") ? "" : ip;
};

const buildLocationLabel = (location) =>
  [location.city, location.regionCode || location.region, location.countryCode]
    .filter(Boolean)
    .join(", ") ||
  location.postalCode ||
  "Your area";

const selectImage = (images = []) => {
  if (!Array.isArray(images) || images.length === 0) return null;
  for (const ratio of ["16_9", "3_2", "4_3"]) {
    const match = images
      .filter((image) => image?.ratio === ratio && image?.url)
      .sort((a, b) => (b.width || 0) - (a.width || 0))[0];
    if (match?.url) return match.url;
  }
  return images.find((image) => image?.url)?.url || null;
};

const toEventRecord = (event) => {
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
    distance: Number.isFinite(event?.distance) ? event.distance : null,
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

const getTicketmasterLocationParams = (location, radiusMiles) => {
  const latitude = Number(location.latitude);
  const longitude = Number(location.longitude);
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
      sort: "distance,asc",
    };
  }
  throw new Error("Unable to determine a search location");
};

const resolveZipLocation = async (zipCode, countryCode) => {
  const zip = sanitizeZipCode(zipCode);
  if (!zip) return null;
  const normalizedCountryCode = sanitizeCountryCode(countryCode);
  const normalizedZip = isLikelyUsZip(zip) ? normalizeUsZip(zip) : zip;
  const cacheKey = `${normalizedCountryCode || "auto"}:${normalizedZip}`;
  const cached = zipLocationCache.get(cacheKey);
  if (cached) return cached;
  return runSharedInflight(nearbyShowsInflight, `zip:${cacheKey}`, async (signal) => {
    try {
      if (isLikelyUsZip(normalizedZip) && (!normalizedCountryCode || normalizedCountryCode === "US")) {
        const response = await axios.get(
          `https://api.zippopotam.us/us/${encodeURIComponent(normalizedZip)}`,
          {
            timeout: 5000,
            headers: {
              Accept: "application/json",
              "User-Agent": "Aurral/1.0 (+https://github.com/leekelly/aurral)",
            },
            signal,
          },
        );
        const place = response.data?.places?.[0];
        if (place) {
          const location = {
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
      const response = await axios.get("https://nominatim.openstreetmap.org/search", {
        params: {
          postalcode: normalizedZip,
          countrycodes:
            normalizedCountryCode?.toLowerCase() ||
            (isLikelyUsZip(normalizedZip) ? "us" : undefined),
          format: "jsonv2",
          addressdetails: 1,
          limit: 1,
        },
        timeout: 6000,
        headers: {
          Accept: "application/json",
          "User-Agent": "Aurral/1.0 (+https://github.com/leekelly/aurral)",
        },
        signal,
      });
      const result = Array.isArray(response.data) ? response.data[0] : null;
      if (!result) return null;
      const address = result.address || {};
      const location = {
        source: "zip",
        resolved: true,
        postalCode: normalizedZip,
        city: address.city || address.town || address.village || null,
        region: address.state || null,
        regionCode: null,
        countryCode: address.country_code
          ? String(address.country_code).toUpperCase()
          : normalizedCountryCode || null,
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

const resolveIpLocation = async (publicIp) => {
  const cacheKey = publicIp || "server";
  const cached = ipLocationCache.get(cacheKey);
  if (cached) return cached;
  const endpoint = publicIp ? `/${publicIp}/json/` : "/json/";
  return runSharedInflight(nearbyShowsInflight, `ip:${cacheKey}`, async (signal) => {
    const response = await axios.get(`https://ipapi.co${endpoint}`, {
      timeout: 5000,
      headers: {
        Accept: "application/json",
        "User-Agent": "Aurral/1.0 (+https://github.com/leekelly/aurral)",
      },
      signal,
    });
    if (response.data?.error) {
      throw new Error(response.data.reason || "IP lookup failed");
    }
    const location = {
      source: "ip",
      resolved: true,
      postalCode: sanitizeZipCode(response.data?.postal),
      city: response.data?.city || null,
      region: response.data?.region || null,
      regionCode: response.data?.region_code || null,
      countryCode: response.data?.country_code || null,
      latitude: response.data?.latitude != null ? Number(response.data.latitude) : null,
      longitude: response.data?.longitude != null ? Number(response.data.longitude) : null,
    };
    location.label = buildLocationLabel(location);
    ipLocationCache.set(cacheKey, location);
    return location;
  });
};

const fetchTicketmasterEvents = async ({ location, radiusMiles }) => {
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
    const response = await axios.get(`${TICKETMASTER_BASE_URL}/events.json`, {
      params: {
        apikey: apiKey,
        classificationName: "music",
        size: MAX_EVENT_RESULTS,
        locale: "*",
        includeTBA: "no",
        includeTBD: "no",
        source: "ticketmaster",
        ...buildDateRange(),
        ...getTicketmasterLocationParams(location, radiusMiles),
      },
      timeout: 10000,
      signal,
    });
    const events = (response.data?._embedded?.events || [])
      .filter((event) => event?.id)
      .map(toEventRecord)
      .filter((event) => event.performerKeys.length > 0);
    ticketmasterEventCache.set(cacheKey, events);
    return events;
  });
};

const buildArtistMap = (artistsBySource) => {
  const map = new Map();
  for (const [sourceType, artists] of artistsBySource) {
    for (const artist of artists || []) {
      const name = String(artist?.artistName || artist?.name || "").trim();
      const key = toArtistKey(name);
      if (key && !map.has(key)) map.set(key, { name, sourceType });
    }
  }
  return map;
};

const matchShows = (events, artistMap) => {
  const shows = [];
  for (const { performerKeys, ...event } of events) {
    const matches = new Map();
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

const sortShows = (shows) =>
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
}) => {
  const sanitizedZipCode = sanitizeZipCode(zipCode);
  const sanitizedCountryCode = sanitizeCountryCode(countryCode);
  const publicIp = sanitizedZipCode ? "" : getPublicRequestIp(req);
  const locationKey = sanitizedZipCode
    ? `${sanitizedCountryCode || "auto"}:${sanitizedZipCode}`
    : `ip:${publicIp || "server"}`;
  const resultCacheKey = responseCacheKey
    ? JSON.stringify([responseCacheKey, locationKey, radiusMiles])
    : null;
  const cachedResult = resultCacheKey ? nearbyShowsResponseCache.get(resultCacheKey) : null;
  if (cachedResult) return cachedResult;

  let location;
  if (sanitizedZipCode) {
    location =
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

  const shows = location.resolved === false
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
