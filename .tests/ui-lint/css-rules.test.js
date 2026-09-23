import assert from "node:assert/strict";
import test from "node:test";

import { lintCss } from "../../frontend/scripts/lint-ui-css.mjs";

const tokenNames = new Set([
  "--aurral-surface",
  "--aurral-text",
  "--aurral-border",
  "--aurral-ring",
  "--aurral-shadow-popover",
  "--aurral-white",
  "--aurral-gray",
  "--aurral-gray-light",
]);

test("allows canonical token definitions and valid Aurral token references", () => {
  const findings = lintCss(`
    :root {
      --aurral-surface: light-dark(#fff, #111);
      --aurral-text: light-dark(#171717, #f5f5f5);
    }
    .card {
      background: var(--aurral-surface);
      color: var(--aurral-text);
      border-color: var(--aurral-border);
    }
  `, { filePath: "tokens.css", tokenNames });

  assert.deepEqual(findings, []);
});

test("does not treat color words inside Aurral token names as hard-coded colors", () => {
  const findings = lintCss(`
    .card {
      color: var(--aurral-white);
      border-color: var(--aurral-gray-light);
      box-shadow: var(--aurral-gray);
    }
  `, { filePath: "card.css", tokenNames });

  assert.deepEqual(findings, []);
});

test("reports hard-coded theme colors with property-matched token suggestions", () => {
  const findings = lintCss(`
    .card {
      color: #fff;
      background: rgb(0 0 0 / 0.5);
      border: 1px solid gold;
      border-color: rgba(255, 255, 255, 0.2);
      outline: 2px solid blue;
      box-shadow: 0 2px 8px rgba(0, 0, 0, 0.2);
    }
  `, { filePath: "card.css", tokenNames });

  assert.deepEqual(findings.map(({ line, ruleId, suggestion }) => ({ line, ruleId, suggestion })), [
    { line: 3, ruleId: "aurral/no-hard-coded-color", suggestion: "--aurral-text" },
    { line: 4, ruleId: "aurral/no-hard-coded-color", suggestion: "--aurral-surface" },
    { line: 5, ruleId: "aurral/no-hard-coded-color", suggestion: "--aurral-border" },
    { line: 6, ruleId: "aurral/no-hard-coded-color", suggestion: "--aurral-border" },
    { line: 7, ruleId: "aurral/no-hard-coded-color", suggestion: "--aurral-ring" },
    { line: 8, ruleId: "aurral/no-hard-coded-color", suggestion: "--aurral-shadow-popover" },
  ]);
  assert.match(findings[0].message, /card\.css:3/);
  assert.match(findings[0].message, /var\(--aurral-text\)/);
});

test("reports undefined Aurral variables at the reference line", () => {
  const findings = lintCss(`
    .card {
      background: var(--aurral-surfce);
    }
  `, { filePath: "card.css", tokenNames });

  assert.deepEqual(findings, [
    {
      filePath: "card.css",
      line: 3,
      ruleId: "aurral/no-undefined-token",
      suggestion: "--aurral-surface",
      message: "card.css:3 uses undefined Aurral token --aurral-surfce; use var(--aurral-surface).",
    },
  ]);
});

test("allows runtime artwork colors and geometry variables", () => {
  const findings = lintCss(`
    .artwork {
      background: var(--artwork-color);
      color: var(--artwork-text-color);
      width: var(--progress-width);
      transform: translateX(var(--thumb-offset));
    }
  `, { filePath: "artwork.css", tokenNames });

  assert.deepEqual(findings, []);
});

test("allows the DotLoader runtime geometry properties", () => {
  const findings = lintCss(`
    .loader {
      grid-template-columns: repeat(3, var(--aurral-dot-loader-tile-size));
      gap: var(--aurral-dot-loader-gap);
    }
  `, { filePath: "loader.css", tokenNames });

  assert.deepEqual(findings, []);
});

test("catches hard-coded colors hidden behind local custom properties", () => {
  const findings = lintCss(`
    .card {
      --card-copy: white;
      color: var(--card-copy);
    }
  `, { filePath: "card.css", tokenNames });

  assert.equal(findings.length, 1);
  assert.equal(findings[0].line, 3);
  assert.equal(findings[0].suggestion, "--aurral-text");
});

test("reports malformed stylesheets as source-located findings", () => {
  const findings = lintCss(":root { color: #fff;", {
    filePath: "broken.css",
    tokenNames,
  });

  assert.equal(findings.length, 1);
  assert.equal(findings[0].ruleId, "aurral/css-parse-error");
  assert.match(findings[0].message, /broken\.css:1/);
});
