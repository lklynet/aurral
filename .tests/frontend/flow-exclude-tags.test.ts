import { test } from "vite-plus/test";
import assert from "node:assert/strict";

import {
  FOCUS_NEEDS_SEEDS,
  buildFlowFromForm,
  flowToForm,
} from "../../frontend/src/pages/playlists/flowPageUtils.ts";

test("a tag starting with - is saved as excluded and shown with its minus again", () => {
  const draft = {
    ...flowToForm({ name: "Night Bus" }),
    counts: { discover: 30, mix: 0, trending: 0, focus: 0, newReleases: 0 },
    includeTags: "hip hop, -christmas, - comedy, -",
  };

  const flow = buildFlowFromForm(draft);

  assert.deepEqual([flow.tags, flow.excludeTags], [["hip hop"], ["christmas", "comedy"]]);
  assert.equal(flowToForm(flow).includeTags, "hip hop, -christmas, -comedy");
});

test("excluded tags alone do not give Focus anything to start from", () => {
  const draft = {
    ...flowToForm({ name: "Night Bus" }),
    counts: { discover: 0, mix: 0, trending: 0, focus: 10, newReleases: 0 },
    includeTags: "-christmas",
  };

  assert.throws(() => buildFlowFromForm(draft), { message: FOCUS_NEEDS_SEEDS });
});
