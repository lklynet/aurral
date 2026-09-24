import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";

test("Google account linking starts through the authenticated API client", () => {
  const component = fs.readFileSync(
    "frontend/src/pages/Settings/components/ConnectedAccountsSection.jsx",
    "utf8",
  );
  const endpoints = fs.readFileSync("frontend/src/utils/api/endpoints/auth.js", "utf8");
  assert.match(component, /await startGoogleLink\(\)/);
  assert.doesNotMatch(component, /location\.assign\(buildApiUrl\("\/api\/auth\/google\/link"\)\)/);
  assert.match(endpoints, /postData\("\/auth\/google\/link\/start"\)/);
});
