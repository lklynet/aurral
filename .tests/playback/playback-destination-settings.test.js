import assert from "node:assert/strict";
import test from "node:test";
import { getPlaybackDestinationSettings } from "../../backend/services/playback/playbackDestinationSettings.js";

test("playback adapters expose declarative connection settings without credentials", () => {
  const settings = getPlaybackDestinationSettings();

  assert.deepEqual(Object.keys(settings), ["navidrome", "plex"]);
  assert.deepEqual(
    settings.navidrome.fields.map(({ key, type, secret }) => ({ key, type, secret })),
    [
      { key: "url", type: "url", secret: undefined },
      { key: "username", type: "text", secret: undefined },
      { key: "password", type: "password", secret: true },
    ],
  );
  assert.equal(settings.plex.customUi, "plex");
  assert.equal(settings.plex.fields.find((field) => field.key === "token").hidden, true);
  for (const field of [...settings.navidrome.fields, ...settings.plex.fields]) {
    assert.equal("value" in field, false);
    assert.equal("default" in field, false);
  }
});
