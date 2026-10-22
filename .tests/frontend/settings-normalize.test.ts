import { test } from "vite-plus/test";
import assert from "node:assert/strict";

import { normalizeSettings } from "../../frontend/src/pages/Settings/utils.ts";

test("normalizing saved settings keeps the Google sign-in integration", () => {
  const google = {
    enabled: true,
    clientId: "client",
    clientSecret: "secret",
    redirectUri: "https://aurral.example/auth/google/callback",
  };

  const normalized = normalizeSettings({ integrations: { google } });

  assert.deepEqual(normalized.integrations.google, google);
});
