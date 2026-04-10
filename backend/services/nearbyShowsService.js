import axios from "axios";
import NodeCache from "node-cache";
import { getTicketmasterApiKey } from "./apiClients.js";

const ticketmasterEventCache = new NodeCache({
  stdTTL: 15 * 60,
  checkperiod: 60,
  maxKeys: 200,
});

const ipLocationCache = new NodeCache({
  stdTTL: 30 * 60,
  checkperiod: 120,
  maxKeys: 500,
});

const zipLocationCache = new NodeCache({
  stdTTL: 24 * 60 * 60,
  checkperiod: 10 * 60,
  maxKeys: 1000,
});

const DEFAULT_RADIUS_MILES = 50;
const MAX_EVENT_RESULTS = 200;
const DEFAULT_SHOW_LIMIT = 18;
const MAX_SHOW_LIMIT = 60;
const TICKETMASTER_BASE_URL = "https://app.ticketmaster.com/discovery/v2";

const normalizeArtistKey = (value) =>
  String(value || "")
    .toLowerCase()
    .replace(/&/g, " and ")
    .replace(/[^a-z0-9]+/g, " ")
    .trim();

const sanitizeZipCode = (value) =>
  String(value || "")
    .trim()
    .replace(/[^a-zA-Z0-9 -]/g, "")
    .slice(0, 12);

const isLikelyUsZip = (value) =>
  /^\d{5}(-\d{4})?$/.test(String(value || "").trim());

const normalizeUsZip = (value) =>
  String(value || "")
    .trim()
    .split("-")[0];

const sanitizeIpAddress = (value) => {
  const raw = String(value || "").trim();
  if (!raw) return "";
  if (raw === "::1") return "127.0.0.1";
  if (raw.startsWith("::ffff:")) return raw.slice(7);
  return raw;
};

const isPrivateIpAddress = (value) => {
  const ip = sanitizeIpAddress(value);
  if (!ip) return true;
  if (ip.includes(":")) {
    return ip === "::1" || ip.startsWith("fc") || ip.startsWith("fd");
  }
  if (
    ip === "127.0.0.1" ||
    ip === "0.0.0.0" ||
    ip.startsWith("10.") ||
    ip.startsWith("192.168.") ||
    /^172\.(1[6-9]|2\d|3[0-1])\./.test(ip)
  ) {
    return true;
  }
  return false;
};

const getForwardedIp = (req) => {
  const forwarded = req.headers["x-forwarded-for"];
  if (typeof forwarded === "string" && forwarded.trim()) {
    return forwarded.split(",")[0].trim();
  }
  if (Array.isArray(forwarded) && forwarded.length > 0) {
    return String(forwarded[0] || "").trim();
  }
  return sanitizeIpAddress(req.ip);
};

const buildLocationLabel = (location) =>
  [location.city, location.regionCode || location.region, location.countryCode]
    .filter(Boolean)
    .join(", ") ||
  location.postalCode ||
  "Your area";

const selectImage = (images = []) => {
  if (!Array.isArray(images) || images.length === 0) return null;
  const preferredRatios = ["16_9", "3_2", "4_3"];
  for (const ratio of preferredRatios) {
    const match = images
      .filter((image) => image?.ratio === ratio && image?.url)
      .sort((a, b) => (b.width || 0) - (a.width || 0))[0];
    if (match?.url) return match.url;
  }
  return images.find((image) => image?.url)?.url || null;
};

const parseVenueLocation = (event) => {
  const venue = event?._embedded?.venues?.[0] || {};
  const city = venue.city?.name || venue.city || null;
  const region =
    venue.state?.stateCode ||
    venue.state?.name ||
    venue.country?.countryCode ||
    null;
  return {
    venueName: venue.name || null,
    city,
    region,
    countryCode: venue.country?.countryCode || null,
    postalCode: venue.postalCode || null,
    latitude:
      venue.location?.latitude != null
        ? Number(venue.location.latitude)
        : venue.latitude != null
          ? Number(venue.latitude)
          : null,
    longitude:
      venue.location?.longitude != null
        ? Number(venue.location.longitude)
        : venue.longitude != null
          ? Number(venue.longitude)
          : null,
  };
};

const extractEventArtists = (event) => {
  const attractions = Array.isArray(event?._embedded?.attractions)
    ? event._embedded.attractions
    : [];
  const unique = new Map();
  for (const attraction of attractions) {
    const name = String(attraction?.name || "").trim();
    if (!name) continue;
    const key = normalizeArtistKey(name);
    if (!key || unique.has(key)) continue;
    unique.set(key, {
      name,
      key,
      ticketmasterAttractionId: attraction.id || null,
      image: selectImage(attraction.images),
      url: attraction.url || null,
    });
  }
  return [...unique.values()];
};

