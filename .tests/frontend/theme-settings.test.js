import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

test("main Themes cards do not expose modal-only scheme actions", async () => {
  const source = await readFile(
    new URL("../../frontend/src/pages/Settings/components/ThemeSettings.jsx", import.meta.url),
    "utf8",
  );
  const sectionStart = source.indexOf('aria-labelledby="theme-themes-heading"');
  const sectionEnd = source.indexOf("<SchemeSearchModal", sectionStart);
  assert.ok(sectionStart >= 0);
  assert.ok(sectionEnd > sectionStart);

  const themesSection = source.slice(sectionStart, sectionEnd);
  assert.equal(themesSection.includes("<SchemeCard"), false);
  assert.equal(themesSection.includes("onPreview"), false);
  assert.equal(themesSection.includes("onAdd"), false);
  assert.equal(themesSection.includes("theme-settings__preview-note"), false);
});
