import { test } from "vite-plus/test";
import assert from "node:assert/strict";

import { matchOption, stepOption } from "../../frontend/src/components/Select.tsx";

const options = [
  { label: "Select a server", disabled: true },
  { label: "Living room" },
  { label: "Laptop", disabled: true },
  { label: "Library" },
  { label: "Office" },
];

test("arrow keys skip disabled options and stop at the ends", () => {
  assert.equal(stepOption(options, 1, 1), 3);
  assert.equal(stepOption(options, 3, -1), 1);
  assert.equal(stepOption(options, 1, -1), 1);
  assert.equal(stepOption(options, 4, 1), 4);
  assert.equal(stepOption(options, -1, 1), 1);
  assert.equal(stepOption(options, options.length, -1), 4);
});

test("typing one letter cycles through enabled matches", () => {
  assert.equal(matchOption(options, "l", 0), 1);
  assert.equal(matchOption(options, "l", 1), 3);
  assert.equal(matchOption(options, "l", 3), 1);
  assert.equal(matchOption(options, "ll", 1), 3);
  assert.equal(matchOption(options, "lll", 3), 1);
});

test("typing a longer prefix narrows from the current option", () => {
  assert.equal(matchOption(options, "li", 1), 1);
  assert.equal(matchOption(options, "lib", 1), 3);
  assert.equal(matchOption(options, "of", -1), 4);
  assert.equal(matchOption(options, "x", 1), -1);
});
