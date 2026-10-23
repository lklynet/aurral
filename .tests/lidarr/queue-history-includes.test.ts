import { test, vi } from "vite-plus/test";
import assert from "node:assert/strict";
import { LidarrClient } from "../../backend/services/lidarrClient.ts";
import { buildLidarrRequests } from "../../backend/services/lidarrRequestBuilder.ts";

function createClient(t: import("vite-plus/test").TestContext) {
  const client = new LidarrClient();
  vi.spyOn(client, "getAlbum").mockResolvedValue(null);
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
test("queue and history requests ask Lidarr to embed album and artist", async (t: import("vite-plus/test").TestContext) => {
  const client = createClient(t);
  const endpoints: string[] = [];
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

test("activity rows use the embedded album and artist names", async (t) => {
  const requests = await buildLidarrRequests(createClient(t), {
    queue: [
      {
        id: 1,
        albumId: 48,
        title: "Rihanna - Good Girl Gone Bad (2007) [FLAC 16bit] [👤 jellyrobin ]",
        status: "downloading",
        album: { id: 48, title: "Good Girl Gone Bad", foreignAlbumId: "rg" },
        artist: { id: 7, artistName: "Rihanna", foreignArtistId: "ar" },
      },
    ],
    history: { records: [] },
  });
  assert.equal(requests[0].albumName, "Good Girl Gone Bad");
  assert.equal(requests[0].artistName, "Rihanna");
});

test("a queue item whose status messages report a failure shows as Failed", async (t) => {
  const requests = await buildLidarrRequests(createClient(t), {
    queue: [
      {
        id: 1,
        albumId: 48,
        title: "Rihanna - Good Girl Gone Bad",
        status: "downloading",
        trackedDownloadStatus: "ok",
        statusMessages: [{ title: "Rihanna - Good Girl Gone Bad", messages: ["Download failed"] }],
        album: { id: 48, title: "Good Girl Gone Bad", foreignAlbumId: "rg" },
        artist: { id: 7, artistName: "Rihanna", foreignArtistId: "ar" },
      },
    ],
    history: { records: [] },
  });
  assert.equal(requests[0].statusLabel, "Failed");
});

test("history rows follow Lidarr event types, not words in the record", async (t) => {
  const at = (minutesAgo: number) => new Date(Date.now() - minutesAgo * 60 * 1000).toISOString();
  const requests = await buildLidarrRequests(createClient(t), {
    queue: [],
    history: {
      records: [
        {
          id: 1,
          albumId: 10,
          eventType: "albumImportIncomplete",
          sourceTitle: "Burial - Untrue (2007) [FLAC]",
          date: at(5),
          data: {
            statusMessages: JSON.stringify(
              [
                {
                  title: "Burial - Untrue (2007) [FLAC]",
                  messages: ["Album match is not close enough: 61.2% vs 80%"],
                },
              ],
              null,
              2,
            ),
            releaseGroup: null,
            indexerFlags: "0",
          },
          album: { id: 10, title: "Untrue", foreignAlbumId: "rg-untrue" },
          artist: { id: 3, artistName: "Burial", foreignArtistId: "ar-burial" },
        },
        { id: 2, albumId: 11, eventType: "downloadImported", date: at(600) },
        {
          id: 3,
          albumId: 11,
          eventType: "trackFileDeleted",
          sourceTitle: "/data/media/Fail Emotions/Epic Fail (2019)/01 - Epic Fail.flac",
          date: at(5),
          data: { reason: "MissingFromDisk" },
        },
      ],
    },
  });
  assert.deepEqual(
    requests.map(({ albumId, albumName, statusLabel }) => ({ albumId, albumName, statusLabel })),
    [{ albumId: "10", albumName: "Untrue", statusLabel: "Failed" }],
  );
});
