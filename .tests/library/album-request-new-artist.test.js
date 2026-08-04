import test from "node:test";
import assert from "node:assert/strict";
import http from "node:http";

import { libraryManager } from "../../backend/services/libraryManager.js";
import { lidarrClient } from "../../backend/services/lidarrClient.js";

async function readJsonBody(req) {
  const chunks = [];
  for await (const chunk of req) chunks.push(chunk);
  if (chunks.length === 0) return {};
  return JSON.parse(Buffer.concat(chunks).toString("utf8"));
}

function json(res, statusCode, payload) {
  res.writeHead(statusCode, { "Content-Type": "application/json" });
  res.end(JSON.stringify(payload));
}

async function withFakeLidarr(buildState, run) {
  const state = {
    artist: null,
    albums: [],
    commands: [],
    albumPostConflicts: 0,
    ...buildState(),
  };

  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url || "/", "http://127.0.0.1");
    const { pathname } = url;

    if (req.method === "GET" && pathname === "/api/v1/artist/7") {
      return json(res, 200, state.artist);
    }
    if (req.method === "GET" && pathname === "/api/v1/artist") {
      return json(res, 200, state.artist ? [state.artist] : []);
    }
    if (req.method === "PUT" && pathname === "/api/v1/artist/7") {
      const payload = await readJsonBody(req);
      state.artist = { ...state.artist, ...payload, id: 7 };
      return json(res, 200, state.artist);
    }
    if (req.method === "GET" && pathname === "/api/v1/album") {
      const foreignAlbumId = url.searchParams.get("foreignAlbumId");
      const artistId = url.searchParams.get("artistId");
      let albums = state.albums;
      if (foreignAlbumId) {
        albums = albums.filter(
          (album) =>
            String(album.foreignAlbumId).toLowerCase() ===
            foreignAlbumId.toLowerCase(),
        );
      }
      if (artistId) {
        albums = albums.filter((album) => String(album.artistId) === String(artistId));
      }
      return json(res, 200, albums);
    }
    if (req.method === "GET" && pathname.startsWith("/api/v1/album/")) {
      const id = pathname.split("/").pop();
      const album = state.albums.find((entry) => String(entry.id) === id);
      if (!album) return json(res, 404, { message: "Not Found" });
      return json(res, 200, album);
    }
    if (req.method === "PUT" && pathname.startsWith("/api/v1/album/")) {
      const id = pathname.split("/").pop();
      const payload = await readJsonBody(req);
      const index = state.albums.findIndex((entry) => String(entry.id) === id);
      if (index === -1) return json(res, 404, { message: "Not Found" });
      state.albums[index] = { ...state.albums[index], ...payload, id: Number(id) };
      return json(res, 200, state.albums[index]);
    }
    if (req.method === "POST" && pathname === "/api/v1/album") {
      const payload = await readJsonBody(req);
      const existing = state.albums.find(
        (album) =>
          String(album.foreignAlbumId).toLowerCase() ===
          String(payload.foreignAlbumId).toLowerCase(),
      );
      if (existing) {
        state.albumPostConflicts += 1;
        return json(res, 400, [
          {
            propertyName: "ForeignAlbumId",
            errorMessage: "This album has already been added.",
            attemptedValue: payload.foreignAlbumId,
            errorCode: "AlbumExistsValidator",
          },
        ]);
      }
      const album = {
        id: 42,
        title: payload.title,
        foreignAlbumId: payload.foreignAlbumId,
        artistId: 7,
        monitored: payload.monitored !== false,
        statistics: { percentOfTracks: 0, sizeOnDisk: 0 },
      };
      state.albums.push(album);
      return json(res, 201, album);
    }
    if (req.method === "POST" && pathname === "/api/v1/command") {
      const payload = await readJsonBody(req);
      state.commands.push(payload);
      return json(res, 201, { id: state.commands.length, ...payload, status: "queued" });
    }
    return json(res, 404, { message: `unexpected ${req.method} ${pathname}` });
  });

  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = server.address().port;

  const previousHold = lidarrClient._holdConfig;
  const previousConfig = lidarrClient.config;
  lidarrClient._holdConfig = true;
  lidarrClient.config = {
    url: `http://127.0.0.1:${port}`,
    apiKey: "test",
    allowHttp: true,
    timeoutMs: 2000,
    circuitDisabled: true,
  };
  lidarrClient.isConfigured = () => true;

  try {
    await run(state);
  } finally {
    lidarrClient._holdConfig = previousHold;
    lidarrClient.config = previousConfig;
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
  }
}

