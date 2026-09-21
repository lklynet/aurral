import assert from "node:assert/strict";
import test from "node:test";
import { createServer } from "vite";

test("playlist history preference sends the selected state to the shared-playlist endpoint", async (t) => {
  const vite = await createServer({
    root: "frontend",
    server: { middlewareMode: true, hmr: false },
    appType: "custom",
    optimizeDeps: { noDiscovery: true },
  });
  t.after(() => vite.close());

  const { setPlaylistRecordHistory } = await vite.ssrLoadModule(
    "/src/utils/api/endpoints/playlists.js?playlist-record-history-test",
  );
  const originalFetch = globalThis.fetch;
  let requestUrl = "";
  let requestInit = null;
  globalThis.fetch = async (url, init) => {
    requestUrl = String(url);
    requestInit = init;
    return new Response(JSON.stringify({ success: true, recordHistory: false }), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  };

  try {
    const result = await setPlaylistRecordHistory("playlist/1", false);
    assert.match(requestUrl, /\/api\/playlists\/shared-playlists\/playlist%2F1\/record-history$/);
    assert.equal(requestInit.method, "PUT");
    assert.deepEqual(JSON.parse(requestInit.body), { enabled: false });
    assert.equal(result.recordHistory, false);
  } finally {
    globalThis.fetch = originalFetch;
  }
});
