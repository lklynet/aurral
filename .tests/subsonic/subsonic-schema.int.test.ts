import assert from "node:assert/strict";
import { test, beforeAll, afterAll } from "vite-plus/test";
import { readFile, mkdir, mkdtemp, writeFile } from "node:fs/promises";
import path from "node:path";

import Ajv from "ajv";
import { XmlDocument, XmlElement, XmlValidateError, XsdValidator } from "libxml2-wasm";

import {
  cleanupIsolatedState,
  resetDatabase,
  setupIsolatedBackend,
  startServerProcess,
} from "../helpers/backendTestHarness.ts";

const [
  isolatedState,
  { db },
  { dbOps, userOps },
  { hashPassword },
  { scanMusicRoot },
  { flowPlaylistConfig },
  { downloadTracker },
] = await setupIsolatedBackend(
  "subsonic-schema",
  () => import("../../backend/config/db-sqlite.ts"),
  () => import("../../backend/db/helpers/index.ts"),
  () => import("../../backend/middleware/passwordHash.ts"),
  () => import("../../backend/services/libraryFileScanner.ts"),
  () => import("../../backend/services/playlists/flowPlaylistConfig.ts"),
  () => import("../../backend/services/downloadJobs/downloadTracker.ts"),
);

const spec = JSON.parse(
  await readFile(new URL("./schemas/opensubsonic-openapi.json", import.meta.url), "utf8"),
);
const ajv = new Ajv({ strict: false, validateFormats: false, allErrors: true });
const validators = new Map();

function validatorFor(method: string) {
  if (!validators.has(method)) {
    const operation = spec.paths[`/rest/${method}`]?.get;
    assert.ok(operation, `spec has no GET /rest/${method}`);
    let response = operation.responses["200"];
    if (response.$ref) {
      response = spec.components.responses[response.$ref.replace("#/components/responses/", "")];
    }
    const schema = response.content["application/json"].schema;
    validators.set(method, ajv.compile({ ...schema, components: spec.components }));
  }
  return validators.get(method);
}

type JsonSchema = { $ref?: string; allOf?: JsonSchema[]; properties?: Record<string, unknown> };
const jsonSchemas: Record<string, JsonSchema> = spec.components.schemas;

function jsonSchemaFields(schema: JsonSchema): string[] {
  if (schema.$ref) return jsonSchemaFields(jsonSchemas[schema.$ref.split("/").at(-1) ?? ""] ?? {});
  return [
    ...Object.keys(schema.properties ?? {}),
    ...(schema.allOf ?? []).flatMap(jsonSchemaFields),
  ];
}

const openSubsonicResponseFields = new Set(
  Object.entries(jsonSchemas)
    .filter(([name]) => name.endsWith("SuccessResponse"))
    .flatMap(([, schema]) => jsonSchemaFields(schema)),
);
const openSubsonicNames: Record<string, string> = {
  AlbumWithSongsID3: "AlbumID3WithSongs",
  Error: "SubsonicError",
};

function openSubsonicFields(xsdType: string) {
  if (xsdType === "Response") return openSubsonicResponseFields;
  const schema = jsonSchemas[openSubsonicNames[xsdType] ?? xsdType];
  return new Set(schema ? jsonSchemaFields(schema) : []);
}

const xsdNamespaces = { xs: "http://www.w3.org/2001/XMLSchema" };
const xsd = XmlDocument.fromBuffer(
  await readFile(new URL("./schemas/subsonic-rest-api-1.16.1.xsd", import.meta.url)),
);
const xsdValidator = XsdValidator.fromDoc(xsd);

function xsdElements(node: XmlElement, xpath: string) {
  return node.find(xpath, xsdNamespaces).filter((found) => found instanceof XmlElement);
}

function xsdName(node: XmlElement, attribute: string) {
  return node.attr(attribute)?.value.replace(/^sub:/, "") ?? "";
}

