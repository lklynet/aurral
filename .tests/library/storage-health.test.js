import test from "node:test";
import assert from "node:assert/strict";
import fs from "fs/promises";
import path from "path";

import {
  setupIsolatedBackend,
  cleanupIsolatedState,
  createMockHttpServer,
  importFromRepo,
  resetDatabase,
} from "../helpers/backendTestHarness.js";

const previousFileBrowseRoots = process.env.FILE_BROWSE_ROOTS;
const previousPathMappings = process.env.PATH_MAPPINGS;

const [isolatedState, { db }, { dbOps }, { runStorageHealthCheck }, { resolvePlaylistRoot }] =
  await setupIsolatedBackend(
    "storage-health",
    "backend/config/db-sqlite.js",
    "backend/db/helpers/index.js",
    "backend/services/storageHealthService.js",
    "backend/services/playlistPaths.js",
  );

test.beforeEach(async () => {
  await resetDatabase(db);
  const { downloadTracker } = await importFromRepo(
    "backend/services/weeklyFlow/weeklyFlowDownloadTracker.js",
  );
  downloadTracker.clearAll();
  const downloadFolder = process.env.DOWNLOAD_FOLDER;
  await fs.mkdir(downloadFolder, { recursive: true });
  process.env.FILE_BROWSE_ROOTS = downloadFolder;
  delete process.env.PATH_MAPPINGS;
  dbOps.updateSettings({
    ...dbOps.getSettings(),
    integrations: {},
    pathMappings: [],
    downloadFolderPath: downloadFolder,
  });
});

test.after(async () => {
  if (previousFileBrowseRoots === undefined) {
    delete process.env.FILE_BROWSE_ROOTS;
  } else {
    process.env.FILE_BROWSE_ROOTS = previousFileBrowseRoots;
  }
  if (previousPathMappings === undefined) {
    delete process.env.PATH_MAPPINGS;
  } else {
    process.env.PATH_MAPPINGS = previousPathMappings;
  }
  await cleanupIsolatedState(isolatedState);
});

test("runStorageHealthCheck passes when downloads folder is writable", async () => {
  const result = await runStorageHealthCheck();
  const downloads = result.sections.find((section) => section.id === "downloads");
  assert.ok(downloads);
  assert.equal(downloads.status, "pass");
  assert.equal(result.ok, true);
});

test("runStorageHealthCheck fails when completed playlist files are missing", async () => {
  const { downloadTracker } = await importFromRepo(
    "backend/services/weeklyFlow/weeklyFlowDownloadTracker.js",
  );
  const playlistRoot = resolvePlaylistRoot();
  const missingPath = path.join(
    playlistRoot,
    "aurral-weekly-flow",
    "health-playlist",
    "Artist",
    "Album",
    "missing-track.flac",
  );
  const jobId = downloadTracker.addJob(
    { artistName: "Artist", trackName: "Song" },
    "health-playlist",
  );
  downloadTracker.setDone(jobId, missingPath, "Album");

  const result = await runStorageHealthCheck();
  const playlists = result.sections.find((section) => section.id === "playlists");
  assert.ok(playlists);
  assert.equal(playlists.status, "fail");
  assert.equal(result.ok, false);
});

test("runStorageHealthCheck passes when completed playlist files exist", async () => {
  const { downloadTracker } = await importFromRepo(
    "backend/services/weeklyFlow/weeklyFlowDownloadTracker.js",
  );
  const playlistRoot = resolvePlaylistRoot();
  const trackPath = path.join(
    playlistRoot,
    "aurral-weekly-flow",
    "health-playlist-ok",
    "Artist",
    "Album",
    "present-track.flac",
  );
  await fs.mkdir(path.dirname(trackPath), { recursive: true });
  await fs.writeFile(trackPath, "audio");
  const jobId = downloadTracker.addJob(
    { artistName: "Artist", trackName: "Present" },
    "health-playlist-ok",
  );
  downloadTracker.setDone(jobId, trackPath, "Album");

  const result = await runStorageHealthCheck();
  const playlists = result.sections.find((section) => section.id === "playlists");
  assert.ok(playlists);
  assert.equal(playlists.status, "pass");
});

