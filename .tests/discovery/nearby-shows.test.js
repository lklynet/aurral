import test from "node:test";
import assert from "node:assert/strict";
import axios from "../../lib/axiosFetch.js";

import { getNearbyShows, groupShowsByEvent } from "../../backend/services/nearbyShowsService.js";

test("groups artists matched to the same Ticketmaster event", () => {
  const grouped = groupShowsByEvent([
    { id: "event-1", artistName: "Artist A", eventName: "Shared bill" },
    { id: "event-1", artistName: "Artist B", eventName: "Shared bill" },
    { id: "event-1", artistName: "Artist A", eventName: "Shared bill" },
    { id: "event-2", artistName: "Artist C", eventName: "Solo show" },
  ]);

  assert.deepEqual(
    grouped.map(({ id, artistName, artistNames }) => ({ id, artistName, artistNames })),
    [
      { id: "event-1", artistName: "Artist A", artistNames: ["Artist A", "Artist B"] },
      { id: "event-2", artistName: "Artist C", artistNames: ["Artist C"] },
    ],
  );
});

test("marks an unresolved postal code instead of returning a normal empty location", async (t) => {
  t.mock.method(axios, "get", async (url) => {
    assert.equal(url, "https://nominatim.openstreetmap.org/search");
    return { data: [] };
  });

  const result = await getNearbyShows({ zipCode: "M5V" });

  assert.equal(result.location.resolved, false);
  assert.equal(result.total, 0);
  assert.deepEqual(result.shows, []);
});
