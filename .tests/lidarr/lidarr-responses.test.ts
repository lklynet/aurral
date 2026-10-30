import assert from "node:assert/strict";
import { test, type TestContext } from "vite-plus/test";
import { createMockHttpServer } from "../helpers/backendTestHarness.ts";
import { LidarrClient } from "../../backend/services/lidarrClient.ts";

async function fakeLidarr(t: TestContext, responses: Record<string, unknown>) {
  const puts: { url: string | undefined; body: unknown }[] = [];
  const server = await createMockHttpServer((request, response) => {
    let body = "";
    request.setEncoding("utf8");
    request.on("data", (chunk) => {
      body += chunk;
    });
    request.on("end", () => {
      response.setHeader("content-type", "application/json");
      if (request.method === "PUT") {
        puts.push({ url: request.url, body: JSON.parse(body) });
        response.end(body);
        return;
      }
      const key = `${request.method} ${request.url}`;
      if (!(key in responses)) {
        response.writeHead(404);
        response.end("{}");
        return;
      }
      response.end(JSON.stringify(responses[key]));
    });
  });
  const client = new LidarrClient();
  client._holdConfig = true;
  client.config = {
    ...client.config,
    url: server.url,
    apiKey: "test",
    timeoutMs: 2000,
    circuitDisabled: true,
  };
  t.onTestFinished(async () => {
    client._httpAgent.destroy();
    client._httpsAgent.destroy();
    client._httpsInsecureAgent.destroy();
    await server.close();
  });
  return { client, puts };
}

test("Lidarr lists skip only the records Aurral can't read", async (t) => {
  const { client } = await fakeLidarr(t, {
    "GET /api/v1/album": [
      { id: 1, foreignAlbumId: "a", title: "Kept" },
      { id: "2", foreignAlbumId: "b", title: "Text id" },
      { id: 3, foreignAlbumId: "c", title: { text: "Object title" } },
    ],
  });

  const albums = await client.getAllAlbums();

  assert.deepEqual(
    albums.map((album) => album.title),
    ["Kept"],
  );
});

test("updating a Lidarr artist sends back the fields Aurral doesn't read", async (t) => {
  const artist = {
    id: 5,
    artistName: "Artist",
    foreignArtistId: "artist-mbid",
    monitored: false,
    path: null,
    images: [{ coverType: "poster", url: "/poster.jpg" }],
    ratings: { votes: 3, value: 8.1 },
  };
  const { client, puts } = await fakeLidarr(t, { "GET /api/v1/artist/5": artist });

  await client.updateArtist(5, { monitored: true });

  assert.deepEqual(puts, [{ url: "/api/v1/artist/5", body: { ...artist, monitored: true } }]);
});

test("a Lidarr artist Aurral can't read is never written back", async (t) => {
  const { client, puts } = await fakeLidarr(t, {
    "GET /api/v1/artist/5": { id: 5, artistName: "Artist", monitored: "yes" },
  });

  await assert.rejects(
    client.updateArtist(5, { monitored: true }),
    /Lidarr sent \/artist\/5 data Aurral can't read/,
  );
  assert.deepEqual(puts, []);
});
