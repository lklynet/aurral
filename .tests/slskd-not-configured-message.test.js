import test from "node:test";
import assert from "node:assert/strict";

import { getDownloadSourceNotConfiguredMessage } from "../backend/services/downloadSourceService.js";
import { SLSKD_NOT_CONFIGURED_MESSAGE as orchestratorMessage } from "../backend/services/slskdOrchestrator.js";
import { SLSKD_NOT_CONFIGURED_MESSAGE as discoveryMessage } from "../backend/routes/discovery/handlers/utils.js";

const expectedMessage =
  "slskd is not configured. Enable slskd and add its Server URL in Settings > Download clients to enable Soulseek downloads for flows and playlists.";

test("slskd not-configured guidance is consistent for orchestration and discovery", () => {
  assert.equal(orchestratorMessage, expectedMessage);
  assert.equal(discoveryMessage, expectedMessage);
  assert.doesNotMatch(expectedMessage, /API key/i);
  assert.doesNotMatch(expectedMessage, /Settings > Integrations/);
});

test("generic download-source guidance uses Download clients settings", () => {
  const message = getDownloadSourceNotConfiguredMessage();

  assert.match(message, /Settings > Download clients/);
  assert.doesNotMatch(message, /Settings > Integrations/);
  assert.doesNotMatch(message, /API key/i);
});