const buildDateRange = () => {
  const start = new Date();
  const end = new Date(start);
  end.setDate(end.getDate() + 90);
  return {
    startDateTime: start.toISOString().split(".")[0] + "Z",
    endDateTime: end.toISOString().split(".")[0] + "Z",
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
      location.countryCode === "US"
        ? normalizeUsZip(location.postalCode)
        : location.postalCode;
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

const resolveZipLocation = async (zipCode) => {
  const zip = sanitizeZipCode(zipCode);
  if (!zip) return null;
  const normalizedZip = isLikelyUsZip(zip) ? normalizeUsZip(zip) : zip;
  const cached = zipLocationCache.get(normalizedZip);
  if (cached) return cached;
  try {
    if (isLikelyUsZip(normalizedZip)) {
      const response = await axios.get(
        `https://api.zippopotam.us/us/${encodeURIComponent(normalizedZip)}`,
        {
          timeout: 5000,
          headers: {
            Accept: "application/json",
            "User-Agent": "Aurral/1.0 (+https://github.com/leekelly/aurral)",
          },
        },
      );
      const place = response.data?.places?.[0];
      if (place) {
        const location = {
          source: "zip",
          postalCode: normalizedZip,
          city: place["place name"] || null,
          region: place.state || null,
          regionCode: place["state abbreviation"] || null,
          countryCode: "US",
          latitude: place.latitude != null ? Number(place.latitude) : null,
          longitude: place.longitude != null ? Number(place.longitude) : null,
        };
        location.label = buildLocationLabel(location);
        zipLocationCache.set(normalizedZip, location);
        return location;
      }
    }
  } catch {}
  try {
    const response = await axios.get("https://nominatim.openstreetmap.org/search", {
      params: {
        postalcode: normalizedZip,
        countrycodes: isLikelyUsZip(normalizedZip) ? "us" : undefined,
        format: "jsonv2",
        addressdetails: 1,
        limit: 1,
      },
      timeout: 6000,
      headers: {
        Accept: "application/json",
        "User-Agent": "Aurral/1.0 (+https://github.com/leekelly/aurral)",
      },
    });
    const result = Array.isArray(response.data) ? response.data[0] : null;
    if (!result) return null;
    const address = result.address || {};
    const location = {
      source: "zip",
      postalCode: normalizedZip,
      city: address.city || address.town || address.village || null,
      region: address.state || null,
      regionCode: null,
      countryCode: address.country_code ? String(address.country_code).toUpperCase() : null,
      latitude: result.lat != null ? Number(result.lat) : null,
      longitude: result.lon != null ? Number(result.lon) : null,
    };
    location.label = buildLocationLabel(location);
    zipLocationCache.set(normalizedZip, location);
    return location;
  } catch {
    return null;
  }
};

const resolveIpLocation = async (ipAddress) => {
  const ip = sanitizeIpAddress(ipAddress);
  const cacheKey = ip || "caller";
  const cached = ipLocationCache.get(cacheKey);
  if (cached) return cached;
  const endpoint = ip && !isPrivateIpAddress(ip) ? `/${ip}/json/` : "/json/";
  const response = await axios.get(`https://ipapi.co${endpoint}`, {
    timeout: 5000,
    headers: {
      Accept: "application/json",
      "User-Agent": "Aurral/1.0 (+https://github.com/leekelly/aurral)",
    },
  });
  if (response.data?.error) {
    throw new Error(response.data.reason || "IP lookup failed");
  }
  const location = {
    source: "ip",
    postalCode: sanitizeZipCode(response.data?.postal),
    city: response.data?.city || null,
    region: response.data?.region || null,
    regionCode: response.data?.region_code || null,
    countryCode: response.data?.country_code || null,
    latitude:
      response.data?.latitude != null ? Number(response.data.latitude) : null,
    longitude:
      response.data?.longitude != null ? Number(response.data.longitude) : null,
  };
  location.label = buildLocationLabel(location);
  ipLocationCache.set(cacheKey, location);
  return location;
};

const fetchTicketmasterEvents = async ({ location, radiusMiles }) => {
  const apiKey = getTicketmasterApiKey();
  if (!apiKey) {
    return [];
  }
  const cacheKey = JSON.stringify({
    postalCode: location.postalCode || null,
    latitude: location.latitude || null,
    longitude: location.longitude || null,
    radiusMiles,
  });
  const cached = ticketmasterEventCache.get(cacheKey);
  if (cached) return cached;
  const dateRange = buildDateRange();
  const params = {
    apikey: apiKey,
    classificationName: "music",
    size: MAX_EVENT_RESULTS,
    locale: "*",
    includeTBA: "no",
    includeTBD: "no",
    source: "ticketmaster",
    ...dateRange,
    ...getTicketmasterLocationParams(location, radiusMiles),
  };
  const response = await axios.get(`${TICKETMASTER_BASE_URL}/events.json`, {
    params,
    timeout: 10000,
  });
  const events = response.data?._embedded?.events || [];
  ticketmasterEventCache.set(cacheKey, events);
  return events;
};

const buildShowRecord = (event, artist, matchType) => {
  const venue = parseVenueLocation(event);
  const eventImage = selectImage(event.images);
  const localDate = event?.dates?.start?.localDate || null;
  const localTime = event?.dates?.start?.localTime || null;
  const dateTime = event?.dates?.start?.dateTime || null;
  return {
    id: event.id,
    artistName: artist.name,
    matchType,
    eventName: event.name || artist.name,
    ticketmasterAttractionId: artist.ticketmasterAttractionId || null,
    ticketmasterEventId: event.id || null,
    image: eventImage || artist.image || null,
    url: event.url || artist.url || null,
    date: localDate,
    time: localTime,
    dateTime,
    venueName: venue.venueName,
    city: venue.city,
    region: venue.region,
    countryCode: venue.countryCode,
    postalCode: venue.postalCode,
    distance: Number.isFinite(Number(event.distance))
      ? Number(event.distance)
      : null,
    priceRange: Array.isArray(event.priceRanges)
      ? event.priceRanges[0] || null
      : null,
  };
};

export const getNearbyShows = async ({
  req,
  zipCode,
  libraryArtists = [],
  radiusMiles = DEFAULT_RADIUS_MILES,
  limit = DEFAULT_SHOW_LIMIT,
}) => {
  const resolvedLimit = Math.max(
    1,
    Math.min(Number(limit) || DEFAULT_SHOW_LIMIT, MAX_SHOW_LIMIT),
  );
  const sanitizedZipCode = sanitizeZipCode(zipCode);
  const libraryArtistMap = new Map();

  for (const artist of libraryArtists) {
    const name = String(artist?.artistName || artist?.name || "").trim();
    const key = normalizeArtistKey(name);
    if (!key) continue;
    libraryArtistMap.set(key, name);
  }

  let location;
  if (sanitizedZipCode) {
    const resolvedZipLocation = await resolveZipLocation(sanitizedZipCode);
    location = resolvedZipLocation || {
      source: "zip",
      postalCode: sanitizedZipCode,
      city: null,
      region: null,
      regionCode: null,
      countryCode: isLikelyUsZip(sanitizedZipCode) ? "US" : null,
      latitude: null,
      longitude: null,
      label: sanitizedZipCode,
    };
  } else {
    location = await resolveIpLocation(getForwardedIp(req));
  }

  let events = await fetchTicketmasterEvents({ location, radiusMiles });
  if (events.length === 0 && sanitizedZipCode) {
    const zipResolvedLocation = await resolveZipLocation(sanitizedZipCode);
    if (zipResolvedLocation) {
      location = {
        ...zipResolvedLocation,
        source: "zip",
      };
      events = await fetchTicketmasterEvents({ location, radiusMiles });
    }
  }
  const shows = [];
  const seen = new Set();

  for (const event of events) {
    const artists = extractEventArtists(event);
    if (artists.length === 0) continue;
    for (const artist of artists) {
      if (!libraryArtistMap.has(artist.key)) continue;
      const dedupeKey = `${event.id}:${artist.key}`;
      if (seen.has(dedupeKey)) continue;
      seen.add(dedupeKey);
      shows.push(buildShowRecord(event, artist, "library"));
    }
  }

  shows.sort((a, b) => {
    const aTime = a.dateTime || a.date || "";
    const bTime = b.dateTime || b.date || "";
    if (aTime !== bTime) return aTime.localeCompare(bTime);
    const aDistance = Number.isFinite(a.distance)
      ? a.distance
      : Number.POSITIVE_INFINITY;
    const bDistance = Number.isFinite(b.distance)
      ? b.distance
      : Number.POSITIVE_INFINITY;
    return aDistance - bDistance;
  });

  return {
    location,
    shows: shows.slice(0, resolvedLimit),
    total: shows.length,
    counts: {
      libraryArtists: libraryArtistMap.size,
      matchedLibraryShows: shows.filter((show) => show.matchType === "library")
        .length,
    },
  };
};
