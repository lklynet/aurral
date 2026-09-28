import test from "node:test";
import assert from "node:assert/strict";

import { buildOnboardingPayload } from "../../frontend/src/utils/onboardingPayload.js";

const admin = { authUser: " owner ", authPassword: "Correct-Horse-42!", localNetworkBypass: true };

test("skipping Lidarr sends no Lidarr settings and keeps the chosen download folder", () => {
  const payload = buildOnboardingPayload({ ...admin, downloadFolderPath: " /music/aurral " });

  assert.equal("lidarr" in payload, false);
  assert.equal(payload.downloadFolderPath, "/music/aurral");
  assert.equal(payload.authUser, "owner");
  assert.deepEqual(payload.security, { localNetworkBypass: { enabled: true } });
});

test("skipping Lidarr with an empty download folder leaves the server default", () => {
  const payload = buildOnboardingPayload({ ...admin, downloadFolderPath: "  " });

  assert.equal("downloadFolderPath" in payload, false);
});

test("connecting Lidarr sends the tested connection and never the Aurral folder", () => {
  const payload = buildOnboardingPayload({
    ...admin,
    downloadFolderPath: "/music/aurral",
    lidarr: {
      url: " http://lidarr:8686// ",
      apiKey: " key ",
      qualityProfileId: 4,
      metadataProfileId: 2,
    },
  });

  assert.deepEqual(payload.lidarr, {
    url: "http://lidarr:8686",
    apiKey: "key",
    qualityProfileId: 4,
    metadataProfileId: 2,
    defaultMonitorOption: "none",
    searchOnAdd: false,
  });
  assert.equal("downloadFolderPath" in payload, false);
});