test("runStorageHealthCheck warns when completed playlist files are empty", async () => {
  const { downloadTracker } = await importFromRepo(
    "backend/services/weeklyFlow/weeklyFlowDownloadTracker.js",
  );
  const playlistRoot = resolvePlaylistRoot();
  const trackPath = path.join(
    playlistRoot,
    "aurral-weekly-flow",
    "health-playlist-empty",
    "Artist",
    "Album",
    "empty-track.flac",
  );
  await fs.mkdir(path.dirname(trackPath), { recursive: true });
  await fs.writeFile(trackPath, "");
  const jobId = downloadTracker.addJob(
    { artistName: "Artist", trackName: "Empty" },
    "health-playlist-empty",
  );
  downloadTracker.setDone(jobId, trackPath, "Album");

  const result = await runStorageHealthCheck();
  const playlists = result.sections.find((section) => section.id === "playlists");
  assert.ok(playlists);
  assert.equal(playlists.status, "warn");
  assert.equal(
    playlists.steps.some(
      (step) => step.id === "tracked-nonempty" && step.status === "warn",
    ),
    true,
  );
});

test("runStorageHealthCheck fails when a path mapping local folder is missing", async () => {
  dbOps.updateSettings({
    ...dbOps.getSettings(),
    pathMappings: [
      {
        source: "lidarr",
        remote: "/mnt/music",
        local: path.join(isolatedState.baseDir, "missing-mapped-music"),
      },
    ],
  });

  const result = await runStorageHealthCheck();
  const mappings = result.sections.find((section) => section.id === "path-mappings");
  assert.ok(mappings);
  assert.equal(mappings.status, "fail");
  assert.equal(result.ok, false);
});

test("runStorageHealthCheck skips optional integrations when unset", async () => {
  const result = await runStorageHealthCheck();
  const slskd = result.sections.find((section) => section.id === "slskd");
  const navidrome = result.sections.find((section) => section.id === "navidrome");
  assert.equal(slskd?.status, "skip");
  assert.equal(navidrome?.status, "skip");
});

test("runStorageHealthCheck passes shared volume when dedicated browse roots exist", async () => {
  const result = await runStorageHealthCheck();
  const volume = result.sections.find((section) => section.id === "volume");
  assert.ok(volume);
  const sharedMount = volume.steps.find((step) => step.id === "shared-mount");
  assert.ok(sharedMount);
  assert.equal(sharedMount.status, "pass");
});

test("runStorageHealthCheck skips playlist verification before any tracks complete", async () => {
  const result = await runStorageHealthCheck({ force: true });
  const playlists = result.sections.find((section) => section.id === "playlists");

  assert.equal(playlists?.status, "skip");
  assert.match(playlists?.skipReason || "", /no completed playlist tracks/i);
});

test("runStorageHealthCheck does not warn about preferred shared-root conventions", async () => {
  const unrelatedBrowseRoot = path.join(isolatedState.baseDir, "browse-only");
  await fs.mkdir(unrelatedBrowseRoot, { recursive: true });
  process.env.FILE_BROWSE_ROOTS = unrelatedBrowseRoot;

  const result = await runStorageHealthCheck({ force: true });
  const volume = result.sections.find((section) => section.id === "volume");
  const downloads = result.sections.find((section) => section.id === "downloads");

  assert.equal(volume?.status, "pass");
  assert.equal(downloads?.status, "pass");
  assert.equal(downloads?.steps.some((step) => step.id === "shared-root"), false);
});

