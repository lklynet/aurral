import test from "node:test";
import assert from "node:assert/strict";
import axios from "../../lib/axiosFetch.js";

import { buildShowsResponseCacheKey } from "../../backend/routes/discovery/handlers/shows.js";
import { getNearbyShows } from "../../backend/services/nearbyShowsService.js";

const withTicketmasterKey = (t) => {
  const original = process.env.TICKETMASTER_API_KEY;
  process.env.TICKETMASTER_API_KEY = "test-ticketmaster-key";
  t.after(() => {
    if (original === undefined) delete process.env.TICKETMASTER_API_KEY;
    else process.env.TICKETMASTER_API_KEY = original;
  });
};

const ticketmasterEvent = (id, date, performers) => ({
  id,
  name: `${performers.join(" + ")} live`,
  url: `https://www.ticketmaster.com/event/${id}`,
  dates: { start: { localDate: date } },
  _embedded: {
    venues: [{ name: "Venue", city: { name: "Austin" } }],
    attractions: performers.map((name) => ({ name })),
  },
});

test("includes all artist inputs in the shows response cache key", () => {
  const base = {
    userId: 1,
    libraryArtists: [{ name: "Library Artist" }],
    recommendedArtists: [
      { name: "Recommended Artist" },
      { name: "Another Recommended Artist" },
    ],
    trendingArtists: [{ name: "Trending Artist" }],
  };
  const key = buildShowsResponseCacheKey(base);

  assert.notEqual(
    buildShowsResponseCacheKey({
      ...base,
      libraryArtists: [{ name: "Different Library Artist" }],
    }),
    key,
  );
  assert.notEqual(
    buildShowsResponseCacheKey({
      ...base,
      recommendedArtists: [{ name: "Different Recommended Artist" }],
    }),
    key,
  );
  assert.notEqual(
    buildShowsResponseCacheKey({
      ...base,
      trendingArtists: [{ name: "Different Trending Artist" }],
    }),
    key,
  );
  assert.equal(
    buildShowsResponseCacheKey({
      ...base,
      recommendedArtists: [...base.recommendedArtists].reverse(),
    }),
    key,
  );
});

test("matches event performers to library and Discover artists by name", async (t) => {
  withTicketmasterKey(t);
  t.mock.method(axios, "get", async (url) => {
    if (url.includes("zippopotam")) {
      return {
        data: {
          places: [{ "place name": "Austin", latitude: "30.1", longitude: "-97.1" }],
        },
      };
    }
    if (url.includes("ticketmaster.com")) {
      return {
        data: {
          _embedded: {
            events: [
              ticketmasterEvent("shared-bill", "2026-11-03", ["Library Band", "Recommended Act"]),
              ticketmasterEvent("accented", "2026-11-02", ["Bjork"]),
              ticketmasterEvent("punctuation", "2026-11-01", ["AC/DC"]),
              ticketmasterEvent("longer-name", "2026-11-04", ["Genesis Owusu"]),
              ticketmasterEvent("tribute", "2026-11-05", ["The Beatles Tribute"]),
              ticketmasterEvent("trending", "2026-11-06", ["The Trending Artist"]),
            ],
          },
        },
      };
    }
    throw new Error(`Unexpected request: ${url}`);
  });

  const result = await getNearbyShows({
    zipCode: "78702",
    libraryArtists: [
      { name: "Library Band" },
      { name: "ACDC" },
      { name: "Björk" },
      { name: "Genesis" },
      { name: "The Beatles" },
    ],
    recommendedArtists: [{ artistName: "Recommended Act" }],
    trendingArtists: [{ name: "Trending Artist" }],
  });

  assert.deepEqual(
    result.shows.map(({ id, artistNames, sourceTypes }) => ({ id, artistNames, sourceTypes })),
    [
      { id: "punctuation", artistNames: ["ACDC"], sourceTypes: ["library"] },
      { id: "accented", artistNames: ["Björk"], sourceTypes: ["library"] },
      {
        id: "shared-bill",
        artistNames: ["Library Band", "Recommended Act"],
        sourceTypes: ["library", "recommended"],
      },
      { id: "trending", artistNames: ["Trending Artist"], sourceTypes: ["trending"] },
    ],
  );
});

test("looks up the server location for private, invalid, or spoofed client addresses", async (t) => {
  const lookups = [];
  t.mock.method(axios, "get", async (url) => {
    lookups.push(url);
    return { data: { city: "Somewhere", latitude: 40.2, longitude: -74.2 } };
  });

  await getNearbyShows({
    req: { headers: { "x-forwarded-for": "203.0.113.9" }, ip: "192.168.1.20" },
  });
  await getNearbyShows({ req: { ip: "10.0.0.5" } });
  await getNearbyShows({ req: { ip: "../../json" } });
  await getNearbyShows({ req: { ip: "::ffff:198.51.100.7" } });

  assert.deepEqual(lookups, [
    "https://ipapi.co/json/",
    "https://ipapi.co/198.51.100.7/json/",
  ]);
});

test("marks an unresolved postal code instead of returning a normal empty location", async (t) => {
  t.mock.method(axios, "get", async (url) => {
    assert.equal(url, "https://nominatim.openstreetmap.org/search");
    return { data: [] };
  });

  const result = await getNearbyShows({ zipCode: "M5V" });

  assert.equal(result.location.resolved, false);
  assert.deepEqual(result.shows, []);
});

test("uses an explicit country when resolving an ambiguous postal code", async (t) => {
  let nominatimParams;
  t.mock.method(axios, "get", async (url, options = {}) => {
    if (url.includes("zippopotam")) return { data: { places: [] } };
    if (url === "https://nominatim.openstreetmap.org/search") {
      nominatimParams = options.params;
      return {
        data: [{
          address: { city: "Paris", country_code: "fr" },
          lat: "48.8566",
          lon: "2.3522",
        }],
      };
    }
    throw new Error(`Unexpected request: ${url}`);
  });

  const result = await getNearbyShows({ zipCode: "75001", countryCode: "FR" });

  assert.equal(nominatimParams.postalcode, "75001");
  assert.equal(nominatimParams.countrycodes, "fr");
  assert.equal(result.location.city, "Paris");
  assert.equal(result.location.countryCode, "FR");
});

test("reuses a cached shows response without rebuilding artist maps", async (t) => {
  let artistReads = 0;
  t.mock.method(axios, "get", async (url) => {
    if (url.includes("zippopotam")) {
      return {
        data: {
          places: [{ "place name": "Austin", latitude: "30.2672", longitude: "-97.7431" }],
        },
      };
    }
    return { data: { _embedded: { events: [] } } };
  });

  const options = {
    zipCode: "78701",
    responseCacheKey: "user-1",
    libraryArtists: {
      [Symbol.iterator]() {
        artistReads += 1;
        return [][Symbol.iterator]();
      },
    },
  };
  const first = await getNearbyShows(options);
  const second = await getNearbyShows(options);

  assert.strictEqual(second, first);
  assert.equal(artistReads, 1);
});