const xsdTypes = new Map(
  xsdElements(xsd.root, "xs:complexType").map((type) => [
    xsdName(type, "name"),
    {
      base: xsdElements(type, ".//xs:extension").map((extension) => xsdName(extension, "base"))[0],
      attributes: xsdElements(type, ".//xs:attribute").map((attribute) =>
        xsdName(attribute, "name"),
      ),
      elements: xsdElements(type, ".//xs:element").map(
        (element) => [xsdName(element, "name"), xsdName(element, "type")] as const,
      ),
    },
  ]),
);

function xsdFields(typeName: string) {
  const attributes = new Set<string>();
  const elements = new Map<string, string>();
  for (
    let type = xsdTypes.get(typeName);
    type;
    type = type.base ? xsdTypes.get(type.base) : undefined
  ) {
    for (const attribute of type.attributes) attributes.add(attribute);
    for (const [name, elementType] of type.elements) elements.set(name, elementType);
  }
  return { attributes, elements };
}

function removeOpenSubsonicAdditions(element: XmlElement, xsdType: string) {
  const declared = xsdFields(xsdType);
  const added = openSubsonicFields(xsdType);
  for (const attribute of element.attrs) {
    if (!declared.attributes.has(attribute.name) && added.has(attribute.name)) attribute.remove();
  }
  const children: XmlElement[] = [];
  for (let child = element.firstChild; child; child = child.next) {
    if (child instanceof XmlElement) children.push(child);
  }
  for (const child of children) {
    const childType = declared.elements.get(child.name);
    if (childType) removeOpenSubsonicAdditions(child, childType);
    else if (added.has(child.name)) child.remove();
  }
}

function xmlSchemaErrors(xml: string) {
  const doc = XmlDocument.fromString(xml);
  try {
    removeOpenSubsonicAdditions(doc.root, "Response");
    xsdValidator.validate(doc);
    return [];
  } catch (error) {
    if (error instanceof XmlValidateError)
      return error.details.map((detail) => detail.message.trim());
    throw error;
  } finally {
    doc.dispose();
  }
}

let aurral: {
  child: import("node:child_process").ChildProcessByStdio<
    null,
    import("node:stream").Readable,
    import("node:stream").Readable
  >;
  port: number;
  logs: () => string;
  stop(): Promise<void>;
};
let fixtureRoot: string;

function subsonicUrl(
  method: string,
  params: Record<string, string | string[]> = {},
  format: "json" | "xml" = "json",
) {
  const query = new URLSearchParams({
    u: "alice",
    p: "password123",
    v: "1.16.1",
    c: "schema-test",
  });
  if (format === "json") query.append("f", "json");
  for (const [key, value] of Object.entries(params)) {
    for (const entry of Array.isArray(value) ? value : [value]) query.append(key, entry);
  }
  return `http://127.0.0.1:${aurral.port}/rest/${method}.view?${query}`;
}

async function call(
  method: string,
  params?: Record<string, string | string[]>,
  format: "json" | "xml" = "json",
) {
  const response = await fetch(subsonicUrl(method, params, format));
  assert.equal(response.status, 200, `${method} HTTP status`);
  return response.text();
}

async function assertValid(method: string, params = {}) {
  const xml = await call(method, params, "xml");
  const xmlErrors = xmlSchemaErrors(xml);
  assert.deepEqual(
    xmlErrors,
    [],
    `${method} response does not match the Subsonic 1.16.1 XML schema:\n${xml.slice(0, 2000)}`,
  );
  return assertValidJson(method, params);
}

async function assertValidJson(method: string, params = {}) {
  const body = JSON.parse(await call(method, params));
  const validate = validatorFor(method);
  assert.ok(
    validate(body),
    `${method} response does not match the OpenSubsonic JSON schema:\n${ajv.errorsText(validate.errors, { separator: "\n" })}\n${JSON.stringify(body).slice(0, 2000)}`,
  );
  return body["subsonic-response"];
}

