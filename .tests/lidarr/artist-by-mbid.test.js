import test from "node:test";
import assert from "node:assert/strict";
import { dbOps } from "../../backend/db/helpers/index.js";
import { LidarrClient } from "../../backend/services/lidarrClient.js";

const MBID = "9c9f1380-2516-4fc9-a3e6-f9f61941d090";
const OTHER_MBID = "cc197bad-dc9c-440d-a5b5-d52ba2e14234";
const muse = { id: 42, foreignArtistId: MBID, artistName: "Muse", monitored: true };
const coldplay = { id: 43, foreignArtistId: OTHER_MBID, artistName: "Coldplay", monitored: true };

const createClient = (t, handler) => {
  const client = new LidarrClient();
  const requests = [];
  client.request = async (endpoint, method = "GET", _payload, _skipConfigUpdate, options = {}) => {
    requests.push({ endpoint, method, forceRefresh: options.forceRefresh === true });
    return handler(endpoint, method);
  };
  t.after(() => {
    client._httpAgent.destroy();
    client._httpsAgent.destroy();
    client._httpsInsecureAgent.destroy();
  });
  return { client, requests };
};

test("getArtistByMbid asks Lidarr for one artist by MusicBrainz id and caches it", async (t) => {
  const { client, requests } = createClient(t, (endpoint) => {
    if (endpoint === `/artist?mbId=${MBID}`) return [muse];
    throw new Error(`Unexpected Lidarr request: ${endpoint}`);
  });

  assert.equal((await client.getArtistByMbid(MBID)).id, 42);
  assert.equal((await client.getArtistByMbid(MBID)).id, 42);
  assert.deepEqual(requests, [{ endpoint: `/artist?mbId=${MBID}`, method: "GET", forceRefresh: false }]);

  assert.equal((await client.getArtistByMbid(MBID, { forceRefresh: true })).id, 42);
  assert.equal(requests.length, 2);
  assert.equal(requests[1].forceRefresh, true);
});

test("getArtistByMbid returns null for an unknown MusicBrainz id without fetching the list", async (t) => {
  const { client, requests } = createClient(t, (endpoint) => {
    if (endpoint.startsWith("/artist?mbId=")) return [];
    throw new Error(`Unexpected Lidarr request: ${endpoint}`);
  });

  assert.equal(await client.getArtistByMbid(MBID), null);
  assert.equal(await client.getArtistByMbid(MBID), null, "the miss is cached");
  assert.equal(requests.length, 1);
});

test("getArtistByMbid dedupes concurrent lookups for the same id", async (t) => {
  const { client, requests } = createClient(t, async (endpoint) => {
    if (endpoint === `/artist?mbId=${MBID}`) {
      await new Promise((resolve) => setTimeout(resolve, 5));
      return [muse];
    }
    throw new Error(`Unexpected Lidarr request: ${endpoint}`);
  });

  const results = await Promise.all([client.getArtistByMbid(MBID), client.getArtistByMbid(MBID)]);
  assert.deepEqual(results.map((artist) => artist.id), [42, 42]);
  assert.equal(requests.length, 1);
});

test("getArtistByMbid falls back to the full list for provider-mapped ids", async (t) => {
  const providerId = "705@deezer";
  dbOps.setLidarrArtistIdMap(MBID, providerId);
  t.after(() => dbOps.deleteLidarrArtistIdMap(MBID));
  const mapped = { ...muse, foreignArtistId: providerId };
  const { client, requests } = createClient(t, (endpoint) => {
    if (endpoint === "/artist") return [coldplay, mapped];
    throw new Error(`Unexpected Lidarr request: ${endpoint}`);
  });

  assert.equal((await client.getArtistByMbid(MBID)).foreignArtistId, providerId);
  assert.equal((await client.getArtistByMbid(providerId)).id, 42);
  assert.deepEqual(requests, [{ endpoint: "/artist", method: "GET", forceRefresh: false }]);
  assert.equal((await client.getArtistByMbid(OTHER_MBID)).id, 43, "the list populated the index");
  assert.equal(requests.length, 1);
});

test("getArtistByMbid still resolves when Lidarr ignores the mbId filter", async (t) => {
  const { client, requests } = createClient(t, (endpoint) => {
    if (endpoint.startsWith("/artist?mbId=")) return [coldplay, muse];
    throw new Error(`Unexpected Lidarr request: ${endpoint}`);
  });

  assert.equal((await client.getArtistByMbid(MBID)).id, 42);
  assert.equal((await client.getArtistByMbid(OTHER_MBID)).id, 43);
  assert.equal(requests.length, 1, "the unfiltered answer indexed every artist");
});

test("getArtistByMbid serves a filtered stale list while the circuit is open", async (t) => {
  const client = new LidarrClient();
  t.after(() => {
    client._httpAgent.destroy();
    client._httpsAgent.destroy();
    client._httpsInsecureAgent.destroy();
  });
  client._artistListCache = { data: [coldplay, muse], at: 0 };
  assert.deepEqual(client._staleGetCache("GET", `/artist?mbId=${MBID}`), [muse]);
  assert.deepEqual(client._staleGetCache("GET", `/artist?mbId=${OTHER_MBID}`), [coldplay]);
});