test("passing checks never include remediation text", async () => {
  const result = await runStorageHealthCheck({ force: true });
  const passingSteps = result.sections.flatMap((section) => section.steps || []).filter(
    (step) => step.status === "pass",
  );

  assert.ok(passingSteps.length > 0);
  assert.equal(passingSteps.some((step) => Boolean(step.fix)), false);
});

test("NZBGet health verifies the real Aurral transfer instead of filesystem identity", async (t) => {
  const completedPath = path.join(isolatedState.baseDir, "nzbget-complete");
  await fs.mkdir(completedPath, { recursive: true });
  const server = await createMockHttpServer((request, response) => {
    let body = "";
    request.on("data", (chunk) => {
      body += chunk;
    });
    request.on("end", () => {
      const method = JSON.parse(body || "{}").method;
      const result = method === "version" ? "24.1" : method === "config" ? [] : {};
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify({ jsonrpc: "2.0", id: 1, result }));
    });
  });
  t.after(server.close);
  dbOps.updateSettings({
    ...dbOps.getSettings(),
    integrations: {
      ...dbOps.getSettings().integrations,
      nzbget: {
        enabled: true,
        url: server.url,
        completedPath,
      },
    },
  });

  const result = await runStorageHealthCheck({ force: true });
  const nzbget = result.sections.find((section) => section.id === "nzbget");
  const transfer = nzbget?.steps.find((step) => step.id === "transfer");

  assert.equal(nzbget?.status, "pass");
  assert.equal(transfer?.status, "pass");
  assert.match(transfer?.detail || "", /verified (atomic move|copy and delete)/i);
  assert.equal(nzbget?.steps.some((step) => step.id === "same-filesystem"), false);
  assert.equal(nzbget?.steps.some((step) => step.id === "sample-file"), false);
  assert.deepEqual(await fs.readdir(completedPath), []);
});

test("download-client health fails when the reported path cannot perform a transfer", async (t) => {
  const completedPath = path.join(isolatedState.baseDir, "not-a-completed-directory");
  await fs.writeFile(completedPath, "readable but not transferable");
  const server = await createMockHttpServer((request, response) => {
    let body = "";
    request.on("data", (chunk) => {
      body += chunk;
    });
    request.on("end", () => {
      const method = JSON.parse(body || "{}").method;
      const result = method === "version" ? "24.1" : method === "config" ? [] : {};
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify({ jsonrpc: "2.0", id: 1, result }));
    });
  });
  t.after(server.close);
  dbOps.updateSettings({
    ...dbOps.getSettings(),
    integrations: {
      ...dbOps.getSettings().integrations,
      nzbget: { enabled: true, url: server.url, completedPath },
    },
  });

  const result = await runStorageHealthCheck({ force: true });
  const nzbget = result.sections.find((section) => section.id === "nzbget");
  const transfer = nzbget?.steps.find((step) => step.id === "transfer");

  assert.equal(nzbget?.status, "fail");
  assert.equal(transfer?.status, "fail");
  assert.match(transfer?.detail || "", /(ENOTDIR|not a directory)/i);
});

test("slskd missing-path remediation points to slskd rather than a nonexistent Aurral field", async (t) => {
  const server = await createMockHttpServer((request, response) => {
    response.writeHead(200, { "content-type": "application/json" });
    if (request.url?.startsWith("/api/v0/application")) {
      response.end(JSON.stringify({ server: { state: "Connected", isConnected: true } }));
      return;
    }
    response.end(JSON.stringify({ directories: {} }));
  });
  t.after(server.close);
  dbOps.updateSettings({
    ...dbOps.getSettings(),
    integrations: {
      ...dbOps.getSettings().integrations,
      slskd: { enabled: true, url: server.url, apiKey: "test-key" },
    },
  });

  const result = await runStorageHealthCheck({ force: true });
  const slskd = result.sections.find((section) => section.id === "slskd");
  const configured = slskd?.steps.find((step) => step.id === "path-reported");

  assert.equal(configured?.status, "warn");
  assert.match(configured?.fix || "", /configure.*slskd/i);
  assert.doesNotMatch(configured?.fix || "", /Settings .* Download Clients .* slskd/i);
});

