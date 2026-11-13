import assert from "node:assert/strict";
import { X509Certificate } from "node:crypto";
import { mkdtempSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import tls from "node:tls";
import { parseBuffer, parseFile } from "music-metadata";
import * as v from "valibot";
import { afterAll, test, vi } from "vite-plus/test";
import { deezerArtistSchema, deezerTrackSchema } from "../../backend/services/apiClients/deezer.ts";
import { listenbrainzTopArtistsSchema } from "../../backend/services/apiClients/listenbrainz.ts";
import { youtubeFindTopSongVideo } from "../../backend/services/apiClients/youtube.ts";
import { implausibleBitrateKbps } from "../../backend/services/trackMatching/candidateNormalizer.ts";
import { loadCatalogue } from "../../eden/catalogue/catalogue.ts";
import { writeSilentFlac } from "../../eden/library/flac.ts";
import { planLibrary, planWorld } from "../../eden/library/generate.ts";
import { createAuthority, hostIssuer } from "../../eden/outside/certificates.ts";
import { previewClip } from "../../eden/outside/deezer.ts";
import { outsideByHost } from "../../eden/outside/index.ts";
import { indexMusic } from "../../eden/outside/music.ts";

const folder = mkdtempSync(path.join(tmpdir(), "aurral-eden-"));
afterAll(() => rmSync(folder, { recursive: true, force: true }));

const catalogue = loadCatalogue();
const music = indexMusic(catalogue);

const ask = (address: string) => {
  const url = new URL(address);
  return outsideByHost.get(url.hostname)?.respond({ url, method: "GET", body: "" }, music);
};

test("a generated track is a FLAC of the exact length that passes the download check", async () => {
  const file = path.join(folder, "track.flac");
  const durationMs = 251_426;
  writeSilentFlac(file, {
    durationMs,
    tags: {
      TITLE: "Everything in Its Right Place",
      ARTIST: "Radiohead",
      GENRE: ["Rock", "Art Rock"],
    },
  });
  const { format, common } = await parseFile(file);
  assert.equal(Math.round((format.duration ?? 0) * 1000), durationMs);
  assert.equal(format.sampleRate, 44_100);
  assert.equal(common.title, "Everything in Its Right Place");
  assert.deepEqual(common.genre, ["Rock", "Art Rock"]);
  assert.equal(
    implausibleBitrateKbps({ path: file, sizeBytes: statSync(file).size, durationMs }),
    null,
  );
});

test("the world offers only albums the Library lacks, the same ones on every run", () => {
  const owned = new Set(planLibrary(catalogue).map((tracks) => tracks[0]?.album.id));
  const world = planWorld(catalogue);
  assert.ok(owned.size > 100);
  assert.ok(world.length > 300);
  assert.deepEqual(
    world.filter((release) => owned.has(release.id)),
    [],
  );
  assert.equal(new Set(world.map((release) => release.name)).size, world.length);
  assert.deepEqual(
    planWorld(catalogue).map((release) => release.name),
    world.map((release) => release.name),
  );
});

test("the certificate authority issues a certificate for the host a client asks for", () => {
  const authority = createAuthority();
  const signer = new X509Certificate(authority.certificate);
  const issue = hostIssuer(authority);
  const issued = new X509Certificate(issue("api.deezer.com").cert);
  assert.equal(signer.ca, true);
  assert.equal(issued.checkIssued(signer), true);
  assert.equal(issued.verify(signer.publicKey), true);
  assert.equal(issued.checkHost("api.deezer.com"), "api.deezer.com");
  assert.equal(issued.checkHost("api.listenbrainz.org"), undefined);
  for (const host of outsideByHost.keys()) tls.createSecureContext(issue(host));
});

test("the outside stand-ins answer in the shapes Aurral's clients read", async () => {
  const artists = v.parse(
    v.object({ data: v.array(deezerArtistSchema) }),
    ask("https://api.deezer.com/search/artist?q=radiohead"),
  ).data;
  assert.equal(artists[0]?.name, "Radiohead");
  assert.equal(artists[0]?.id, 399);
  const top = v.parse(
    v.object({ data: v.array(deezerTrackSchema) }),
    ask(`https://api.deezer.com/artist/${artists[0]?.id}/top?limit=6`),
  ).data;
  assert.equal(top.length, 6);
  assert.ok(top.every((track) => track.artist?.name === "Radiohead" && (track.duration ?? 0) > 0));
  assert.ok(top.every((track) => track.preview?.endsWith(`/deezer/preview/${track.id}.mp3`)));
  const { format } = await parseBuffer(previewClip, "audio/mpeg");
  assert.equal(Math.round(format.duration ?? 0), 30);

  const [fresh] = music.fresh;
  assert.ok(fresh);
  const twoDaysAgo = new Date(Date.now() - 2 * 86_400_000).toISOString().slice(0, 10);
  assert.deepEqual(
    ask(`https://api.listenbrainz.org/1/metadata/release_group?release_group_mbids=${fresh.id}`),
    { [fresh.id]: { release_group: { name: fresh.title, date: twoDaysAgo, type: fresh.type } } },
  );

  const trending = v.parse(
    listenbrainzTopArtistsSchema,
    ask("https://api.listenbrainz.org/1/stats/sitewide/artists?count=5&range=week"),
  );
  assert.equal(trending.payload?.artists?.length, 5);
  assert.deepEqual(ask("https://api.deezer.com/artist/999999"), {
    error: { type: "DataException", message: "no data", code: 800 },
  });
  assert.equal(ask("https://lrclib.net/api/get?artist_name=Nobody&track_name=Nothing"), undefined);
});

test("Aurral's video lookup finds the artist's own video in the YouTube stand-in", async () => {
  vi.stubGlobal("fetch", async (input: string | URL | Request, init?: RequestInit) => {
    const request = new Request(input, init);
    const url = new URL(request.url);
    const answer = outsideByHost
      .get(url.hostname)
      ?.respond({ url, method: request.method, body: await request.text() }, music);
    return Response.json(answer ?? {}, { status: answer === undefined ? 404 : 200 });
  });
  try {
    const video = await youtubeFindTopSongVideo("Radiohead", "Creep");
    assert.match(video?.videoId ?? "", /^[0-9a-z]{11}$/);
    assert.equal(await youtubeFindTopSongVideo("Radiohead", "Not a Radiohead Song"), null);
  } finally {
    vi.unstubAllGlobals();
  }
});
