import assert from "node:assert/strict";
import { test } from "vite-plus/test";

import { registerDetails } from "../backend/routes/artists/handlers/details.js";
import { listenbrainzGetReleaseGroupListens } from "../backend/services/apiClients/listenbrainz.js";
import { json, openArtistStream, stubFetch } from "./helpers/artistStream.js";

const plaid = (n) => {
  const id = (release) => `${release}${n}0000000-0000-4000-8000-000000000000`.slice(0, 36);
  const releases = {
    doubleFigure: { id: id(1), title: "Double Figure", type: "Album", date: "2001-05-28" },
    factMix: { id: id(2), title: "FACT Mix 287: Plaid", type: "Album", secondaryTypes: ["Compilation", "DJ-mix"] },
    notForThrees: { id: id(3), title: "Not for Threes", type: "Album" },
    polymer: { id: id(4), title: "Polymer", type: "Album" },
    doubleFigureSingle: { id: id(5), title: "Double Figure", type: "Single" },
  };
  return {
    mbid: `7e54d133-2525-4bc0-ae94-00000000000${n}`,
    releases,
    provider: (mbid) => ({
      id: mbid,
      artistname: "Plaid",
      artistaliases: [],
      genres: ["Electronic"],
      images: [],
      links: [],
      Albums: Object.values(releases).map((release) => ({
        Id: release.id,
        OldIds: [],
        ReleaseStatuses: ["Official"],
        SecondaryTypes: release.secondaryTypes || [],
        ReleaseDate: release.date,
        Title: release.title,
        Type: release.type,
      })),
    }),
  };
};

const popularityRow = ({ id }, listens, listeners) => ({
  release_group_mbid: id,
  total_listen_count: listens,
  total_user_count: listeners,
});

const isListenBrainzPopularity = (url) =>
  url.hostname === "api.listenbrainz.org" && url.pathname === "/1/popularity/release-group";

const isListenBrainzMetadata = (url) =>
  url.hostname === "api.listenbrainz.org" && url.pathname === "/1/metadata/release_group/";

const summarize = (releaseGroups) =>
  releaseGroups.map((releaseGroup) => ({
    title: releaseGroup.title,
    type: releaseGroup["primary-type"],
    listenerCount: releaseGroup.listenerCount ?? null,
    listenCount: releaseGroup.listenCount ?? null,
  }));

const discographyOf = async (stream, options) => {
  const { data } = await stream.waitFor(
    ({ event, data }) => event === "artist" && "release-groups" in data,
    options,
  );
  return summarize(data["release-groups"]);
};

async function getArtistDetails(mbid) {
  const routes = new Map();
  registerDetails({
    get(path, ...handlers) {
      routes.set(path, handlers.at(-1));
    },
    put() {},
  });
  let body;
  await routes.get("/:mbid")(
    { params: { mbid }, query: { mode: "full", appearsOnLimit: "6" } },
    {
      setHeader() {},
      status() {
        return this;
      },
      json(value) {
        body = value;
        return this;
      },
    },
  );
  return body;
}

const stubPlaid = (t, artist, listenBrainz, metadata = () => json({}, 404)) =>
  stubFetch(t, (url, init) => {
    if (url.pathname === `/artist/${artist.mbid}`) return json(artist.provider(artist.mbid));
    if (isListenBrainzPopularity(url)) return listenBrainz(JSON.parse(init.body));
    if (isListenBrainzMetadata(url)) return metadata(url.searchParams.get("release_group_mbids").split(","));
    return json({}, 404);
  });

const scoredPlaid = [
  { title: "Double Figure", type: "Album", listenerCount: 4906, listenCount: 67384 },
  { title: "FACT Mix 287: Plaid", type: "Album", listenerCount: null, listenCount: null },
  { title: "Not for Threes", type: "Album", listenerCount: 2077, listenCount: 33892 },
  { title: "Polymer", type: "Album", listenerCount: 1397, listenCount: 17712 },
  { title: "Double Figure", type: "Single", listenerCount: null, listenCount: null },
];

const plaidPopularity = ({ releases }) => [
  popularityRow(releases.polymer, 17712, 1397),
  popularityRow(releases.doubleFigureSingle, null, null),
  popularityRow(releases.notForThrees, 33892, 2077),
  popularityRow(releases.factMix, null, null),
  popularityRow(releases.doubleFigure, 67384, 4906),
];

test("the artist stream gives each release the ListenBrainz listeners of its own release group", async (t) => {
  const artist = plaid(1);
  const requests = [];
  stubPlaid(t, artist, (body) => {
    requests.push(body);
    return json(plaidPopularity(artist));
  });

  const stream = openArtistStream(artist.mbid);
  t.onTestFinished(() => stream.close());

  assert.deepEqual(await discographyOf(stream), scoredPlaid);
  await stream.waitFor(({ event }) => event === "complete");
  assert.deepEqual(requests, [
    { release_group_mbids: Object.values(artist.releases).map(({ id }) => id) },
  ]);
});