test("new-artist album request queues AlbumSearch even when Lidarr already created the album", async () => {
  const originalGetArtist = libraryManager.getArtist;
  const originalResolveArtistAddOptions = libraryManager.resolveArtistAddOptions;
  const originalAddArtistWithResolvedOptions =
    libraryManager.addArtistWithResolvedOptions;
  const originalEnsureArtistMonitored = libraryManager.ensureArtistMonitored;
  const originalScheduleRequestedAlbumMonitoringRepair =
    libraryManager.scheduleRequestedAlbumMonitoringRepair;

  await withFakeLidarr(
    () => ({
      artist: {
        id: 7,
        artistName: "Alela Diane",
        foreignArtistId: "artist-mbid",
        monitored: true,
        monitor: "none",
      },
      albums: [
        {
          id: 42,
          title: "The Pirate's Gospel",
          foreignAlbumId: "album-mbid",
          artistId: 7,
          monitored: true,
          statistics: { percentOfTracks: 0, sizeOnDisk: 0 },
        },
      ],
    }),
    async (state) => {
      libraryManager.getArtist = async () => null;
      libraryManager.resolveArtistAddOptions = async () => ({
        quality: "standard",
        monitorOption: "none",
        rootFolderPath: "/music",
        qualityProfileId: 1,
      });
      libraryManager.addArtistWithResolvedOptions = async () => ({
        id: "7",
        mbid: "artist-mbid",
        foreignArtistId: "artist-mbid",
        artistName: "Alela Diane",
        monitored: true,
        monitorOption: "none",
      });
      libraryManager.ensureArtistMonitored = async (artist) => artist;
      libraryManager.scheduleRequestedAlbumMonitoringRepair = () => {};

      try {
        const result = await libraryManager.requestAlbumFromSearch({
          albumMbid: "album-mbid",
          albumName: "The Pirate's Gospel",
          artistMbid: "artist-mbid",
          artistName: "Alela Diane",
          triggerSearch: true,
          user: {
            role: "user",
            permissions: { addAlbum: true, addArtist: true },
          },
        });

        assert.equal(result.success, true);
        assert.equal(result.createdArtist, true);
        assert.equal(String(result.album.id), "42");
        assert.equal(
          state.commands.some(
            (command) =>
              command.name === "AlbumSearch" &&
              Array.isArray(command.albumIds) &&
              command.albumIds.map(String).includes("42"),
          ),
          true,
          `expected AlbumSearch for album 42, got ${JSON.stringify(state.commands)}`,
        );
      } finally {
        libraryManager.getArtist = originalGetArtist;
        libraryManager.resolveArtistAddOptions = originalResolveArtistAddOptions;
        libraryManager.addArtistWithResolvedOptions =
          originalAddArtistWithResolvedOptions;
        libraryManager.ensureArtistMonitored = originalEnsureArtistMonitored;
        libraryManager.scheduleRequestedAlbumMonitoringRepair =
          originalScheduleRequestedAlbumMonitoringRepair;
      }
    },
  );
});

test("new-artist album request recovers from AlbumExistsValidator and still searches", async () => {
  const originalGetArtist = libraryManager.getArtist;
  const originalResolveArtistAddOptions = libraryManager.resolveArtistAddOptions;
  const originalAddArtistWithResolvedOptions =
    libraryManager.addArtistWithResolvedOptions;
  const originalEnsureArtistMonitored = libraryManager.ensureArtistMonitored;
  const originalScheduleRequestedAlbumMonitoringRepair =
    libraryManager.scheduleRequestedAlbumMonitoringRepair;

  await withFakeLidarr(
    () => ({
      artist: {
        id: 7,
        artistName: "Alela Diane",
        foreignArtistId: "artist-mbid",
        monitored: true,
        monitor: "none",
      },
      albums: [],
    }),
    async (state) => {
      let foreignLookups = 0;

      libraryManager.getArtist = async () => null;
      libraryManager.resolveArtistAddOptions = async () => ({
        quality: "standard",
        monitorOption: "none",
        rootFolderPath: "/music",
        qualityProfileId: 1,
      });
      libraryManager.addArtistWithResolvedOptions = async () => {
        state.albums.push({
          id: 42,
          title: "The Pirate's Gospel",
          foreignAlbumId: "album-mbid",
          artistId: 7,
          monitored: false,
          statistics: { percentOfTracks: 0, sizeOnDisk: 0 },
        });
        return {
          id: "7",
          mbid: "artist-mbid",
          foreignArtistId: "artist-mbid",
          artistName: "Alela Diane",
          monitored: true,
          monitorOption: "none",
        };
      };
      libraryManager.ensureArtistMonitored = async (artist) => artist;
      libraryManager.scheduleRequestedAlbumMonitoringRepair = () => {};

      const originalGetAlbumByMbid = lidarrClient.getAlbumByMbid.bind(lidarrClient);
      lidarrClient.getAlbumByMbid = async (albumMbid, options = {}) => {
        foreignLookups += 1;
        if (foreignLookups <= 2) return undefined;
        return originalGetAlbumByMbid(albumMbid, options);
      };

      try {
        const result = await libraryManager.requestAlbumFromSearch({
          albumMbid: "album-mbid",
          albumName: "The Pirate's Gospel",
          artistMbid: "artist-mbid",
          artistName: "Alela Diane",
          triggerSearch: true,
          user: {
            role: "user",
            permissions: { addAlbum: true, addArtist: true },
          },
        });

        assert.equal(result.success, true);
        assert.equal(state.albumPostConflicts >= 1, true);
        assert.equal(
          state.commands.some(
            (command) =>
              command.name === "AlbumSearch" &&
              Array.isArray(command.albumIds) &&
              command.albumIds.map(String).includes("42"),
          ),
          true,
          `expected AlbumSearch after conflict, got ${JSON.stringify(state.commands)}`,
        );
        const album = state.albums.find((entry) => entry.id === 42);
        assert.equal(album?.monitored, true);
      } finally {
        lidarrClient.getAlbumByMbid = originalGetAlbumByMbid;
        libraryManager.getArtist = originalGetArtist;
        libraryManager.resolveArtistAddOptions = originalResolveArtistAddOptions;
        libraryManager.addArtistWithResolvedOptions =
          originalAddArtistWithResolvedOptions;
        libraryManager.ensureArtistMonitored = originalEnsureArtistMonitored;
        libraryManager.scheduleRequestedAlbumMonitoringRepair =
          originalScheduleRequestedAlbumMonitoringRepair;
      }
    },
  );
});
