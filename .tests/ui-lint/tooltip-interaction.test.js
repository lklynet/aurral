import assert from "node:assert/strict";
import test from "node:test";

import { createTooltipInteractionState } from "../../frontend/src/components/tooltip-interaction.js";

test("tooltip stays visible while either pointer or keyboard focus remains active", () => {
  const state = createTooltipInteractionState();

  state.enter("pointer");
  assert.equal(state.isVisible(), true);

  state.enter("focus");
  state.leave("pointer");
  assert.equal(state.isVisible(), true);

  state.enter("pointer");
  state.leave("focus");
  assert.equal(state.isVisible(), true);

  state.leave("pointer");
  assert.equal(state.isVisible(), false);
});

test("Escape dismisses the tooltip until the next pointer or focus entry", () => {
  const state = createTooltipInteractionState();

  state.enter("pointer");
  state.dismiss();
  assert.equal(state.isVisible(), false);

  state.leave("pointer");
  state.enter("focus");
  assert.equal(state.isVisible(), true);

  state.dismiss();
  state.leave("focus");
  assert.equal(state.isVisible(), false);
});
