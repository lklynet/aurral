import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { parseAurralTokens, readAurralTokens } from "../../frontend/scripts/ui-token-source.mjs";

const projectRoot = fileURLToPath(new URL("../../", import.meta.url));

test("reads canonical Aurral tokens and preserves their CSS values", async () => {
  const source = await readFile(path.join(projectRoot, "frontend/src/index.css"), "utf8");
  const result = await readAurralTokens();

  assert.deepEqual(result.declarations, [
    ...parseAurralTokens(source, "frontend/src/index.css").declarations,
  ]);

  const chromeToken = result.declarations.find(({ name }) => name === "--aurral-chrome");
  assert.equal(chromeToken.selector, ":root");
  assert.equal(chromeToken.value, "light-dark(#f5f5f5, #050505)");
  assert.equal(result.declarations.some(({ name }) => name === "--aurral-accent"), true);
  assert.equal(result.references.has("--aurral-surface"), true);
});

test("keeps repeated root declarations and ignores local Aurral properties", () => {
  const result = parseAurralTokens(`
    :root { --aurral-surface: light-dark(#fff, #111); }
    :root[data-theme="dark"] { --aurral-surface: #111; }
    .card { --aurral-local: hotpink; color: var(--aurral-surface); }
  `, "tokens.css");

  assert.deepEqual(result.declarations, [
    { name: "--aurral-surface", selector: ":root", value: "light-dark(#fff, #111)" },
    { name: "--aurral-surface", selector: ':root[data-theme="dark"]', value: "#111" },
  ]);
  assert.deepEqual([...result.references], ["--aurral-surface"]);
});

test("reports a missing token source with its path", async () => {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), "aurral-token-source-"));
  const missingPath = path.join(tempDir, "missing.css");

  try {
    await assert.rejects(readAurralTokens(missingPath), (error) => {
      assert.match(error.message, /Unable to read Aurral token source/);
      assert.match(error.message, /missing\.css/);
      return true;
    });
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
});

test("reports malformed CSS with its source path", async () => {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), "aurral-token-source-"));
  const malformedPath = path.join(tempDir, "malformed.css");

  try {
    await writeFile(malformedPath, ":root { --aurral-surface: #111;", "utf8");

    await assert.rejects(readAurralTokens(malformedPath), (error) => {
      assert.match(error.message, /Unable to parse Aurral token source/);
      assert.match(error.message, /malformed\.css/);
      return true;
    });
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
});
