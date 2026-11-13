import { test, vi } from "vite-plus/test";
import { testClient } from "hono/testing";
import assert from "node:assert/strict";
import { http } from "../../lib/http.ts";

import showsApp, {
  buildShowsResponseCacheKey,
} from "../../backend/routes/discovery/handlers/shows.ts";
import { dbOps } from "../../backend/db/helpers/index.ts";
import { reloadDiscoveryPersistedCache } from "../../backend/services/discovery/persistence.ts";
import { signedInAs } from "../helpers/honoApp.ts";
import { testUser } from "../helpers/userFixtures.ts";
import {
  getArtistShows,
  getNearbyShows,
  rememberNearbyLocation,
} from "../../backend/services/nearbyShowsService.ts";

const withTicketmasterKey = (t: import("vite-plus/test").TestContext) => {
  const original = process.env.TICKETMASTER_API_KEY;
  process.env.TICKETMASTER_API_KEY = "test-ticketmaster-key";
  t.onTestFinished(() => {
    if (original === undefined) delete process.env.TICKETMASTER_API_KEY;
    else process.env.TICKETMASTER_API_KEY = original;
  });
};

const ticketmasterEvent = (id: string, date: string, performers: string[]) => ({
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
    recommendedArtists: [{ name: "Recommended Artist" }, { name: "Another Recommended Artist" }],
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

test("matches event performers to library and Discover artists by name", async (t: import("vite-plus/test").TestContext) => {
  withTicketmasterKey(t);
  vi.spyOn(http, "get").mockImplementation(async (url) => {
    if (url.includes("zippopotam")) {
      return {
        status: 200,
        statusText: "OK",
        headers: {},
        data: {
          places: [{ "place name": "Austin", latitude: "30.1", longitude: "-97.1" }],
        },
      };
    }
    if (url.includes("ticketmaster.com")) {
      return {
        status: 200,
        statusText: "OK",
        headers: {},
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

test("looks up the server location for private, invalid, or spoofed client addresses", async () => {
  const lookups: string[] = [];
  vi.spyOn(http, "get").mockImplementation(async (url) => {
    lookups.push(url);
    return {
      status: 200,
      statusText: "OK",
      headers: {},
      data: { city: "Somewhere", latitude: 40.2, longitude: -74.2 },
    };
  });

  const spoofedRequest = { headers: { "x-forwarded-for": "203.0.113.9" }, ip: "192.168.1.20" };
  await getNearbyShows({ req: spoofedRequest });
  await getNearbyShows({ req: { ip: "10.0.0.5" } });
  await getNearbyShows({ req: { ip: "../../json" } });
  await getNearbyShows({ req: { ip: "fe90::1" } });
  await getNearbyShows({ req: { ip: "100.101.102.103" } });
  await getNearbyShows({ req: { ip: "::ffff:198.51.100.7" } });

  assert.deepEqual(lookups, ["https://ipapi.co/json/", "https://ipapi.co/198.51.100.7/json/"]);
});

test("marks an unresolved postal code instead of returning a normal empty location", async () => {
  vi.spyOn(http, "get").mockImplementation(async (url) => {
    assert.equal(url, "https://nominatim.openstreetmap.org/search");
    return { status: 200, statusText: "OK", headers: {}, data: [] };
  });

  const result = await getNearbyShows({ zipCode: "M5V" });

  assert.equal(result.location.resolved, false);
  assert.deepEqual([...result.shows], []);
});

test("uses an explicit country when resolving an ambiguous postal code", async () => {
  let nominatimParams: Record<string, string | number | boolean | null | undefined> | undefined;
  vi.spyOn(http, "get").mockImplementation(async (url, options = {}) => {
    if (url.includes("zippopotam"))
      return { status: 200, statusText: "OK", headers: {}, data: { places: [] } };
    if (url === "https://nominatim.openstreetmap.org/search") {
      nominatimParams = options.query;
      return {
        status: 200,
        statusText: "OK",
        headers: {},
        data: [
          {
            address: { city: "Paris", country_code: "fr" },
            lat: "48.8566",
            lon: "2.3522",
          },
        ],
      };
    }
    throw new Error(`Unexpected request: ${url}`);
  });

  const result = await getNearbyShows({ zipCode: "75001", countryCode: "FR" });

  assert.ok(nominatimParams != null);
  assert.equal(nominatimParams.postalcode, "75001");
  assert.ok(nominatimParams != null);
  assert.equal(nominatimParams.countrycodes, "fr");
  assert.equal(result.location.city, "Paris");
  assert.equal(result.location.countryCode, "FR");
});

const ok = (data: unknown) => ({ status: 200, statusText: "OK", headers: {}, data });

test("looks up a postal code in the requester's country when no country is given", async () => {
  vi.spyOn(http, "get").mockImplementation(async (url, options = {}) => {
    if (url.startsWith("https://ipapi.co/")) return ok({ country_code: "DE" });
    if (url.includes("zippopotam")) {
      return ok({ places: [{ "place name": "New York", latitude: "40.7", longitude: "-74" }] });
    }
    if (url === "https://nominatim.openstreetmap.org/search") {
      return ok(
        options.query?.countrycodes === "de"
          ? [{ address: { city: "Berlin", country_code: "de" }, lat: "52.53", lon: "13.38" }]
          : [],
      );
    }
    throw new Error(`Unexpected request: ${url}`);
  });

  const result = await getNearbyShows({ req: { ip: "198.51.100.20" }, zipCode: "10115" });

  assert.equal(result.location.city, "Berlin");
  assert.equal(result.location.countryCode, "DE");
});

test("finds a postal code outside the requester's country", async () => {
  vi.spyOn(http, "get").mockImplementation(async (url) => {
    if (url.startsWith("https://ipapi.co/")) return ok({ country_code: "DE" });
    if (url.includes("zippopotam")) {
      return ok({
        places: [{ "place name": "Beverly Hills", latitude: "34.09", longitude: "-118.41" }],
      });
    }
    if (url === "https://nominatim.openstreetmap.org/search") return ok([]);
    throw new Error(`Unexpected request: ${url}`);
  });

  const result = await getNearbyShows({ req: { ip: "198.51.100.21" }, zipCode: "90210" });

  assert.equal(result.location.city, "Beverly Hills");
  assert.equal(result.location.countryCode, "US");
});

test("searches Ticketmaster by postal code when the location has no coordinates", async (t: import("vite-plus/test").TestContext) => {
  withTicketmasterKey(t);
  vi.spyOn(http, "get").mockImplementation(async (url, options = {}) => {
    if (url.startsWith("https://ipapi.co/")) {
      return ok({ city: "Berlin", postal: "10115", country_code: "DE" });
    }
    if (url.includes("ticketmaster.com")) {
      if (String(options.query?.sort).startsWith("distance") && !options.query?.latlong) {
        throw new Error('Query param "latlong" is required for sorting by distance');
      }
      const events =
        options.query?.postalCode === "10115"
          ? [ticketmasterEvent("berlin", "2026-11-03", ["Library Band"])]
          : [];
      return ok({ _embedded: { events } });
    }
    throw new Error(`Unexpected request: ${url}`);
  });

  const result = await getNearbyShows({
    req: { ip: "198.51.100.22" },
    libraryArtists: [{ name: "Library Band" }],
  });

  assert.deepEqual(
    result.shows.map(({ id }) => id),
    ["berlin"],
  );
});

test("matches shows from every Ticketmaster results page in the near and later date windows", async (t: import("vite-plus/test").TestContext) => {
  withTicketmasterKey(t);
  const windowStarts: unknown[] = [];
  const requestedPages: [number, number][] = [];
  vi.spyOn(http, "get").mockImplementation(async (url, options = {}) => {
    if (url.includes("zippopotam")) {
      return ok({
        places: [{ "place name": "Daytona Beach", latitude: "29.2", longitude: "-81.0" }],
      });
    }
    if (url.includes("ticketmaster.com")) {
      const start = options.query?.startDateTime;
      if (!windowStarts.includes(start)) windowStarts.push(start);
      const window = windowStarts.indexOf(start);
      const page = Number(options.query?.page);
      requestedPages.push([window, page]);
      if (window === 1) {
        return ok({
          _embedded: {
            events: [
              ticketmasterEvent("festival", "2027-05-07", ["Library Band", "Far Band"]),
              ticketmasterEvent("far", "2026-11-05", ["Far Band"]),
            ],
          },
          page: { number: 0, totalPages: 1 },
        });
      }
      const events = [
        [ticketmasterEvent("nearby", "2026-11-03", ["Library Band"])],
        [ticketmasterEvent("filler", "2026-11-04", ["Someone Else"])],
        [ticketmasterEvent("far", "2026-11-05", ["Far Band"])],
      ][page];
      return ok({ _embedded: { events }, page: { number: page, totalPages: 3 } });
    }
    throw new Error(`Unexpected request: ${url}`);
  });

  const result = await getNearbyShows({
    zipCode: "32114",
    libraryArtists: [{ name: "Library Band" }, { name: "Far Band" }],
  });

  assert.deepEqual(
    result.shows.map(({ id }) => id),
    ["nearby", "far", "festival"],
  );
  assert.deepEqual(requestedPages, [
    [0, 0],
    [0, 1],
    [0, 2],
    [1, 0],
  ]);
});

test("matches shows for every recommended and trending artist, not just the top of the list", async (t: import("vite-plus/test").TestContext) => {
  withTicketmasterKey(t);
  const recommended = Array.from({ length: 30 }, (_, index) => `Recommended ${index + 1}`);
  const trending = Array.from({ length: 20 }, (_, index) => `Trending ${index + 1}`);
  dbOps.updateDiscoveryCache({
    recommendations: recommended.map((name) => ({ name })),
    globalTop: trending.map((name) => ({ name })),
  });
  reloadDiscoveryPersistedCache();
  vi.spyOn(http, "get").mockImplementation(async (url) => {
    if (url.includes("zippopotam")) {
      return ok({ places: [{ "place name": "Chicago", latitude: "41.88", longitude: "-87.62" }] });
    }
    if (url.includes("ticketmaster.com")) {
      return ok({
        _embedded: {
          events: [...recommended, ...trending].map((name) =>
            ticketmasterEvent(name, "2026-11-03", [name]),
          ),
        },
      });
    }
    throw new Error(`Unexpected request: ${url}`);
  });

  const response = await testClient(signedInAs(testUser(31)).route("/", showsApp))[
    "nearby-shows"
  ].$get({ query: { zip: "60601", country: "US" } });
  const body = await response.json();
  assert.ok("shows" in body);

  assert.deepEqual(
    body.shows.flatMap(({ artistNames }) => artistNames).sort(),
    [...recommended, ...trending].sort(),
  );
});

test("lists an artist's own dates and pins the nearest one within the search radius", async (t: import("vite-plus/test").TestContext) => {
  withTicketmasterKey(t);
  rememberNearbyLocation(7, { zipCode: "97201", countryCode: "US", ip: "" });
  const keywords: unknown[] = [];
  const tourDate = (
    id: string,
    date: string,
    performer: string,
    [latitude, longitude]: number[],
  ) => ({
    ...ticketmasterEvent(id, date, [performer]),
    _embedded: {
      venues: [
        { name: id, location: { latitude: String(latitude), longitude: String(longitude) } },
      ],
      attractions: [{ name: performer }],
    },
  });
  vi.spyOn(http, "get").mockImplementation(async (url, options = {}) => {
    if (url.includes("zippopotam")) {
      return ok({
        places: [{ "place name": "Portland", latitude: "45.52", longitude: "-122.68" }],
      });
    }
    if (url.includes("ticketmaster.com")) {
      keywords.push(options.query?.keyword);
      const events =
        options.query?.page === 0
          ? [
              tourDate("san-francisco", "2027-03-01", "Radiohead", [37.77, -122.42]),
              tourDate("tribute", "2027-03-01", "Radiohead Tribute", [45.52, -122.68]),
              tourDate("seattle", "2027-03-02", "Radiohead", [47.61, -122.33]),
            ]
          : [tourDate("portland", "2027-03-05", "Radiohead", [45.52, -122.68])];
      return ok({ _embedded: { events }, page: { totalPages: 2 } });
    }
    throw new Error(`Unexpected request: ${url}`);
  });

  const located = await getArtistShows(7, "Radiohead");
  const unlocated = await getArtistShows(8, "Radiohead");

  assert.deepEqual(
    located.map(({ id, distance, near }) => [id, distance, near]),
    [
      ["portland", 0, true],
      ["san-francisco", 536, false],
      ["seattle", 145, false],
    ],
  );
  assert.deepEqual(
    unlocated.map(({ id, distance, near }) => [id, distance, near]),
    [
      ["san-francisco", null, false],
      ["seattle", null, false],
      ["portland", null, false],
    ],
  );
  assert.deepEqual(keywords, ["Radiohead", "Radiohead"]);
});
