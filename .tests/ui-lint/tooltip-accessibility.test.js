import assert from "node:assert/strict";
import test from "node:test";

import { getTooltipDescribedBy } from "../../frontend/src/components/tooltip-accessibility.js";

test("does not repeat the tooltip as a description when it provides the accessible name", () => {
  assert.equal(
    getTooltipDescribedBy({
      tooltipId: "tooltip-1",
      isVisible: true,
      tooltipProvidesLabel: true,
    }),
    undefined,
  );
});

test("preserves supplementary descriptions and adds distinct tooltip text", () => {
  assert.equal(
    getTooltipDescribedBy({
      existingDescribedBy: "help-text",
      tooltipId: "tooltip-2",
      isVisible: true,
      tooltipProvidesLabel: false,
    }),
    "help-text tooltip-2",
  );
});

test("preserves existing descriptions when the tooltip is hidden", () => {
  assert.equal(
    getTooltipDescribedBy({
      existingDescribedBy: "help-text",
      tooltipId: "tooltip-3",
      isVisible: false,
      tooltipProvidesLabel: false,
    }),
    "help-text",
  );
});
