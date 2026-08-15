import assert from "node:assert/strict";
import test from "node:test";

import { callbackUrl } from "../../backend/routes/scrobbling.js";

test("Last.fm callback uses the request host and preserves signed state", () => {
  const request = {
    protocol: "http",
    get(name) {
      return {
        host: "192.168.4.115:3009",
        "x-forwarded-host": "attacker.example",
        "x-forwarded-proto": "https",
      }[String(name).toLowerCase()] || undefined;
    },
  };

  const callback = new URL(callbackUrl(request, "encoded-payload.signature"));

  assert.equal(callback.origin, "http://192.168.4.115:3009");
  assert.equal(callback.searchParams.get("uid"), "encoded-payload.signature");
});

test("Last.fm callback uses the configured public origin when available", () => {
  const previous = process.env.AURRAL_PUBLIC_URL;
  process.env.AURRAL_PUBLIC_URL = "https://aurral.example.com";
  try {
    const callback = new URL(callbackUrl({ protocol: "http", get: () => "attacker.example" }, "state"));
    assert.equal(callback.origin, "https://aurral.example.com");
  } finally {
    if (previous === undefined) delete process.env.AURRAL_PUBLIC_URL;
    else process.env.AURRAL_PUBLIC_URL = previous;
  }
});
