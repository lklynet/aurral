import assert from "node:assert/strict";
import test from "node:test";
import { getPlaybackDestinationSettings } from "../../backend/services/playback/playbackDestinationSettings.js";

test("playback adapters expose declarative connection settings without credentials", () => {
  const settings = getPlaybackDestinationSettings();

  for (const [key, definition] of Object.entries(settings)) {
    assert.ok(definition.fields.length > 0, key);
    for (const field of definition.fields) {
      assert.equal("value" in field, false, `${key}.${field.key}`);
      assert.equal("default" in field, false, `${key}.${field.key}`);
      if (field.type === "password") assert.equal(field.secret, true, `${key}.${field.key}`);
    }
    for (const required of definition.validation?.required || []) {
      assert.ok(definition.fields.some((field) => field.key === required), `${key}.${required}`);
    }
  }
});