beforeAll(async () => {
  resetDatabase(db);
  dbOps.updateSettings({
    integrations: { general: { authUser: "alice", authPassword: "password123" } },
    security: { localNetworkBypass: { enabled: false } },
    onboardingComplete: true,
  });
  const alice = userOps.createUser("alice", hashPassword("password123"), "admin");
  assert.ok(alice != null);

  fixtureRoot = await mkdtemp(path.join(isolatedState.baseDir, "media-"));
  const fixturePath = path.join(
    fixtureRoot,
    "Schema Artist",
    "Schema Album",
    "01 Schema Song.flac",
  );
  await mkdir(path.dirname(fixturePath), { recursive: true });
  await writeFile(fixturePath, "0123456789");
  await scanMusicRoot({
    rootPath: fixtureRoot,
    source: "lidarr",
    metadataReader: async () => ({
      common: {
        albumartist: "Schema Artist",
        artist: "Schema Artist",
        album: "Schema Album",
        title: "Schema Song",
        track: { no: 1, of: null },
        genre: ["Rock"],
        musicbrainz_albumartistid: ["11111111-1111-4111-8111-111111111111"],
        musicbrainz_releasegroupid: "22222222-2222-4222-8222-222222222222",
        musicbrainz_recordingid: "33333333-3333-4333-8333-333333333333",
      },
      format: { duration: 10, codec: "FLAC" },
    }),
  });

  const playlist = flowPlaylistConfig.createStaticPlaylist({
    name: "Schema Playlist",
    ownerUserId: alice.id,
    tracks: [
      {
        artistName: "Schema Artist",
        albumName: "Schema Album",
        trackName: "Schema Song",
        durationMs: 10_000,
      },
    ],
  });
  const jobId = downloadTracker.addJob(
    {
      artistName: "Schema Artist",
      albumName: "Schema Album",
      trackName: "Schema Song",
      trackMbid: "33333333-3333-4333-8333-333333333333",
      durationMs: 10_000,
    },
    playlist.id,
  );
  assert.ok(jobId != null);
  downloadTracker.setDone(jobId, fixturePath, "Schema Album");

  aurral = await startServerProcess({ extraEnv: { CORS_ORIGIN: "" } });
});

afterAll(async () => {
  await aurral?.stop();
  await cleanupIsolatedState(isolatedState);
});

test("the schemas reject a malformed response", () => {
  const validate = validatorFor("getSong");
  assert.equal(validate({ "subsonic-response": { status: "ok", version: "1.16.1" } }), false);

  const song = (id: string) =>
    `<subsonic-response xmlns="http://subsonic.org/restapi" status="ok" version="1.16.1" type="Aurral" openSubsonic="true"><song ${id} title="Song" isDir="false" played="2026-01-01T00:00:00Z"><genres name="Rock"/></song></subsonic-response>`;
  assert.deepEqual(xmlSchemaErrors(song('id="1"')), []);
  assert.notDeepEqual(xmlSchemaErrors(song("")), []);
  assert.notDeepEqual(xmlSchemaErrors(song('id="1" mood="calm"')), []);
});

test("system and browsing responses match the Subsonic and OpenSubsonic schemas", async () => {
  await assertValid("ping");
  await assertValid("getLicense");
  await assertValid("getOpenSubsonicExtensions");
  await assertValid("getMusicFolders");
  await assertValid("getScanStatus");
  await assertValid("getNowPlaying");
  await assertValid("getBookmarks");
  await assertValid("getPlayQueue");
  await assertValid("getIndexes");
  await assertValid("getGenres");
  await assertValid("getUser", { username: "alice" });

  const artists = await assertValid("getArtists");
  const artistId = artists.artists.index[0].artist[0].id;
  const artist = await assertValid("getArtist", { id: artistId });
  const albumId = artist.artist.album[0].id;
  const album = await assertValid("getAlbum", { id: albumId });
  const songId = album.album.song[0].id;
  await assertValid("getSong", { id: songId });
  await assertValid("getMusicDirectory", { id: "1" });
  await assertValid("getMusicDirectory", { id: artistId });
  await assertValid("getMusicDirectory", { id: albumId });
  await assertValid("getArtistInfo", { id: artistId });
  await assertValid("getArtistInfo2", { id: artistId });
  await assertValid("getAlbumInfo", { id: albumId });
  await assertValid("getAlbumInfo2", { id: albumId });
  await assertValid("getSimilarSongs", { id: songId });
  await assertValid("getSimilarSongs2", { id: songId });
  await assertValid("getTopSongs", { artist: "Schema Artist" });
  await assertValid("getTopSongs", { id: artistId });
  await assertValid("getLyrics", { artist: "Schema Artist", title: "Schema Song" });
  await assertValid("getLyricsBySongId", { id: "song:missing" });
  await assertValid("getInternetRadioStations");
  await assertValid("getPodcasts");
});

