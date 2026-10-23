import assert from "node:assert/strict";
import { afterAll, test } from "vite-plus/test";

import { cleanupIsolatedState, setupIsolatedBackend } from "../helpers/backendTestHarness.ts";

const [isolatedState, { db }] = await setupIsolatedBackend(
  "provider-id-index",
  () => import("../../backend/config/db-sqlite.ts"),
);

afterAll(async () => {
  await cleanupIsolatedState(isolatedState);
});

const providerId =
  "CAST(CASE WHEN json_valid(metadata_json) THEN json_extract(metadata_json, '$.id') END AS TEXT)";

test("album and track provider id lookups use an index instead of scanning", () => {
  for (const table of ["library_albums", "library_tracks"]) {
    const plan = db
      .prepare<[string], { detail: string }>(
        `EXPLAIN QUERY PLAN SELECT id FROM ${table} WHERE ${providerId} = ?`,
      )
      .all("123");
    assert.ok(
      plan.some(({ detail }) => detail.includes(`idx_${table}_provider_id`)),
      `${table}: ${plan.map(({ detail }) => detail).join("; ")}`,
    );
  }
});
