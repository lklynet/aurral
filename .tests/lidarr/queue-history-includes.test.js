import { test, vi } from "vite-plus/test";
import assert from "node:assert/strict";
import { LidarrClient } from "../../backend/services/lidarrClient.js";
import { buildLidarrRequests } from "../../backend/services/lidarrRequestBuilder.js";

function createClient(t) {
  const client = new LidarrClient();
  t.onTestFinished(() => {
    client._httpAgent.destroy();
    client._httpsAgent.destroy();
    client._httpsInsecureAgent.destroy();
  });
  return client;
}

// Lidarr omits album/artist from queue and history records unless asked, so
// Activity showed raw release titles ("Rihanna - ... [FLAC 16bit] [👤 user]")
// under the placeholder artist "Artist".
test("queue and history requests ask Lidarr to embed album and artist", async (t) => {
  const client = createClient(t);
  const endpoints = [];
  vi.spyOn(client, "request").mockImplementation(async (endpoint) => {
    endpoints.push(endpoint);
    return { records: [] };
  });

  await client.getQueue();
  await client.getHistory(1, 200);

  for (const endpoint of endpoints) {
    const params = new URL(endpoint, "http://lidarr").searchParams;
    assert.equal(params.get("includeAlbum"), "true", endpoint);
    assert.equal(params.get("includeArtist"), "true", endpoint);
  }
  const queueParams = new URL(endpoints[0], "http://lidarr").searchParams;
  assert.ok(
    Number(queueParams.get("pageSize")) > 10,
    "queue must not stop at Lidarr's default page of 10",
  );
});

test("activity rows use the embedded album and artist names", async () => {
  const requests = await buildLidarrRequests(
    { getAlbum: async () => null },
    {
      queue: [
        {
          id: 1,
          albumId: 48,
          title: "Rihanna - Good Girl Gone Bad (2007) [FLAC 16bit] [👤 jellyrobin ]",
          status: "downloading",
          album: { title: "Good Girl Gone Bad", foreignAlbumId: "rg" },
          artist: { id: 7, artistName: "Rihanna", foreignArtistId: "ar" },
        },
      ],
      history: { records: [] },
    },
  );
  assert.equal(requests[0].albumName, "Good Girl Gone Bad");
  assert.equal(requests[0].artistName, "Rihanna");
});
