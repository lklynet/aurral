import assert from "node:assert/strict";
import { test } from "vite-plus/test";

import { callbackUrl } from "../../backend/routes/scrobbling.ts";

test("Last.fm callback uses the request host and preserves signed state", () => {
  const request = {
    protocol: "http",
    get(name: string) {
      return (
        (
          {
            host: "192.168.4.115:3009",
            "x-forwarded-host": "attacker.example",
            "x-forwarded-proto": "https",
          } as Record<string, string>
        )[String(name).toLowerCase()] || undefined
      );
    },
  };

  const callback = new URL(
    callbackUrl(request as Parameters<typeof callbackUrl>[0], "encoded-payload.signature"),
  );

  assert.equal(callback.origin, "http://192.168.4.115:3009");
  assert.equal(callback.searchParams.get("uid"), "encoded-payload.signature");
});

test("Last.fm callback uses the configured public origin when available", () => {
  const previous = process.env.AURRAL_PUBLIC_URL;
  process.env.AURRAL_PUBLIC_URL = "https://aurral.example.com";
  try {
    const request = { protocol: "http", get: (_name: string) => "attacker.example" };
    const callback = new URL(callbackUrl(request as Parameters<typeof callbackUrl>[0], "state"));
    assert.equal(callback.origin, "https://aurral.example.com");
  } finally {
    if (previous === undefined) delete process.env.AURRAL_PUBLIC_URL;
    else process.env.AURRAL_PUBLIC_URL = previous;
  }
});
