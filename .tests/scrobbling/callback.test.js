import assert from "node:assert/strict";
import test from "node:test";

import { callbackUrl } from "../../backend/routes/scrobbling.js";

test("Last.fm callback uses the forwarded public host", () => {
  const request = {
    protocol: "http",
    get(name) {
      return {
        host: "localhost:3001",
        "x-forwarded-host": "192.168.4.115:3009",
        "x-forwarded-proto": "http",
      }[String(name).toLowerCase()] || undefined;
    },
  };

  assert.equal(
    new URL(callbackUrl(request, "state-token")).origin,
    "http://192.168.4.115:3009",
  );
});
