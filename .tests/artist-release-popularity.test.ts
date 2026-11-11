import { requireFixture } from "./playlists/fixtures.ts";
import assert from "node:assert/strict";
import { testClient } from "hono/testing";
import { test, vi } from "vite-plus/test";

import details from "../backend/routes/artists/handlers/details.ts";
import { listenbrainzGetReleaseGroupListens } from "../backend/services/apiClients/listenbrainz.ts";
import { json, stubFetch } from "./helpers/stubFetch.ts";
import { useFakeClock } from "./helpers/fakeClock.ts";

useFakeClock();

const plaid = (n: number) => {
  const id = (release: number) => `${release}${n}0000000-0000-4000-8000-000000000000`.slice(0, 36);
  const releases: Record<
    "doubleFigure" | "factMix" | "notForThrees" | "polymer" | "doubleFigureSingle",
    { id: string; title: string; type: string; date?: string; secondaryTypes?: string[] }
  > = {
    doubleFigure: { id: id(1), title: "Double Figure", type: "Album", date: "2001-05-28" },
    factMix: {
      id: id(2),
      title: "FACT Mix 287: Plaid",
      type: "Album",
      secondaryTypes: ["Compilation", "DJ-mix"],
    },
    notForThrees: { id: id(3), title: "Not for Threes", type: "Album" },
    polymer: { id: id(4), title: "Polymer", type: "Album" },
    doubleFigureSingle: { id: id(5), title: "Double Figure", type: "Single" },
  };
  return {
    mbid: `7e54d133-2525-4bc0-ae94-00000000000${n}`,
    releases,
    provider: (mbid: string) => ({
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
        Title: release.title,
        Type: release.type,
      })),
    }),
  };
};

const popularityRow = (
  { id }: { id: string },
  listens: number | null,
  listeners: number | null,
) => ({
  release_group_mbid: id,
  total_listen_count: listens,
  total_user_count: listeners,
});

const isListenBrainzPopularity = (url: URL) =>
  url.hostname === "api.listenbrainz.org" && url.pathname === "/1/popularity/release-group";

const isListenBrainzMetadata = (url: URL) =>
  url.hostname === "api.listenbrainz.org" && url.pathname === "/1/metadata/release_group/";

const summarize = (
  releaseGroups: {
    title: string;
    "primary-type": string;
    listenerCount?: number | null;
    listenCount?: number | null;
  }[],
) =>
  releaseGroups.map((releaseGroup) => ({
    title: releaseGroup.title,
    type: releaseGroup["primary-type"],
    listenerCount: releaseGroup.listenerCount ?? null,
    listenCount: releaseGroup.listenCount ?? null,
  }));

const detailsClient = testClient(details);

async function loadArtist(mbid: string) {
  const response = await detailsClient.artists[":mbid"].$get({
    param: { mbid },
    query: { mode: "core" },
  });
  const artist = await response.json();
  assert.ok("release-groups" in artist);
  return {
    discography: summarize(artist["release-groups"]),
    releaseGroups: artist["release-groups"],
    pending: artist["release-stats-pending"],
    cacheControl: response.headers.get("cache-control"),
  };
}

const stubPlaid = (
  t: import("vite-plus/test").TestContext,
  artist: ReturnType<typeof plaid>,
  listenBrainz: (body: { release_group_mbids: string[] }) => Response | Promise<Response>,
  metadata: (mbids: string[]) => Response = () => json({}, 404),
) =>
  stubFetch(t, (url, init) => {
    if (url.pathname === `/artist/${artist.mbid}`) return json(artist.provider(artist.mbid));
    const dated = Object.values(artist.releases).find(
      (release) => release.date && url.pathname === `/album/${release.id}`,
    );
    if (dated) return json({ id: dated.id, title: dated.title, releasedate: dated.date });
    if (isListenBrainzPopularity(url))
      return listenBrainz(JSON.parse(String(requireFixture(init).body)));
    if (isListenBrainzMetadata(url))
      return metadata(url.searchParams.get("release_group_mbids")!.split(","));
    return json({}, 404);
  });

const scoredPlaid = [
  { title: "Double Figure", type: "Album", listenerCount: 4906, listenCount: 67384 },
  { title: "FACT Mix 287: Plaid", type: "Album", listenerCount: null, listenCount: null },
  { title: "Not for Threes", type: "Album", listenerCount: 2077, listenCount: 33892 },
  { title: "Polymer", type: "Album", listenerCount: 1397, listenCount: 17712 },
  { title: "Double Figure", type: "Single", listenerCount: null, listenCount: null },
];

const unscoredPlaid = scoredPlaid.map((release) => ({
  ...release,
  listenerCount: null,
  listenCount: null,
}));

const plaidPopularity = ({ releases }: ReturnType<typeof plaid>) => [
  popularityRow(releases.polymer, 17712, 1397),
  popularityRow(releases.doubleFigureSingle, null, null),
  popularityRow(releases.notForThrees, 33892, 2077),
  popularityRow(releases.factMix, null, null),
  popularityRow(releases.doubleFigure, 67384, 4906),
];

test("artist details give each release the ListenBrainz listeners of its own release group and keep them", async (t: import("vite-plus/test").TestContext) => {
  const artist = plaid(1);
  const requests: { release_group_mbids: string[] }[] = [];
  stubPlaid(t, artist, (body) => {
    requests.push(body);
    return json(plaidPopularity(artist));
  });

  const first = await loadArtist(artist.mbid);
  const second = await loadArtist(artist.mbid);

  assert.deepEqual(first.discography, scoredPlaid);
  assert.deepEqual(second.discography, scoredPlaid);
  assert.equal(first.pending, false);
  assert.deepEqual(requests, [
    { release_group_mbids: Object.values(artist.releases).map(({ id }) => id) },
  ]);
});