test("list, search, playlist and annotation responses match the Subsonic and OpenSubsonic schemas", async () => {
  await assertValid("getAlbumList", { type: "newest", size: 10 });
  await assertValid("getAlbumList2", { type: "newest", size: 10 });
  await assertValid("getAlbumList2", { type: "alphabeticalByArtist", size: 10 });
  await assertValid("getSongsByGenre", { genre: "Rock" });
  await assertValid("getRandomSongs", { size: 10, genre: "Rock" });
  await assertValid("search3", { query: "Schema" });
  await assertValid("search3", { query: "" });
  await assertValid("search3", {
    query: '""',
    artistOffset: 0,
    artistCount: 500,
    albumOffset: 0,
    albumCount: 0,
    songOffset: 0,
    songCount: 0,
  });
  await assertValid("search2", { query: "Schema" });

  const artists = await assertValid("getArtists");
  const artistId = artists.artists.index[0].artist[0].id;
  const album = (await assertValid("getArtist", { id: artistId })).artist.album[0];
  const songId = (await assertValid("getAlbum", { id: album.id })).album.song[0].id;

  await assertValid("star", { id: songId, albumId: album.id, artistId });
  await assertValid("getStarred");
  await assertValid("getStarred2");
  await assertValid("getSong", { id: songId });
  await assertValid("unstar", { id: songId, albumId: album.id, artistId });
  await assertValid("scrobble", { id: songId, submission: "true" });

  const playlists = await assertValid("getPlaylists");
  const playlistId = playlists.playlists.playlist[0].id;
  await assertValid("getPlaylist", { id: playlistId });
  const created = await assertValidJson("createPlaylist", { name: "Schema Created", songId });
  const createdId = created.playlist.id;
  await assertValidJson("updatePlaylist", { playlistId: createdId, name: "Schema Renamed" });
  await assertValidJson("deletePlaylist", { id: createdId });
});

test("error responses match the Subsonic and OpenSubsonic schemas", async () => {
  await assertValid("getSong", { id: "song:missing" });
  await assertValid("getArtist", { id: "artist:missing" });
  await assertValid("ping", { p: "wrong-password" });
  await assertValid("getTopSongs", { artist: "" });
  const token = await fetch(
    `http://127.0.0.1:${aurral.port}/rest/ping.view?u=alice&t=deadbeef&s=salt&v=1.16.1&c=schema-test&f=json`,
  );
  const body = JSON.parse(await token.text());
  assert.ok(validatorFor("ping")(body), ajv.errorsText(validatorFor("ping").errors));
  assert.equal(body["subsonic-response"].error.code, 41);

  const conflicting = await fetch(
    `http://127.0.0.1:${aurral.port}/rest/ping.view?u=alice&p=password123&t=deadbeef&s=salt&v=1.16.1&c=schema-test&f=json`,
  );
  assert.equal((await conflicting.json())["subsonic-response"].error.code, 43);

  const apiKey = await fetch(
    `http://127.0.0.1:${aurral.port}/rest/ping.view?apiKey=unsupported&v=1.16.1&c=schema-test&f=json`,
  );
  assert.equal((await apiKey.json())["subsonic-response"].error.code, 42);

  const apiKeyWithUsername = await fetch(
    `http://127.0.0.1:${aurral.port}/rest/ping.view?u=alice&apiKey=unsupported&v=1.16.1&c=schema-test&f=json`,
  );
  assert.equal((await apiKeyWithUsername.json())["subsonic-response"].error.code, 43);
});
