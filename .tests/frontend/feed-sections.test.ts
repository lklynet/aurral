import { test } from "vite-plus/test";
import assert from "node:assert/strict";

import { newsDayLabel, splitFeed } from "../../frontend/src/utils/feedSections.ts";

const item = (id: string, group: string, featured = false) => ({ id, group, featured });
const ids = (items: { id: string }[]) => items.map(({ id }) => id);
const groupOf = (entry: { group: string }) => entry.group;
const isFeatured = (entry: { featured: boolean }) => entry.featured;

test("splitFeed leads with the first featured item, shelves the next eight, and groups the rest", () => {
  const items = [
    item("a", "Today"),
    item("b", "Today", true),
    ...Array.from({ length: 9 }, (_, index) => item(`t${index}`, "Today")),
    item("y", "Yesterday", true),
  ];
  const { lead, shelf, groups } = splitFeed(items, groupOf, isFeatured);
  assert.equal(lead?.id, "b");
  assert.deepEqual(ids(shelf), ["a", "t0", "t1", "t2", "t3", "t4", "t5", "t6"]);
  assert.deepEqual(
    groups.map((group) => [group.label, ids(group.items)]),
    [
      ["Today", ["t7", "t8"]],
      ["Yesterday", ["y"]],
    ],
  );
});

test("splitFeed falls back to the first item and skips a shelf with too few items", () => {
  const { lead, shelf, groups } = splitFeed(
    [item("a", "November"), item("b", "November"), item("c", "December")],
    groupOf,
    isFeatured,
  );
  assert.equal(lead?.id, "a");
  assert.deepEqual(shelf, []);
  assert.deepEqual(
    groups.map((group) => [group.label, ids(group.items)]),
    [
      ["November", ["b"]],
      ["December", ["c"]],
    ],
  );
  assert.equal(splitFeed([], groupOf).lead, undefined);
  const pastFirstPage = splitFeed(
    [item("a", "Today"), item("b", "Today"), item("c", "Today", true)],
    groupOf,
    (entry, index) => index < 2 && entry.featured,
  );
  assert.equal(pastFirstPage.lead?.id, "a");
});

test("newsDayLabel buckets by calendar day", () => {
  const now = new Date(2026, 10, 6, 9, 0);
  const at = (day: number, hour: number) => new Date(2026, 10, day, hour).toISOString();
  assert.equal(newsDayLabel(at(6, 1), now), "Today");
  assert.equal(newsDayLabel(at(5, 23), now), "Yesterday");
  assert.equal(newsDayLabel(at(1, 12), now), "This week");
  assert.equal(newsDayLabel(at(-10, 12), now), "Earlier");
  assert.equal(newsDayLabel("not a date", now), "Earlier");
});