test("unrelated Navidrome libraries do not fail local storage health", async (t) => {
  const playlistLibrary = path.join(resolvePlaylistRoot(), "aurral-weekly-flow");
  const server = await createMockHttpServer((request, response) => {
    response.writeHead(200, { "content-type": "application/json" });
    if (request.url?.startsWith("/rest/ping")) {
      response.end(JSON.stringify({ "subsonic-response": { status: "ok" } }));
      return;
    }
    if (request.url === "/auth/login") {
      response.end(JSON.stringify({ token: "test-token" }));
      return;
    }
    response.end(
      JSON.stringify([
        { id: "1", name: "Aurral", path: playlistLibrary },
        { id: "2", name: "Podcasts", path: "/navidrome-only/podcasts" },
      ]),
    );
  });
  t.after(server.close);
  dbOps.updateSettings({
    ...dbOps.getSettings(),
    integrations: {
      ...dbOps.getSettings().integrations,
      navidrome: {
        url: server.url,
        username: "user",
        password: "password",
      },
    },
  });

  const result = await runStorageHealthCheck({ force: true });
  const navidrome = result.sections.find((section) => section.id === "navidrome");

  assert.notEqual(navidrome?.status, "fail");
  assert.equal(
    navidrome?.steps.some((step) => step.status === "fail" && /podcasts/i.test(step.detail || "")),
    false,
  );
});

test("configured Plex is included and validates its Aurral library path", async (t) => {
  const expectedPath = path.join(resolvePlaylistRoot(), "aurral-weekly-flow");
  const server = await createMockHttpServer((request, response) => {
    response.writeHead(200, { "content-type": "application/json" });
    if (request.url?.startsWith("/identity")) {
      response.end(JSON.stringify({ MediaContainer: { machineIdentifier: "plex-test" } }));
      return;
    }
    response.end(
      JSON.stringify({
        MediaContainer: {
          Directory: [{ key: "7", title: "Aurral", Location: [{ path: expectedPath }] }],
        },
      }),
    );
  });
  t.after(server.close);
  dbOps.updateSettings({
    ...dbOps.getSettings(),
    integrations: {
      ...dbOps.getSettings().integrations,
      plex: { url: server.url, token: "test-token", clientId: "test-client" },
    },
  });

  const result = await runStorageHealthCheck({ force: true });
  const plex = result.sections.find((section) => section.id === "plex");

  assert.equal(plex?.status, "pass");
  assert.equal(plex?.steps.find((step) => step.id === "aurral-library")?.status, "pass");
});

test("POSIX library paths remain case-sensitive", async (t) => {
  const expectedPath = path.join(resolvePlaylistRoot(), "aurral-weekly-flow");
  const wrongCasePath = expectedPath.replace(/aurral-weekly-flow$/, "AURRAL-WEEKLY-FLOW");
  const server = await createMockHttpServer((request, response) => {
    response.writeHead(200, { "content-type": "application/json" });
    if (request.url?.startsWith("/rest/ping")) {
      response.end(JSON.stringify({ "subsonic-response": { status: "ok" } }));
      return;
    }
    if (request.url === "/auth/login") {
      response.end(JSON.stringify({ token: "test-token" }));
      return;
    }
    response.end(JSON.stringify([{ id: "1", name: "Wrong case", path: wrongCasePath }]));
  });
  t.after(server.close);
  dbOps.updateSettings({
    ...dbOps.getSettings(),
    integrations: {
      ...dbOps.getSettings().integrations,
      navidrome: {
        url: server.url,
        username: "user",
        password: "password",
      },
    },
  });

  const result = await runStorageHealthCheck({ force: true });
  const navidrome = result.sections.find((section) => section.id === "navidrome");

  assert.equal(navidrome?.steps.find((step) => step.id === "aurral-library")?.status, "warn");
});
