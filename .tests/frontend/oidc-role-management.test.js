import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";

test("OIDC-managed users show that their role will be overwritten", () => {
  const source = fs.readFileSync(
    "frontend/src/pages/Settings/components/SettingsUsersTab.jsx",
    "utf8",
  );
  assert.match(source, /editUser\.roleSource === "oidc"/);
  assert.match(source, /Managed by OIDC; local changes will be overwritten/);
});
