import { test } from "vite-plus/test";
import assert from "node:assert/strict";

import { DISCOVER_SECTION_IDS, normalizeDiscoverLayout } from "../../lib/discoverLayout.ts";

test("keeps a feed style only on sections that support one", () => {
  const layout = normalizeDiscoverLayout([
    { id: "news", enabled: true, style: "wide" },
    { id: "recommendedShows", enabled: false, style: "square" },
    { id: "playlists", enabled: true, style: "wide" },
  ]);
  assert.deepEqual(layout?.slice(0, 3), [
    { id: "news", enabled: true, style: "wide" },
    { id: "recommendedShows", enabled: false, style: "square" },
    { id: "playlists", enabled: true },
  ]);
});

test("drops unknown styles so older clients fall back to the list layout", () => {
  const layout = normalizeDiscoverLayout([{ id: "news", enabled: true, style: "poster" }]);
  assert.deepEqual(layout?.[0], { id: "news", enabled: true });
});

test("fills in missing and drops unknown or duplicate sections", () => {
  const layout = normalizeDiscoverLayout([
    { id: "globalTop", enabled: false },
    { id: "globalTop", enabled: true },
    { id: "removedSection", enabled: true },
  ]);
  assert.deepEqual(
    layout?.map((entry) => entry.id),
    ["globalTop", ...DISCOVER_SECTION_IDS.filter((id) => id !== "globalTop")],
  );
  assert.equal(layout?.[0].enabled, false);
  assert.equal(normalizeDiscoverLayout({ sections: [] }), null);
});
