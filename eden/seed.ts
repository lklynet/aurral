import { setTimeout as delay } from "node:timers/promises";
import * as v from "valibot";
import { AurralApi } from "./aurral.ts";
import { LISTENER, LOGIN, paths, type Ports } from "./state.ts";

const DAY_MS = 24 * 60 * 60 * 1000;
const HISTORY_DAYS = 180;
const SCROBBLE_BATCH = 100;
const SCAN_TIMEOUT_MS = 10 * 60 * 1000;

const scanQueued = v.object({ jobId: v.union([v.string(), v.number()]) });
const scanStatus = v.looseObject({ status: v.string() });
const songList = v.object({
  "subsonic-response": v.looseObject({
    status: v.string(),
    searchResult3: v.optional(
      v.looseObject({
        song: v.optional(
          v.array(v.looseObject({ id: v.string(), albumId: v.optional(v.string()) })),
          [],
        ),
      }),
    ),
  }),
});

// Mulberry32: a small seeded generator, so every Eden gets the same listening history.
function seededRandom(seed: number) {
  let state = seed;
  return () => {
    state = (state + 0x6d2b79f5) | 0;
    let mixed = Math.imul(state ^ (state >>> 15), 1 | state);
    mixed = (mixed + Math.imul(mixed ^ (mixed >>> 7), 61 | mixed)) ^ mixed;
    return ((mixed ^ (mixed >>> 14)) >>> 0) / 4_294_967_296;
  };
}

export async function subsonic(
  ports: Ports,
  user: { username: string; password: string },
  method: string,
  params: [string, string][],
) {
  const query = new URLSearchParams([
    ["u", user.username],
    ["p", user.password],
    ["v", "1.16.1"],
    ["c", "eden"],
    ["f", "json"],
    ...params,
  ]);
  const response = await fetch(`http://127.0.0.1:${ports.aurralApi}/rest/${method}`, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: query,
  });
  if (!response.ok) throw new Error(`Subsonic ${method} answered ${response.status}`);
  const body: unknown = await response.json();
  return body;
}

async function waitForScan(api: AurralApi) {
  const { jobId } = v.parse(scanQueued, await api.post("/library/refresh", { mode: "full" }));
  const deadline = Date.now() + SCAN_TIMEOUT_MS;
  for (;;) {
    const { status } = v.parse(scanStatus, await api.get(`/library/refresh/${jobId}`));
    if (status === "done" || status === "completed") return;
    if (status === "failed") throw new Error("The Library scan failed");
    if (Date.now() > deadline) throw new Error(`The Library scan is still ${status}`);
    await delay(500);
  }
}

// Plays come in album sittings: a listener picks an album and hears a run of its tracks.
async function seedHistory(
  ports: Ports,
  user: { username: string; password: string },
  { seed, sittings }: { seed: number; sittings: number },
) {
  const found = v.parse(
    songList,
    await subsonic(ports, user, "search3", [
      ["query", ""],
      ["songCount", "100000"],
      ["artistCount", "0"],
      ["albumCount", "0"],
    ]),
  );
  const albums = new Map<string, string[]>();
  for (const song of found["subsonic-response"].searchResult3?.song ?? []) {
    const key = song.albumId ?? "";
    albums.set(key, [...(albums.get(key) ?? []), song.id]);
  }
  const albumIds = [...albums.keys()].sort();
  if (albumIds.length === 0) throw new Error("The Library is empty, so there is nothing to play");

  const random = seededRandom(seed);
  const now = Date.now();
  const plays: { id: string; time: number }[] = [];
  for (let sitting = 0; sitting < sittings; sitting += 1) {
    // Squaring the draw favors a few albums, the way real listening does.
    const album = albumIds[Math.floor(random() ** 2 * albumIds.length)] ?? "";
    const songs = albums.get(album) ?? [];
    const start = now - Math.floor(random() * HISTORY_DAYS * DAY_MS);
    const heard = 1 + Math.floor(random() * songs.length);
    songs.slice(0, heard).forEach((id, index) => {
      const time = start + index * 4 * 60 * 1000;
      if (time < now) plays.push({ id, time });
    });
  }
  plays.sort((left, right) => left.time - right.time);
  for (let offset = 0; offset < plays.length; offset += SCROBBLE_BATCH) {
    const batch = plays.slice(offset, offset + SCROBBLE_BATCH);
    await subsonic(ports, user, "scrobble", [
      ...batch.map((play): [string, string] => ["id", play.id]),
      ...batch.map((play): [string, string] => ["time", String(play.time)]),
      ["submission", "true"],
    ]);
  }
  return plays.length;
}

// Eden's proxy answers for these services, so any key and any account are accepted.
const OUTSIDE_KEY = "eden";

const lastfmLink = v.object({ authorizeUrl: v.string() });

// Links a user's Last.fm and ListenBrainz accounts through Eden's stand-ins.
export async function linkListening(ports: Ports, user: { username: string; password: string }) {
  const session = new AurralApi(ports);
  await session.login(user);
  await session.put("/scrobbling/listenbrainz/link", { token: OUTSIDE_KEY });

  // Last.fm sends the browser back to Aurral with a token once the user approves.
  const started = await fetch(`${session.base}/api/scrobbling/lastfm/link`, {
    headers: { authorization: `Bearer ${session.token}` },
  });
  const { authorizeUrl } = v.parse(lastfmLink, await started.json());
  const callback = new URL(new URL(authorizeUrl).searchParams.get("cb") ?? "");
  callback.searchParams.set("token", OUTSIDE_KEY);
  const linked = await fetch(callback, {
    headers: {
      cookie: started.headers
        .getSetCookie()
        .map((cookie) => cookie.split(";")[0])
        .join("; "),
    },
  });
  if (!linked.ok) throw new Error(`Last.fm did not link: ${await linked.text()}`);
}

export async function seedAurral(api: AurralApi, ports: Ports) {
  await api.post("/onboarding/complete", {
    authUser: LOGIN.username,
    authPassword: LOGIN.password,
    downloadFolderPath: paths.library,
  });
  await api.login(LOGIN);
  await api.post("/users", { ...LISTENER, role: "user" });
  await api.post("/settings", {
    integrations: {
      lastfm: { apiKey: OUTSIDE_KEY, apiSecret: OUTSIDE_KEY },
      ticketmaster: { apiKey: OUTSIDE_KEY },
    },
  });
  // The listener links every outside account. The admin stays on Aurral's own history.
  await linkListening(ports, LISTENER);
  await waitForScan(api);
  const plays =
    (await seedHistory(ports, LOGIN, { seed: 1, sittings: 400 })) +
    (await seedHistory(ports, LISTENER, { seed: 2, sittings: 120 }));
  await api.post("/discover/refresh");
  return { plays };
}
