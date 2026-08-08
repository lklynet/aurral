import test from "node:test";
import assert from "node:assert/strict";
import axios from "../../lib/axiosFetch.js";
import {
  musicbrainzArtistIdentityCache,
  musicbrainzGetArtistIdentityByMbid,
} from "../../backend/services/apiClients/musicbrainz.js";

test("MusicBrainz identity retries transient failures instead of caching them for an hour", async (t) => {
  const mbid = "transient-identity-test";
  let attempts = 0;
  musicbrainzArtistIdentityCache.flushAll();
  t.after(() => musicbrainzArtistIdentityCache.flushAll());
  t.mock.method(axios, "get", async () => {
    attempts += 1;
    const error = new Error("MusicBrainz unavailable");
    error.response = { status: 503 };
    throw error;
  });

  assert.equal(await musicbrainzGetArtistIdentityByMbid(mbid), null);
  assert.equal(await musicbrainzGetArtistIdentityByMbid(mbid), null);
  assert.equal(attempts, 2);
});

test("MusicBrainz identity caches definitive missing artists", async (t) => {
  const mbid = "missing-identity-test";
  let attempts = 0;
  musicbrainzArtistIdentityCache.flushAll();
  t.after(() => musicbrainzArtistIdentityCache.flushAll());
  t.mock.method(axios, "get", async () => {
    attempts += 1;
    const error = new Error("Artist not found");
    error.response = { status: 404 };
    throw error;
  });

  assert.equal(await musicbrainzGetArtistIdentityByMbid(mbid), null);
  assert.equal(await musicbrainzGetArtistIdentityByMbid(mbid), null);
  assert.equal(attempts, 1);
});

test("MusicBrainz identity includes artist aliases", async (t) => {
  const mbid = "alias-identity-test";
  musicbrainzArtistIdentityCache.flushAll();
  t.after(() => musicbrainzArtistIdentityCache.flushAll());
  t.mock.method(axios, "get", async (_url, options) => {
    assert.equal(options.params.inc, "url-rels+aliases");
    return {
      data: {
        name: "FromSoftware",
        aliases: [{ name: "From Software" }],
        relations: [],
      },
    };
  });

  assert.deepEqual(await musicbrainzGetArtistIdentityByMbid(mbid), {
    mbid,
    name: "FromSoftware",
    aliases: ["From Software"],
    providerIds: [],
  });
});
