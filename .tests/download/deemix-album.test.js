import test from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { DeemixClient, readDeemixAlbumQueue } from "../../backend/services/deemixClient.js";

test("deemix album queue keeps completed file paths when one track fails", async () => {
  const calls = [];
  const server = createServer(async (request, response) => {
    response.setHeader("content-type", "application/json");
    if (request.url === "/api/connect") {
      response.setHeader("set-cookie", "session=disposable; Path=/");
      response.end(JSON.stringify({ autologin: false, currentUser: {} }));
      return;
    }
    if (request.url === "/api/addToQueue") {
      const chunks = [];
      for await (const chunk of request) chunks.push(chunk);
      calls.push(JSON.parse(Buffer.concat(chunks).toString()));
      response.end(JSON.stringify({ result: true, data: { obj: { uuid: "album_302127_1" } } }));
      return;
    }
    if (request.url === "/api/getQueue") {
      response.end(JSON.stringify({ queue: { album_302127_1: {
        uuid: "album_302127_1", type: "album", status: "withErrors", size: 3,
        downloaded: 2, failed: 1, files: [
          { path: "/downloads/album/01.flac", data: { id: "first" } },
          { path: "/downloads/album/02.flac", data: { id: "second" } },
        ], errors: [{ message: "track unavailable" }],
      } }, queueOrder: [] }));
      return;
    }
    response.statusCode = 404;
    response.end("{}");
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  try {
    const address = server.address();
    const client = new DeemixClient({ enabled: true, url: `http://127.0.0.1:${address.port}`, bitrate: 1 });
    const uuid = await client.addAlbumToQueue("https://www.deezer.com/album/302127", "302127");
    const item = await client.getQueueItem(uuid);
    const result = readDeemixAlbumQueue(item);
    assert.equal(uuid, "album_302127_1");
    assert.deepEqual(calls, [{ url: "https://www.deezer.com/album/302127", bitrate: 1 }]);
    assert.deepEqual(result.filePaths, ["/downloads/album/01.flac", "/downloads/album/02.flac"]);
    assert.equal(result.failedCount, 1);
    assert.equal(result.finished, true);
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
});

test("deemix album files are unavailable until the queue item finishes", () => {
  const item = { type: "album", status: "downloading", failed: 1,
    files: [{ path: "/downloads/album/01.flac" }] };
  assert.deepEqual(readDeemixAlbumQueue(item).filePaths, []);
  const finished = readDeemixAlbumQueue({ ...item, status: "failed", files: [] });
  assert.equal(finished.finished, true);
  assert.deepEqual(finished.filePaths, []);
  assert.equal(finished.failedCount, 1);
});
