import assert from "node:assert/strict";
import test from "node:test";
import { PlaybackDestinationRegistry } from "../../backend/services/playback/playbackDestinationRegistry.js";

function destination(name, configured, result = { ok: true }) {
  const calls = [];
  return {
    key: name.toLowerCase(),
    name,
    calls,
    isConfigured: () => configured,
    updateConfig(config) {
      calls.push(["updateConfig", config]);
    },
    async testConnection() {},
    async ensureLibrary() {},
    async publishPlaylist(snapshot) {
      calls.push(["publishPlaylist", snapshot]);
      if (result instanceof Error) throw result;
      return result;
    },
    async deletePlaylist() {},
    async requestScan() {},
  };
}

test("runs zero, one, or multiple configured destinations from settings", async () => {
  const off = destination("Off", false);
  const first = destination("First", true);
  const second = destination("Second", true);
  const registry = new PlaybackDestinationRegistry([off, first, second]);
  registry.updateConfig({ first: { url: "first" }, second: { url: "second" } });

  assert.deepEqual(await new PlaybackDestinationRegistry([off]).run("publishPlaylist", {}), []);
  assert.deepEqual(await new PlaybackDestinationRegistry([first]).run("publishPlaylist", {}), [
    { destination: "First", operation: "publishPlaylist", ok: true },
  ]);
  assert.deepEqual(await registry.run("publishPlaylist", { entityId: "playlist-1" }), [
    { destination: "First", operation: "publishPlaylist", ok: true },
    { destination: "Second", operation: "publishPlaylist", ok: true },
  ]);
  assert.deepEqual(off.calls[0], ["updateConfig", {}]);
  assert.deepEqual(first.calls[0], ["updateConfig", { url: "first" }]);
  assert.deepEqual(second.calls[0], ["updateConfig", { url: "second" }]);
});

test("records destination failures without blocking other destinations", async (t) => {
  t.mock.method(console, "warn", () => {});
  const rejected = destination("Rejected", true, new Error("offline"));
  const failed = destination("Failed", true, {
    ok: false,
    error: { code: "SCAN_FAILED", message: "busy", retryable: true },
  });
  const ready = destination("Ready", true);

  assert.deepEqual(
    await new PlaybackDestinationRegistry([rejected, failed, ready]).run(
      "publishPlaylist",
      {},
    ),
    [
      {
        destination: "Rejected",
        operation: "publishPlaylist",
        ok: false,
        error: {
          code: "DESTINATION_OPERATION_FAILED",
          message: "offline",
          retryable: true,
        },
      },
      {
        destination: "Failed",
        operation: "publishPlaylist",
        ok: false,
        error: { code: "SCAN_FAILED", message: "busy", retryable: true },
      },
      { destination: "Ready", operation: "publishPlaylist", ok: true },
    ],
  );
});
