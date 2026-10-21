import assert from "node:assert/strict";
import { test } from "vite-plus/test";

import { mergePlexIntegration } from "../../backend/routes/settings/handlers/plexSettings.js";

test("mergePlexIntegration preserves existing auth only when the request omits it", () => {
  assert.deepEqual(
    mergePlexIntegration(
      { token: "saved-token", clientId: "saved-client", url: "http://old" },
      { url: "http://new" },
    ),
    { token: "saved-token", clientId: "saved-client", url: "http://new" },
  );
});

test("mergePlexIntegration allows clearing a saved Plex token", () => {
  assert.deepEqual(
    mergePlexIntegration(
      { token: "saved-token", clientId: "saved-client", url: "http://old" },
      { token: "", url: "" },
    ),
    { token: "", clientId: "saved-client", url: "" },
  );
});
