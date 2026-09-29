import test from "node:test";
import assert from "node:assert/strict";
import { loadFixtureSet, measureFixtureDecisions } from "./fixture-corpus.js";

test("development and acceptance fixtures keep recording and release identities apart", () => {
  const development = loadFixtureSet("development");
  const acceptance = loadFixtureSet("acceptance");
  assert.ok(development.length > 0);
  assert.ok(acceptance.length > 0);

  const developmentIds = new Set(development.flatMap((item) => item.identities));
  for (const item of acceptance) {
    assert.equal(item.identities.some((id) => developmentIds.has(id)), false, item.id);
  }
  for (const item of [...development, ...acceptance]) {
    assert.ok(item.provenance?.source);
    assert.ok(item.provenance?.license);
    assert.ok(item.identities.length > 0);
  }
});

test("fixture report separates correct, wrong, contradiction, abstention, and yield by flow", () => {
  const cases = [
    { id: "a", flow: "album", actionable: true, correctIds: ["good"], contradictedIds: ["bad"] },
    { id: "b", flow: "album", actionable: true, correctIds: ["right"], contradictedIds: ["bad"] },
    { id: "c", flow: "track-only", actionable: false, correctIds: [], contradictedIds: [] },
  ];
  const report = measureFixtureDecisions(cases, (item) => {
    if (item.id === "a") return "good";
    if (item.id === "b") return "bad";
    return "bad";
  });
  assert.deepEqual(report.album, {
    total: 2, actionable: 2, correct: 1, wrong: 1,
    contradictionAcceptances: 1, abstentions: 0, yield: 0.5,
  });
  assert.deepEqual(report["track-only"], {
    total: 1, actionable: 0, correct: 0, wrong: 1,
    contradictionAcceptances: 0, abstentions: 0, yield: null,
  });
});
