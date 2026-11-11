import assert from "node:assert/strict";
import * as v from "valibot";
import { test } from "vite-plus/test";
import { subsonic } from "../seed.ts";
import { LOGIN } from "../state.ts";
import { api, ports, until } from "./eden.ts";

const answer = <Entries extends v.ObjectEntries>(entries: Entries) =>
  v.object({ "subsonic-response": v.looseObject({ status: v.literal("ok"), ...entries }) });

test("a Subsonic client browses the seeded Library and plays a track", async () => {
  const artists = v
    .parse(
      answer({
        artists: v.looseObject({
          index: v.array(v.looseObject({ artist: v.array(v.looseObject({ name: v.string() })) })),
        }),
      }),
      await subsonic(ports, LOGIN, "getArtists", []),
    )
    ["subsonic-response"].artists.index.flatMap((letter) => letter.artist);
  assert.ok(artists.length > 50);

  const found = v.parse(
    answer({
      searchResult3: v.looseObject({
        song: v.array(v.looseObject({ id: v.string(), duration: v.number() })),
      }),
    }),
    await subsonic(ports, LOGIN, "search3", [
      ["query", "Radiohead"],
      ["songCount", "1"],
      ["artistCount", "0"],
      ["albumCount", "0"],
    ]),
  )["subsonic-response"].searchResult3.song[0];
  assert.ok(found && found.duration > 0);

  const played = v.parse(
    answer({ albumList2: v.looseObject({ album: v.array(v.looseObject({ id: v.string() })) }) }),
    await subsonic(ports, LOGIN, "getAlbumList2", [
      ["type", "frequent"],
      ["size", "10"],
    ]),
  )["subsonic-response"].albumList2.album;
  assert.equal(played.length, 10);

  const stream = await fetch(
    `http://127.0.0.1:${ports.aurralApi}/rest/stream?${new URLSearchParams({
      u: LOGIN.username,
      p: LOGIN.password,
      v: "1.16.1",
      c: "eden",
      id: found.id,
    })}`,
    { headers: { range: "bytes=0-3" } },
  );
  assert.equal(stream.status, 206);
  assert.equal(await stream.text(), "fLaC");
});

test("search, lyrics, discovery and charts fill from Eden's catalogue", async () => {
  const search = v.parse(
    v.looseObject({ top: v.looseObject({ type: v.string(), name: v.string() }) }),
    await api.get("/search/unified?q=daft+punk&limit=5"),
  );
  assert.deepEqual(search.top, { ...search.top, type: "artist", name: "Daft Punk" });

  const { lyrics } = v.parse(
    v.looseObject({
      lyrics: v.looseObject({ synced: v.boolean(), lines: v.array(v.looseObject({})) }),
    }),
    await api.get("/lyrics?artist=Radiohead&title=Airbag"),
  );
  assert.equal(lyrics.synced, true);
  assert.ok(lyrics.lines.length > 5);

  const page = v.looseObject({ recommendations: v.array(v.unknown()) });
  await api.post("/discover/refresh");
  await until("discovery to recommend artists", async () => {
    return v.parse(page, await api.get("/discover")).recommendations.length > 0;
  });

  const charts = v.looseObject({
    songs: v.nullable(v.looseObject({})),
    genres: v.array(v.unknown()),
  });
  await until(
    "the trending charts to fill",
    async () => {
      const trending = v.parse(charts, await api.get("/discover/trending"));
      return trending.songs !== null && trending.genres.length > 0;
    },
    240_000,
  );
});
