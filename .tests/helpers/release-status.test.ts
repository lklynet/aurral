import { test } from "vite-plus/test";
import assert from "node:assert/strict";

import { planStatus, statusMutations, type StatusItem } from "../../scripts/release-status.ts";
import { requireFixture } from "../playlists/fixtures.ts";

const item = (number: number, kind: StatusItem["kind"], labels: string[]): StatusItem => ({
  id: `node-${number}`,
  number,
  kind,
  labels,
});

test("nightly comments on linked issues once and leaves pull requests alone", () => {
  const plan = planStatus(
    [
      item(1, "pull", []),
      item(2, "issue", []),
      item(3, "issue", ["nightly"]),
      item(4, "issue", ["released"]),
    ],
    "nightly",
  );

  assert.deepEqual(
    plan.map(({ number, add, remove, comment }) => ({ number, add, remove, comment })),
    [
      { number: 2, add: "nightly", remove: null, comment: true },
      { number: 4, add: "nightly", remove: "released", comment: true },
    ],
  );
});

test("stable labels pull requests, comments on issues, and skips what is already released", () => {
  const plan = planStatus(
    [
      item(1, "pull", ["bug", "nightly"]),
      item(2, "pull", ["released"]),
      item(3, "issue", ["nightly"]),
      item(4, "issue", ["released"]),
    ],
    "stable",
  );

  assert.deepEqual(
    plan.map(({ number, add, remove, comment }) => ({ number, add, remove, comment })),
    [
      { number: 1, add: "released", remove: "nightly", comment: false },
      { number: 3, add: "released", remove: "nightly", comment: true },
    ],
  );
});

test("comments go out before any label, so a failed comment is retried instead of skipped", () => {
  const pulls = Array.from({ length: 40 }, (_, index) => item(index, "pull", []));
  const mutations = statusMutations(planStatus([...pulls, item(99, "issue", [])], "stable"), {
    nightly: "nightly-label",
    released: "released-label",
  });

  assert.equal(mutations.length, 3);
  assert.ok(mutations[0]?.startsWith("mutation($body: String!)"));
  assert.ok(!requireFixture(mutations[0]).includes("addLabelsToLabelable"));
  assert.ok(mutations.slice(1).every((mutation) => !mutation.includes("addComment")));
});
