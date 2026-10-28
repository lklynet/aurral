import assert from "node:assert/strict";
import { test } from "vite-plus/test";
import {
  buildRecommendedRails,
  matchesFilter,
  recommendationContext,
  recommendationReason,
  sortRecommendedRows,
} from "../../frontend/src/pages/recommendedRails.ts";

const DAY = 24 * 60 * 60 * 1000;
const now = Date.parse("2026-10-28T12:00:00.000Z");
const seenDaysAgo = (days: number) => new Date(now - days * DAY).toISOString();
const basedOn = ["Slowdive", "Mitski", "Burial"].map((name) => ({ name }));

const pick = (
  name: string,
  seeds: string[],
  {
    depth = 1,
    seen = 30,
    sources = seeds,
  }: { depth?: number; seen?: number; sources?: string[] } = {},
) => ({
  name,
  supportingSeeds: seeds.map((artistName) => ({ artistName })),
  sourceArtists: sources,
  discoveryDepth: depth,
  firstDiscoveredAt: seenDaysAgo(seen),
});

const names = (artists: { name: string }[]) => artists.map((artist) => artist.name);

test("rails give each pick one place, grouped by your own seeds, and only later refreshes are new", () => {
  const recommendations = [
    pick("Top", ["Slowdive", "Mitski"]),
    pick("Fresh", ["Slowdive"], { seen: 2 }),
    ...["A", "B", "C", "D"].map((name) => pick(`Slowdive ${name}`, ["Ride", "Slowdive"])),
    ...["A", "B", "C", "D", "E"].map((name) => pick(`Burial ${name}`, ["Burial"])),
    ...["A", "B", "C"].map((name) => pick(`Mitski ${name}`, ["Mitski"])),
    pick("Bridged", ["Four Tet"], { depth: 2 }),
  ];

  const rails = buildRecommendedRails(
    recommendations,
    recommendationContext(recommendations, basedOn, now),
  );

  assert.equal(rails.topPick?.name, "Top");
  assert.deepEqual(names(rails.fresh), ["Fresh"]);
  assert.deepEqual(
    rails.seedRails.map(({ seed, artists }) => [seed, artists.length]),
    [
      ["Burial", 5],
      ["Slowdive", 4],
    ],
  );
  assert.deepEqual(names(rails.closeToHome), ["Mitski A", "Mitski B", "Mitski C"]);
  assert.deepEqual(names(rails.furtherOut), ["Bridged"]);
  const placed = [
    rails.topPick,
    ...rails.fresh,
    ...rails.seedRails.flatMap((rail) => rail.artists),
    ...rails.closeToHome,
    ...rails.furtherOut,
  ];
  assert.deepEqual(names(placed).sort(), names(recommendations).sort());

  const firstRefresh = recommendations.map((artist) => ({
    ...artist,
    firstDiscoveredAt: seenDaysAgo(1),
  }));
  assert.deepEqual(
    buildRecommendedRails(firstRefresh, recommendationContext(firstRefresh, basedOn, now)).fresh,
    [],
  );
});

test("the full list names only your own seeds and sorts newest first", () => {
  const recommendations = [
    pick("Old direct", ["Slowdive"], { seen: 40 }),
    pick("New bridged", ["Grouper"], { depth: 2, seen: 1 }),
    pick("New direct", ["Ride", "Slowdive"], { seen: 1, sources: ["Ride", "Slowdive", "Mitski"] }),
  ];
  const context = recommendationContext(recommendations, basedOn, now);
  const rows = recommendations.map((artist, index) => ({ artist, rank: index + 1 }));
  const shown = (filter: Parameters<typeof matchesFilter>[1]) =>
    rows.filter((row) => matchesFilter(row.artist, filter, context)).map((row) => row.artist.name);

  assert.deepEqual(shown({ kind: "new" }), ["New bridged", "New direct"]);
  assert.deepEqual(shown({ kind: "further" }), ["New bridged"]);
  assert.deepEqual(shown({ kind: "seed", value: "Slowdive" }), ["Old direct", "New direct"]);
  assert.deepEqual(shown({ kind: "seed", value: "Ride" }), []);
  assert.deepEqual(
    sortRecommendedRows(rows, { key: "seen", direction: "desc" }).map((row) => row.rank),
    [2, 3, 1],
  );
  assert.deepEqual(
    recommendations.map((artist) => recommendationReason(artist, context.seeds)),
    ["like Slowdive", "via Grouper", "like Slowdive, Mitski"],
  );
});
