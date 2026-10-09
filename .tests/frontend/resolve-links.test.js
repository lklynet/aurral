import assert from "node:assert/strict";
import test from "node:test";
import { startFrontendServer } from "../helpers/frontendServer.js";

async function setup(t, respond) {
  const vite = await startFrontendServer();
  const previousFetch = globalThis.fetch;
  const requests = [];
  globalThis.fetch = async (input, init) => {
    const url = new URL(typeof input === "string" ? input : input.url, "http://aurral.test");
    requests.push(url);
    const { status = 200, body } = respond(url, init);
    return new Response(JSON.stringify(body), {
      status,
      headers: { "content-type": "application/json" },
    });
  };
  const links = await vite.ssrLoadModule("/src/navigation/resolveLinks.js");
  const { prefetchRoute } = await vite.ssrLoadModule("/src/navigation/routePrefetch.js");
  const { queryClient } = await vite.ssrLoadModule("/src/queryClient.js");
  t.after(async () => {
    queryClient.clear();
    globalThis.fetch = previousFetch;
    await vite.close();
  });
  const open = (path) => {
    const url = new URL(path, "http://aurral.test");
    const kind = url.pathname.replace(/^\/go\//, "");
    return queryClient.fetchQuery(links.resolveLinkQueryOptions(kind, url.search));
  };
  return { links, open, prefetchRoute, requests };
}

test("an album link opens the release it resolves to, keeping names intact", async (t) => {
  const { links, open, requests } = await setup(t, () => ({
    body: { artistMbid: "artist-1", albumMbid: "release-1" },
  }));
  const path = links.resolveAlbumPath({
    artistName: "AC/DC & Friends",
    albumName: "Back in Black?",
    deezerAlbumId: 42,
  });

  const target = await open(path);

  assert.equal(target.to, "/artist/artist-1/release/release-1");
  assert.equal(target.state.focusReleaseGroup.title, "Back in Black?");
  const sent = requests.find((url) => url.pathname.endsWith("/discover/editorial/links"));
  assert.equal(sent.searchParams.get("artist"), "AC/DC & Friends");
  assert.equal(sent.searchParams.get("album"), "Back in Black?");
  assert.equal(sent.searchParams.get("albumId"), "42");
});

test("an album that isn't found opens its artist, and an unknown artist explains itself", async (t) => {
  let artistMbid = "artist-2";
  const { links, open } = await setup(t, () => ({ body: { artistMbid, albumMbid: null } }));

  const fallback = await open(links.resolveAlbumPath({ artistName: "Someone", albumName: "Lost" }));
  assert.equal(fallback.to, "/artist/artist-2");
  assert.match(fallback.notice, /Lost/);

  artistMbid = null;
  await assert.rejects(open(links.resolveArtistPath({ name: "Nobody Known" })), (error) => {
    assert.equal(error.resolveNotFound, true);
    assert.match(error.message, /Nobody Known/);
    return true;
  });
});

test("a library artist link falls back to a name match when the ID lookup misses", async (t) => {
  const { links, open } = await setup(t, (url) => {
    if (url.pathname.includes("/library/lookup/")) return { body: { exists: false } };
    if (url.pathname.endsWith("/library/canonical")) {
      return { body: { items: [{ id: 3, name: "Other" }, { id: 9, canonicalId: "c-9", name: "Wanted Artist" }] } };
    }
    return { body: {} };
  });

  const target = await open(links.resolveLibraryArtistPath({ mbid: "mb-1", name: "wanted artist" }));
  assert.equal(target.to, "/library/artist/c-9");
});

test("hovering a resolver link does the lookup the opened page then reuses", async (t) => {
  const { links, open, prefetchRoute, requests } = await setup(t, () => ({
    body: { artistMbid: "artist-3" },
  }));
  const path = links.resolveArtistPath({ name: "Hovered" });

  await prefetchRoute(path);
  const lookups = () => requests.filter((url) => url.pathname.endsWith("/discover/editorial/links")).length;
  assert.equal(lookups(), 1);

  const target = await open(path);
  assert.equal(target.to, "/artist/artist-3");
  assert.equal(lookups(), 1);
});