const listenBrainzFailures = [
  [
    "refuses the request",
    () => json({ code: 401, error: "You need to provide an Auth token for this endpoint." }, 401),
  ],
  [
    "answers with an error body",
    () => json({ code: 401, error: "You need to provide an Auth token for this endpoint." }),
  ],
] as const;

listenBrainzFailures.forEach(([failure, respond], index) => {
  test(`when ListenBrainz ${failure}, artist details still list the discography and do not ask again right away`, async (t: import("vite-plus/test").TestContext) => {
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
      const { discography, pending } = await loadArtist(artist.mbid);
      assert.deepEqual(discography, unscoredPlaid);
      assert.equal(pending, false);
    }
    assert.deepEqual(
      { popularityRequests, metadataRequests },
      { popularityRequests: 1, metadataRequests: 1 },
    );
  });
});

test("artist details fill missing release dates from ListenBrainz and keep the dates they already have", async (t: import("vite-plus/test").TestContext) => {
  const artist = plaid(6);
  const { releases } = artist;
  const listenBrainzDates = {
    [releases.doubleFigure.id]: "2001-05-26",
    [releases.factMix.id]: "2011-09-30",
    [releases.notForThrees.id]: "1997-10-27",
    [releases.polymer.id]: "2019-06",
  };
  const asked: string[][] = [];
  stubPlaid(
    t,
    artist,
    () => json([]),
    (mbids) => {
      asked.push(mbids);
      return json(
        Object.fromEntries(
          mbids.map((mbid) => [
            mbid,
            { release_group: { name: "", type: "Album", date: listenBrainzDates[mbid] ?? null } },
          ]),
        ),
      );
    },
  );

  const { releaseGroups } = await loadArtist(artist.mbid);

  assert.deepEqual(
    releaseGroups.map((releaseGroup) => [releaseGroup.title, releaseGroup["first-release-date"]]),
    [
      ["Double Figure", "2001-05-28"],
      ["FACT Mix 287: Plaid", "2011-09-30"],
      ["Not for Threes", "1997-10-27"],
      ["Polymer", "2019-06"],
      ["Double Figure", null],
    ],
  );
  assert.deepEqual(asked, [
    [
      releases.factMix.id,
      releases.notForThrees.id,
      releases.polymer.id,
      releases.doubleFigureSingle.id,
    ],
  ]);
});

test("artist details that miss the ListenBrainz deadline say so and the next load has the listeners", async (t: import("vite-plus/test").TestContext) => {
  const artist = plaid(5);
  const late = Promise.withResolvers<Response>();
  stubPlaid(t, artist, () => late.promise);
  t.onTestFinished(() => late.resolve(json([])));

  const first = await loadArtist(artist.mbid);
  late.resolve(json(plaidPopularity(artist)));
  const second = await loadArtist(artist.mbid);

  assert.deepEqual(
    { discography: first.discography, pending: first.pending, cacheControl: first.cacheControl },
    { discography: unscoredPlaid, pending: true, cacheControl: "no-store" },
  );
  assert.deepEqual(second.discography, scoredPlaid);
  assert.equal(second.pending, false);
});

test("week-old listeners are served at once while ListenBrainz refreshes them", async (t: import("vite-plus/test").TestContext) => {
  const artist = plaid(7);
  const refresh = Promise.withResolvers<Response>();
  let requests = 0;
  stubPlaid(t, artist, () => {
    requests += 1;
    return requests === 1 ? json(plaidPopularity(artist)) : refresh.promise;
  });
  t.onTestFinished(() => refresh.resolve(json([])));

  await loadArtist(artist.mbid);
  vi.setSystemTime(Date.now() + 8 * 24 * 60 * 60 * 1000);
  const stale = await loadArtist(artist.mbid);

  assert.deepEqual(stale.discography, scoredPlaid);
  assert.equal(stale.pending, false);
  assert.equal(requests, 2);
});

test("a discography of more than a thousand releases is scored in batches ListenBrainz accepts", async (t) => {
  const releaseGroupMbids = Array.from(
    { length: 1001 },
    (_, index) => `88888888-0000-4000-8000-${String(index).padStart(12, "0")}`,
  );
  const batchSizes: number[] = [];
  stubFetch(t, (url, init) => {
    if (!isListenBrainzPopularity(url)) return json({}, 404);
    const { release_group_mbids: mbids }: { release_group_mbids: string[] } = JSON.parse(
      String(requireFixture(init).body),
    );
    batchSizes.push(mbids.length);
    if (mbids.length > 1000) {
      return json(
        {
          code: 400,
          error: "Maximum number of release_group_mbids that can be fetched at once is 1000",
        },
        400,
      );
    }
    return json(
      mbids.map((mbid) => ({
        release_group_mbid: mbid,
        total_listen_count: 20,
        total_user_count: 2,
      })),
    );
  });

  const listens = await listenbrainzGetReleaseGroupListens(releaseGroupMbids);

  assert.equal(listens.size, 1001);
  assert.deepEqual(listens.get(requireFixture(releaseGroupMbids.at(-1))), {
    listenCount: 20,
    listenerCount: 2,
  });
  assert.deepEqual(batchSizes, [1000, 1]);
});
