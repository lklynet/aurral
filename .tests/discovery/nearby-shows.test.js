import test from "node:test";
import assert from "node:assert/strict";

import { groupShowsByEvent } from "../../backend/services/nearbyShowsService.js";

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
