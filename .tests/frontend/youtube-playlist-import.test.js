import assert from "node:assert/strict";
import test from "node:test";
import { createServer } from "vite";

test("YouTube playlist requests allow the server operation timeout", async (t) => {
  const vite = await createServer({
    root: "frontend",
    server: { middlewareMode: true, hmr: false },
    appType: "custom",
    optimizeDeps: { noDiscovery: true },
  });
  t.after(() => vite.close());

  const { importYoutubeMusicPlaylist, previewYoutubeMusicPlaylist } = await vite.ssrLoadModule(
    "/src/utils/api/endpoints/playlists.js?youtube-playlist-import-test",
  );
  const originalFetch = globalThis.fetch;
  const originalSetTimeout = globalThis.setTimeout;
  const originalClearTimeout = globalThis.clearTimeout;
  const timeoutDelays = [];
  globalThis.setTimeout = (_callback, delay) => {
    timeoutDelays.push(delay);
    return Symbol("timer");
  };
  globalThis.clearTimeout = () => {};
  globalThis.fetch = async () => new Response("{}", {
    status: 200,
    headers: { "content-type": "application/json" },
  });

  try {
    await previewYoutubeMusicPlaylist("https://music.youtube.com/playlist?list=PLabcdefghij_123");
    await importYoutubeMusicPlaylist({ playlistId: "PLabcdefghij_123", name: "Mix" });
    assert.deepEqual(timeoutDelays, [5 * 60 * 1_000, 5 * 60 * 1_000]);
  } finally {
    globalThis.fetch = originalFetch;
    globalThis.setTimeout = originalSetTimeout;
    globalThis.clearTimeout = originalClearTimeout;
  }
});
