import { createHash } from "node:crypto";
import { solidPng } from "../runtime.mjs";

const PLACE = { city: "Portland", state: "Oregon", stateCode: "OR", postalCode: "97205", latitude: 45.5202, longitude: -122.6742 };
const VENUES = ["Lab Ballroom", "Synthetic Theater", "Fixture Hall"];

export function createConcerts(catalog, { ticketmasterApiKey }) {
  const id = (seed) => createHash("sha1").update(`ticketmaster:${seed}`).digest("hex").slice(0, 16);
  const images = (seed) => [
    { ratio: "16_9", url: `https://s1.ticketm.net/dam/a/lab/${id(seed)}_RETINA_LANDSCAPE_16_9.png`, width: 1136, height: 639 },
    { ratio: "4_3", url: `https://s1.ticketm.net/dam/a/lab/${id(seed)}_CUSTOM.png`, width: 305, height: 225 },
  ];
  const events = (center) => {
    const today = new Date();
    return catalog.artists.map((artist, index) => {
      const date = new Date(today);
      date.setUTCDate(date.getUTCDate() + 7 + index * 9);
      const venue = VENUES[index % VENUES.length];
      return {
        id: id(`${artist.id}:event`),
        name: `${artist.name} Live`,
        type: "event",
        url: `https://www.ticketmaster.com/event/${id(`${artist.id}:event`)}`,
        images: images(`${artist.id}:event`),
        dates: { start: { localDate: date.toISOString().slice(0, 10), localTime: "20:00:00" }, status: { code: "onsale" } },
        classifications: [{ segment: { name: "Music" }, genre: { name: artist.genres[0] } }],
        _embedded: {
          venues: [{
            id: id(`venue:${venue}`),
            name: venue,
            postalCode: PLACE.postalCode,
            city: { name: PLACE.city },
            state: { name: PLACE.state, stateCode: PLACE.stateCode },
            country: { name: "United States Of America", countryCode: "US" },
            location: { latitude: String(center.latitude + index * 0.01), longitude: String(center.longitude - index * 0.01) },
          }],
          attractions: [{ id: id(`${artist.id}:attraction`), name: artist.name, url: `https://www.ticketmaster.com/artist/${id(`${artist.id}:attraction`)}`, images: images(`${artist.id}:attraction`) }],
        },
      };
    });
  };

  const handle = ({ method, url, host }) => {
    if (method !== "GET") return null;
    if (host === "s1.ticketm.net") return { status: 200, raw: solidPng(url.pathname, 160), headers: { "content-type": "image/png" } };
    if (host === "api.zippopotam.us") {
      const zip = /^\/us\/(\d{5})$/.exec(url.pathname)?.[1];
      if (!zip) return { status: 404, body: {} };
      return {
        status: 200,
        body: {
          "post code": zip,
          country: "United States",
          "country abbreviation": "US",
          places: [{ "place name": PLACE.city, state: PLACE.state, "state abbreviation": PLACE.stateCode, latitude: String(PLACE.latitude), longitude: String(PLACE.longitude) }],
        },
      };
    }
    if (host === "nominatim.openstreetmap.org" && url.pathname === "/search") {
      const postcode = url.searchParams.get("postalcode") || PLACE.postalCode;
      return {
        status: 200,
        body: [{ lat: String(PLACE.latitude), lon: String(PLACE.longitude), display_name: `${PLACE.city}, ${PLACE.state}`, address: { city: PLACE.city, state: PLACE.state, postcode, country_code: "us" } }],
      };
    }
    if (host === "ipapi.co" && /^\/([\d.:a-f]+\/)?json\/?$/i.test(url.pathname)) {
      return {
        status: 200,
        body: { city: PLACE.city, region: PLACE.state, region_code: PLACE.stateCode, country_code: "US", postal: PLACE.postalCode, latitude: PLACE.latitude, longitude: PLACE.longitude },
      };
    }
    if (host === "app.ticketmaster.com" && url.pathname === "/discovery/v2/events.json") {
      if (url.searchParams.get("apikey") !== ticketmasterApiKey) {
        return { status: 401, body: { fault: { faultstring: "Invalid ApiKey", detail: { errorcode: "oauth.v2.InvalidApiKey" } } } };
      }
      const [latitude, longitude] = String(url.searchParams.get("latlong") || "").split(",").map(Number);
      const center = Number.isFinite(latitude) && Number.isFinite(longitude) ? { latitude, longitude } : PLACE;
      const keyword = String(url.searchParams.get("keyword") || "").toLowerCase();
      const found = events(center).filter((event) => !keyword || event.name.toLowerCase().includes(keyword));
      const size = Number(url.searchParams.get("size")) || 20;
      return {
        status: 200,
        body: {
          ...(found.length ? { _embedded: { events: found.slice(0, size) } } : {}),
          page: { size, totalElements: found.length, totalPages: Math.ceil(found.length / size), number: 0 },
        },
      };
    }
    return null;
  };
  return { name: "concerts", hosts: ["app.ticketmaster.com", "s1.ticketm.net", "api.zippopotam.us", "nominatim.openstreetmap.org", "ipapi.co"], handle };
}
