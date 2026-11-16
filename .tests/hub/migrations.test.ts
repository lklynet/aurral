import assert from "node:assert/strict";
import { afterAll, test } from "vite-plus/test";
import type { Bindings } from "../../hub/src/index.ts";
import { localHub } from "../../hub/testing.ts";
import { getInstance } from "../../web/functions/_shareInstances.js";
import { getShareManifest } from "../../web/functions/_shareManifests.js";

const migrated = await localHub();
const lazy = await localHub({ migrate: false });
afterAll(async () => {
  await migrated.dispose();
  await lazy.dispose();
});

const schema = async (db: Bindings["DB"]) => {
  const { results } = await db
    .prepare(
      "SELECT sql FROM sqlite_master WHERE tbl_name IN ('instances', 'shares') ORDER BY name",
    )
    .all<{ sql: string | null }>();
  return results.map(({ sql }) =>
    sql?.replace(/\s+/g, " ").replace(/\( /g, "(").replace(/ \)/g, ")"),
  );
};

test("the first migration creates the same tables the Pages functions create on demand", async () => {
  await getInstance(lazy.env.DB, "a".repeat(16));
  await getShareManifest(lazy.env.DB, "a".repeat(16), "b".repeat(22));
  const pages = await schema(lazy.env.DB);
  assert.equal(pages.length, 5);
  assert.deepEqual(await schema(migrated.env.DB), pages);
});
