import { setupIsolatedBackend, cleanupIsolatedState, startServerProcess } from "./backendTestHarness.js";

export async function createAlbumActivityFixture() {
  const [state, { dbOps, userOps }, { downloadTracker }, { recordAlbumGrabQueued, recordAlbumGrabPhase, recordAlbumTrackState }, { hashPassword }] = await setupIsolatedBackend(
    "album-activity-browser",
    "backend/db/helpers/index.js",
    "backend/services/downloadJobs/downloadTracker.js",
    "backend/services/albumGrabActivity.js",
    "backend/middleware/passwordHash.js",
  );
  const username = "album-activity-test";
  const password = "disposable-album-activity-password";
  userOps.createUser(username, hashPassword(password), "admin");
  dbOps.updateSettings({ ...dbOps.getSettings(), onboardingComplete: true, integrations: {},
    security: { localNetworkBypassEnabled: false } });
  const titles = ["Everything_Now (continued)", "Everything Now", "Signs of Life", "Creature Comfort",
    "Peter Pan", "Chemistry", "Infinite Content", "Infinite_Content", "Electric Blue",
    "Good God Damn", "Put Your Money on Me", "We Don't Deserve Love", "Everything Now (continued)"];
  const ids = titles.map((trackName, index) => downloadTracker.addJob({
    artistName: "Arcade Fire", albumName: "Everything Now", albumMbid: "browser-everything-now",
    trackName, trackNumber: index + 1, requestGroupId: "browser-full-album",
  }, "library"));
  const payload = { albumGrab: true, jobId: ids[0], albumGroupJobIds: ids, phase: "poll", source: "slskd" };
  recordAlbumGrabQueued(payload, ids.map((id) => downloadTracker.getJob(id)));
  recordAlbumGrabPhase(payload);
  for (const id of ids) downloadTracker.setDownloading(id);

  const blockedIds = ["Ready track", "Needs review"].map((trackName, index) => downloadTracker.addJob({
    artistName: "Disposable Artist", albumName: "Partial album", albumMbid: "browser-partial",
    trackName, trackNumber: index + 1, requestGroupId: "browser-partial-album",
  }, "library"));
  const partialPayload = { albumGrab: true, jobId: blockedIds[0], albumGroupJobIds: blockedIds, phase: "finalize", source: "deemix" };
  recordAlbumGrabQueued(partialPayload, blockedIds.map((id) => downloadTracker.getJob(id)));
  downloadTracker.setDone(blockedIds[0], `${state.baseDir}/ready.flac`);
  recordAlbumTrackState(downloadTracker.getJob(blockedIds[0]), "deemix");
  downloadTracker.setBlocked(blockedIds[1], "Identity needs review", `${state.baseDir}/review.flac`);
  recordAlbumGrabPhase(partialPayload, "Album was incomplete; remaining tracks need review");
  for (const trackName of ["Individual first", "Individual second"]) {
    downloadTracker.addJob({ artistName: "Disposable Artist", albumName: "Track-only album", trackName,
      requestGroupId: "browser-track-only", albumMbid: "browser-track-only" }, "library");
  }
  let server = await startServerProcess({ extraEnv: { AUTH_PASSWORD: "", AUTH_PROXY_ENABLED: "false" } });
  return {
    state,
    username,
    password,
    get port() { return server.port; },
    async completeAlbum() {
      for (const id of ids) {
        downloadTracker.updateDownloadMetadata(id, { downloadSource: "slskd" });
        downloadTracker.setDone(id, `${state.baseDir}/${id}.flac`);
        recordAlbumTrackState(downloadTracker.getJob(id), "slskd");
      }
      downloadTracker.clearCompleted();
      const port = server.port;
      await server.stop();
      server = await startServerProcess({ port, extraEnv: { AUTH_PASSWORD: "", AUTH_PROXY_ENABLED: "false" } });
    },
    async stop() {
      await server.stop();
      await cleanupIsolatedState(state);
    },
  };
}
