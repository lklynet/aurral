import assert from "node:assert/strict";
import { afterEach, test, vi } from "vite-plus/test";
import { normalizeAddress } from "../../frontend/src/utils/server.ts";

afterEach(() => {
  vi.unstubAllGlobals();
});

test("a server address keeps its base path and refuses what a crafted pair link could hide", () => {
  vi.stubGlobal("location", { protocol: "https:" });
  for (const [input, expected] of [
    ["music.example.com", "https://music.example.com"],
    [" https://music.example.com/aurral/ ", "https://music.example.com/aurral"],
    ["https://aurral.tail1234.ts.net:8443?x=1#y", "https://aurral.tail1234.ts.net:8443"],
    ["http://192.168.1.20:3001", null],
    ["https://user:pass@music.example.com", null],
    ["https://music.example.com@evil.example", null],
    ["javascript://music.example.com", null],
  ] as const) {
    assert.equal(normalizeAddress(input), expected, input);
  }
});

test("a plain HTTP page can reach a plain HTTP server, for local testing", () => {
  vi.stubGlobal("location", { protocol: "http:" });
  assert.equal(normalizeAddress("http://127.0.0.1:3001"), "http://127.0.0.1:3001");
});
