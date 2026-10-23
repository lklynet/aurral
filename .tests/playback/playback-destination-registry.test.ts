import assert from "node:assert/strict";
import { test, vi } from "vite-plus/test";
import { PlaybackDestinationRegistry } from "../../backend/services/playback/playbackDestinationRegistry.ts";

function destination(
  name: string,
  configured: boolean,
  result:
    | import("../../backend/services/playback/playbackDestination.ts").PlaybackOperationResult
    | Error = { ok: true },
) {
  const calls: [string, unknown][] = [];
  const operation = async () => {
    if (result instanceof Error) throw result;
    return result;
  };
  return {
    key: name.toLowerCase(),
    name,
    calls,
    isConfigured: () => configured,
    updateConfig(config: unknown) {
      calls.push(["updateConfig", config]);
    },
    testConnection: operation,
    ensureLibrary: operation,
    async publishPlaylist(snapshot: unknown) {
      calls.push(["publishPlaylist", snapshot]);
      return operation();
    },
    async deletePlaylist(identity: unknown) {
      calls.push(["deletePlaylist", identity]);
      return operation();
    },
    deleteEntityPlaylists: operation,
    getPointerEntityIds: () => [],
    requestScan: operation,
    getReferencedPaths: operation,
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
    { destination: "First", key: "first", operation: "publishPlaylist", ok: true },
  ]);
  assert.deepEqual(await registry.run("publishPlaylist", { entityId: "playlist-1" }), [
    { destination: "First", key: "first", operation: "publishPlaylist", ok: true },
    { destination: "Second", key: "second", operation: "publishPlaylist", ok: true },
  ]);
  assert.deepEqual(off.calls[0], ["updateConfig", {}]);
  assert.deepEqual(first.calls[0], ["updateConfig", { url: "first" }]);
  assert.deepEqual(second.calls[0], ["updateConfig", { url: "second" }]);

  first.isConfigured = () => false;
  assert.deepEqual(await registry.run("deletePlaylist", { entityId: "playlist-1" }), [
    { destination: "Off", key: "off", operation: "deletePlaylist", ok: true },
    { destination: "First", key: "first", operation: "deletePlaylist", ok: true },
    { destination: "Second", key: "second", operation: "deletePlaylist", ok: true },
  ]);
  assert.deepEqual(off.calls.at(-1), ["deletePlaylist", { entityId: "playlist-1" }]);
  assert.deepEqual(first.calls.at(-1), ["deletePlaylist", { entityId: "playlist-1" }]);
  assert.deepEqual(second.calls.at(-1), ["deletePlaylist", { entityId: "playlist-1" }]);
});

test("records destination failures without blocking other destinations", async () => {
  vi.spyOn(console, "warn").mockImplementation(() => {});
  const rejected = destination("Rejected", true, new Error("offline"));
  const failed = destination("Failed", true, {
    ok: false,
    error: { code: "SCAN_FAILED", message: "busy", retryable: true },
  });
  const ready = destination("Ready", true);

  assert.deepEqual(
    await new PlaybackDestinationRegistry([rejected, failed, ready]).run("publishPlaylist", {}),
    [
      {
        destination: "Rejected",
        key: "rejected",
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
        key: "failed",
        operation: "publishPlaylist",
        ok: false,
        error: { code: "SCAN_FAILED", message: "busy", retryable: true },
      },
      { destination: "Ready", key: "ready", operation: "publishPlaylist", ok: true },
    ],
  );
});