test("the artist details fallback gives releases the same ListenBrainz listeners as the stream", async (t) => {
  const artist = plaid(2);
  stubPlaid(t, artist, () => json(plaidPopularity(artist)));

  const details = await getArtistDetails(artist.mbid);

  assert.deepEqual(summarize(details["release-groups"]), scoredPlaid);
});

const unscoredPlaid = scoredPlaid.map((release) => ({ ...release, listenerCount: null, listenCount: null }));

const listenBrainzFailures = [
  ["refuses the request", () => json({ code: 401, error: "You need to provide an Auth token for this endpoint." }, 401)],
  ["answers with an error body", () => json({ code: 401, error: "You need to provide an Auth token for this endpoint." })],
];

listenBrainzFailures.forEach(([failure, respond], index) => {
  test(`when ListenBrainz ${failure}, the artist stream still sends the discography and does not ask again right away`, async (t) => {
    const artist = plaid(3 + index);
    let popularityRequests = 0;
    let metadataRequests = 0;
    stubPlaid(
      t,
      artist,
      () => {
        popularityRequests += 1;
        return respond();
      },
      () => {
        metadataRequests += 1;
        return respond();
      },
    );

    for (let load = 0; load < 2; load += 1) {
      const stream = openArtistStream(artist.mbid);
      t.onTestFinished(() => stream.close());

      assert.deepEqual(await discographyOf(stream), unscoredPlaid);
      await stream.waitFor(({ event }) => event === "complete");
    }
    assert.deepEqual({ popularityRequests, metadataRequests }, { popularityRequests: 1, metadataRequests: 1 });
  });
});

test("the artist stream fills missing release dates from ListenBrainz and keeps the dates it already has", async (t) => {
  const artist = plaid(6);
  const { releases } = artist;
  const listenBrainzDates = {
    [releases.doubleFigure.id]: "2001-05-26",
    [releases.factMix.id]: "2011-09-30",
    [releases.notForThrees.id]: "1997-10-27",
    [releases.polymer.id]: "2019-06",
  };
  const asked = [];
  stubPlaid(t, artist, () => json([]), (mbids) => {
    asked.push(mbids);
    return json(
      Object.fromEntries(
        mbids.map((mbid) => [
          mbid,
          { release_group: { name: "", type: "Album", date: listenBrainzDates[mbid] ?? null } },
        ]),
      ),
    );
  });

  const stream = openArtistStream(artist.mbid);
  t.onTestFinished(() => stream.close());
  const { data } = await stream.waitFor(
    ({ event, data }) => event === "artist" && "release-groups" in data,
  );

  assert.deepEqual(
    data["release-groups"].map((releaseGroup) => [releaseGroup.title, releaseGroup["first-release-date"]]),
    [
      ["Double Figure", "2001-05-28"],
      ["FACT Mix 287: Plaid", "2011-09-30"],
      ["Not for Threes", "1997-10-27"],
      ["Polymer", "2019-06"],
      ["Double Figure", null],
    ],
  );
  assert.deepEqual(asked, [
    [releases.factMix.id, releases.notForThrees.id, releases.polymer.id, releases.doubleFigureSingle.id],
  ]);
});

test("the artist stream sends the discography without listeners when ListenBrainz does not answer in time", async (t) => {
  const artist = plaid(5);
  let answer;
  const unanswered = new Promise((resolve) => {
    answer = resolve;
  });
  stubPlaid(t, artist, () => unanswered);
  t.onTestFinished(() => answer(json([])));

  const stream = openArtistStream(artist.mbid);
  t.onTestFinished(() => stream.close());

  assert.deepEqual(await discographyOf(stream, { timeoutMs: 4000 }), unscoredPlaid);
});

test("a discography of more than a thousand releases is scored in batches ListenBrainz accepts", async (t) => {
  const releaseGroupMbids = Array.from(
    { length: 1001 },
    (_, index) => `88888888-0000-4000-8000-${String(index).padStart(12, "0")}`,
  );
  const batchSizes = [];
  stubFetch(t, (url, init) => {
    if (!isListenBrainzPopularity(url)) return json({}, 404);
    const { release_group_mbids: mbids } = JSON.parse(init.body);
    batchSizes.push(mbids.length);
    if (mbids.length > 1000) {
      return json({ code: 400, error: "Maximum number of release_group_mbids that can be fetched at once is 1000" }, 400);
    }
    return json(mbids.map((mbid) => ({ release_group_mbid: mbid, total_listen_count: 20, total_user_count: 2 })));
  });

  const listens = await listenbrainzGetReleaseGroupListens(releaseGroupMbids);

  assert.equal(listens.size, 1001);
  assert.deepEqual(listens.get(releaseGroupMbids.at(-1)), { listenCount: 20, listenerCount: 2 });
  assert.deepEqual(batchSizes, [1000, 1]);
});
