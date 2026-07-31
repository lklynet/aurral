import assert from "node:assert/strict";
import test from "node:test";

import { NAVIGATE_FALLBACK_DENYLIST } from "../../frontend/vite.config.js";

const isHandledByAurralShell = (pathname) =>
  !NAVIGATE_FALLBACK_DENYLIST.some((pattern) => pattern.test(pathname));

test("PWA navigation fallback does not claim reverse-proxy auth routes", () => {
  assert.equal(isHandledByAurralShell("/discover"), true);
  assert.equal(isHandledByAurralShell("/api/auth/logout"), false);
  assert.equal(isHandledByAurralShell("/outpost.goauthentik.io/start"), false);
  assert.equal(isHandledByAurralShell("/outpost.goauthentik.io/sign_out"), false);
});
