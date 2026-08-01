import test from "node:test";
import assert from "node:assert/strict";

import { normalizeAlbumReleaseTypesFilter } from "../../backend/services/searchService.js";
import { libraryManager } from "../../backend/services/libraryManager.js";
import { lidarrClient } from "../../backend/services/lidarrClient.js";

test("normalizeAlbumReleaseTypesFilter removes invalid and duplicate release types", () => {
  assert.deepEqual(
    normalizeAlbumReleaseTypesFilter("Album,Live,Album,Invalid"),
    ["Album", "Live"],
  );
});

test("requestAlbumFromSearch resolves artist add settings and triggers search", async () => {
  const originalIsConfigured = lidarrClient.isConfigured;
  const originalGetAlbumByMbid = lidarrClient.getAlbumByMbid;
  const originalGetArtist = libraryManager.getArtist;
  const originalResolveArtistAddOptions = libraryManager.resolveArtistAddOptions;
  const originalAddArtistWithResolvedOptions =
    libraryManager.addArtistWithResolvedOptions;
  const originalWaitForAlbumByMbidForArtist =
    libraryManager.waitForAlbumByMbidForArtist;
  const originalAddAlbum = libraryManager.addAlbum;

  lidarrClient.isConfigured = () => true;
  lidarrClient.getAlbumByMbid = async () => null;
  libraryManager.getArtist = async () => null;
  libraryManager.resolveArtistAddOptions = async () => ({
    quality: "standard",
    monitorOption: "none",
    rootFolderPath: "/music/main",
    qualityProfileId: 7,
  });
  libraryManager.addArtistWithResolvedOptions = async (
    _mbid,
    _name,
    options = {},
  ) => ({
    id: "7",
    mbid: "artist-mbid",
    foreignArtistId: "artist-mbid",
    artistName: "Various Artists",
    monitorOption: options.monitorOption,
  });
  libraryManager.waitForAlbumByMbidForArtist = async () => null;
  libraryManager.addAlbum = async () => ({
    id: "42",
    artistId: "7",
    mbid: "album-mbid",
    foreignAlbumId: "album-mbid",
    albumName: "Chrono Trigger",
    monitored: true,
    statistics: {
      percentOfTracks: 0,
      sizeOnDisk: 0,
    },
  });

  try {
    const result = await libraryManager.requestAlbumFromSearch({
      albumMbid: "album-mbid",
      albumName: "Chrono Trigger",
      artistMbid: "artist-mbid",
      artistName: "Various Artists",
      triggerSearch: true,
      user: {
        role: "user",
        permissions: { addAlbum: true, addArtist: true },
      },
    });

    assert.equal(result.success, true);
    assert.equal(result.createdArtist, true);
    assert.equal(result.createdAlbum, true);
    assert.equal(result.triggeredSearch, true);
    assert.equal(result.status, "searching");
    assert.equal(result.artist.id, "7");
    assert.equal(result.album.id, "42");
    assert.equal(result.artist.monitorOption, "none");
  } finally {
    lidarrClient.isConfigured = originalIsConfigured;
    lidarrClient.getAlbumByMbid = originalGetAlbumByMbid;
    libraryManager.getArtist = originalGetArtist;
    libraryManager.resolveArtistAddOptions = originalResolveArtistAddOptions;
    libraryManager.addArtistWithResolvedOptions =
      originalAddArtistWithResolvedOptions;
    libraryManager.waitForAlbumByMbidForArtist =
      originalWaitForAlbumByMbidForArtist;
    libraryManager.addAlbum = originalAddAlbum;
  }
});

test("requestAlbumFromSearch queues a new artist album search with the artist add", async () => {
  const originalIsConfigured = lidarrClient.isConfigured;
  const originalGetAlbumByMbid = lidarrClient.getAlbumByMbid;
  const originalGetArtist = libraryManager.getArtist;
  const originalResolveArtistAddOptions = libraryManager.resolveArtistAddOptions;
  const originalAddArtistWithResolvedOptions =
    libraryManager.addArtistWithResolvedOptions;
  const originalWaitForAlbumByMbidForArtist =
    libraryManager.waitForAlbumByMbidForArtist;
  const originalAddAlbum = libraryManager.addAlbum;

  let waitCalls = 0;
  let artistAddOptions;

  lidarrClient.isConfigured = () => true;
  lidarrClient.getAlbumByMbid = async () => null;
  libraryManager.getArtist = async () => null;
  libraryManager.resolveArtistAddOptions = async () => ({
    quality: "standard",
    monitorOption: "none",
    rootFolderPath: "/music/main",
    qualityProfileId: 7,
  });
  libraryManager.addArtistWithResolvedOptions = async (_mbid, _name, options) => {
    artistAddOptions = options;
    return {
      id: "7",
      mbid: "artist-mbid",
      foreignArtistId: "artist-mbid",
      artistName: "Boards of Canada",
      monitorOption: "none",
    };
  };
  libraryManager.waitForAlbumByMbidForArtist = async () => {
    waitCalls += 1;
    return null;
  };
  libraryManager.addAlbum = async (artistId, albumMbid, albumName, options) => {
    assert.equal(waitCalls, 0);
    assert.equal(artistId, "7");
    assert.equal(albumMbid, "album-mbid");
    assert.equal(albumName, "Geogaddi");
    assert.equal(options.triggerSearch, false);
    return {
      id: "42",
      artistId: "7",
      mbid: "album-mbid",
      foreignAlbumId: "album-mbid",
      albumName: "Geogaddi",
      monitored: true,
      statistics: {
        percentOfTracks: 0,
        sizeOnDisk: 0,
      },
    };
  };

  try {
    const result = await libraryManager.requestAlbumFromSearch({
      albumMbid: "album-mbid",
      albumName: "Geogaddi",
      artistMbid: "artist-mbid",
      artistName: "Boards of Canada",
      triggerSearch: true,
      user: {
        role: "user",
        permissions: { addAlbum: true, addArtist: true },
      },
    });

    assert.equal(result.success, true);
    assert.equal(result.createdArtist, true);
    assert.equal(result.createdAlbum, true);
    assert.equal(result.triggeredSearch, true);
    assert.equal(result.album.id, "42");
    assert.equal(artistAddOptions.triggerSearch, true);
  } finally {
    lidarrClient.isConfigured = originalIsConfigured;
    lidarrClient.getAlbumByMbid = originalGetAlbumByMbid;
    libraryManager.getArtist = originalGetArtist;
    libraryManager.resolveArtistAddOptions = originalResolveArtistAddOptions;
    libraryManager.addArtistWithResolvedOptions =
      originalAddArtistWithResolvedOptions;
    libraryManager.waitForAlbumByMbidForArtist =
      originalWaitForAlbumByMbidForArtist;
    libraryManager.addAlbum = originalAddAlbum;
  }
});

test("requestAlbumFromSearch preserves an addAlbum conflict status", async () => {
  const originalIsConfigured = lidarrClient.isConfigured;
  const originalGetAlbumByMbid = lidarrClient.getAlbumByMbid;
  const originalGetArtist = libraryManager.getArtist;
  const originalEnsureArtistMonitored = libraryManager.ensureArtistMonitored;
  const originalAddAlbum = libraryManager.addAlbum;

  lidarrClient.isConfigured = () => true;
  lidarrClient.getAlbumByMbid = async () => null;
  libraryManager.getArtist = async () => ({
    id: "7",
    artistName: "Boards of Canada",
    foreignArtistId: "artist-mbid",
  });
  libraryManager.ensureArtistMonitored = async (artist) => artist;
  libraryManager.addAlbum = async () => ({
    error: "Album already exists in Lidarr under a different artist",
    statusCode: 409,
  });

  try {
    await assert.rejects(
      () =>
        libraryManager.requestAlbumFromSearch({
          albumMbid: "album-mbid",
          albumName: "Geogaddi",
          artistMbid: "artist-mbid",
          artistName: "Boards of Canada",
        }),
      (error) => {
        assert.equal(error.statusCode, 409);
        assert.equal(error.message, "Album already exists in Lidarr under a different artist");
        return true;
      },
    );
  } finally {
    lidarrClient.isConfigured = originalIsConfigured;
    lidarrClient.getAlbumByMbid = originalGetAlbumByMbid;
    libraryManager.getArtist = originalGetArtist;
    libraryManager.ensureArtistMonitored = originalEnsureArtistMonitored;
    libraryManager.addAlbum = originalAddAlbum;
  }
});

test("requestAlbumFromSearch rejects when artist must be created without addArtist permission", async () => {
  const originalIsConfigured = lidarrClient.isConfigured;
  const originalGetArtist = libraryManager.getArtist;

  lidarrClient.isConfigured = () => true;
  libraryManager.getArtist = async () => null;

  try {
    await assert.rejects(
      () =>
        libraryManager.requestAlbumFromSearch({
          albumMbid: "album-mbid",
          albumName: "Chrono Trigger",
          artistMbid: "artist-mbid",
          artistName: "Various Artists",
          user: {
            role: "user",
            permissions: { addAlbum: true, addArtist: false },
          },
        }),
      (error) => {
        assert.equal(error.statusCode, 403);
        assert.match(error.message, /Permission required: addArtist/);
        return true;
      },
    );
  } finally {
    lidarrClient.isConfigured = originalIsConfigured;
    libraryManager.getArtist = originalGetArtist;
  }
});

test("addAlbum checks artist monitoring while monitoring only the requested album", async () => {
  const originalIsConfigured = lidarrClient.isConfigured;
  const originalGetArtist = lidarrClient.getArtist;
  const originalGetAlbumByMbid = lidarrClient.getAlbumByMbid;
  const originalAddAlbum = lidarrClient.addAlbum;
  const originalUpdateArtistMonitoring = lidarrClient.updateArtistMonitoring;

  let updateArtistMonitoringCalls = 0;

  lidarrClient.isConfigured = () => true;
  lidarrClient.getArtist = async () => ({
    id: 7,
    artistName: "Boards of Canada",
    foreignArtistId: "artist-mbid",
    monitored: false,
    monitor: "none",
  });
  lidarrClient.getAlbumByMbid = async () => null;
  lidarrClient.addAlbum = async () => ({
    id: 42,
    artistId: 7,
    foreignAlbumId: "album-mbid",
    title: "Geogaddi",
    monitored: true,
    statistics: {
      percentOfTracks: 0,
      sizeOnDisk: 0,
    },
  });
  lidarrClient.updateArtistMonitoring = async (_artistId, monitorOption) => {
    updateArtistMonitoringCalls += 1;
    assert.equal(monitorOption, "none");
    return {
      id: 7,
      artistName: "Boards of Canada",
      foreignArtistId: "artist-mbid",
      monitored: true,
      monitor: "none",
      monitorNewItems: "none",
      addOptions: {
        monitor: "none",
      },
    };
  };

  try {
    const album = await libraryManager.addAlbum(7, "album-mbid", "Geogaddi");
    assert.equal(album.id, "42");
    assert.equal(updateArtistMonitoringCalls, 1);
  } finally {
    lidarrClient.isConfigured = originalIsConfigured;
    lidarrClient.getArtist = originalGetArtist;
    lidarrClient.getAlbumByMbid = originalGetAlbumByMbid;
    lidarrClient.addAlbum = originalAddAlbum;
    lidarrClient.updateArtistMonitoring = originalUpdateArtistMonitoring;
  }
});

test("addAlbum force-refreshes and searches an existing album", async () => {
  const originalIsConfigured = lidarrClient.isConfigured;
  const originalGetArtist = lidarrClient.getArtist;
  const originalGetAlbumByMbid = lidarrClient.getAlbumByMbid;
  const originalGetAlbum = lidarrClient.getAlbum;
  const originalAddAlbum = lidarrClient.addAlbum;
  const originalTriggerAlbumSearch = lidarrClient.triggerAlbumSearch;
  const originalEnsureRequestedAlbumMonitoring =
    libraryManager.ensureRequestedAlbumMonitoring;
  const originalScheduleRequestedAlbumMonitoringRepair =
    libraryManager.scheduleRequestedAlbumMonitoringRepair;

  const existingAlbum = {
    id: 42,
    artistId: 7,
    foreignAlbumId: "fresh-album-mbid",
    title: "Geogaddi",
    monitored: true,
    statistics: {
      percentOfTracks: 0,
      sizeOnDisk: 0,
    },
  };
  let preflightOptions = null;
  let addCalls = 0;
  let searchCalls = 0;

  lidarrClient.isConfigured = () => true;
  lidarrClient.getArtist = async () => ({
    id: 7,
    artistName: "Boards of Canada",
    foreignArtistId: "artist-mbid",
    monitored: true,
    monitor: "none",
  });
  lidarrClient.getAlbumByMbid = async (_mbid, options) => {
    preflightOptions = options;
    return existingAlbum;
  };
  lidarrClient.getAlbum = async () => existingAlbum;
  lidarrClient.addAlbum = async () => {
    addCalls += 1;
    return existingAlbum;
  };
  lidarrClient.triggerAlbumSearch = async (albumId) => {
    searchCalls += 1;
    assert.equal(albumId, 42);
  };
  libraryManager.ensureRequestedAlbumMonitoring = async () => ({});
  libraryManager.scheduleRequestedAlbumMonitoringRepair = () => {};

  try {
    const album = await libraryManager.addAlbum(7, "fresh-album-mbid", "Geogaddi", {
      triggerSearch: true,
    });

    assert.equal(album.id, "42");
    assert.equal(preflightOptions?.forceRefresh, true);
    assert.equal(addCalls, 0);
    assert.equal(searchCalls, 1);
  } finally {
    lidarrClient.isConfigured = originalIsConfigured;
    lidarrClient.getArtist = originalGetArtist;
    lidarrClient.getAlbumByMbid = originalGetAlbumByMbid;
    lidarrClient.getAlbum = originalGetAlbum;
    lidarrClient.addAlbum = originalAddAlbum;
    lidarrClient.triggerAlbumSearch = originalTriggerAlbumSearch;
    libraryManager.ensureRequestedAlbumMonitoring =
      originalEnsureRequestedAlbumMonitoring;
    libraryManager.scheduleRequestedAlbumMonitoringRepair =
      originalScheduleRequestedAlbumMonitoringRepair;
  }
});

test("addAlbum coalesces concurrent requests for the same album", async () => {
  const originalIsConfigured = lidarrClient.isConfigured;
  const originalGetArtist = lidarrClient.getArtist;
  const originalGetAlbumByMbid = lidarrClient.getAlbumByMbid;
  const originalAddAlbum = lidarrClient.addAlbum;

  let addCalls = 0;
  let releaseAdd;
  const addGate = new Promise((resolve) => {
    releaseAdd = resolve;
  });

  lidarrClient.isConfigured = () => true;
  lidarrClient.getArtist = async () => ({
    id: 7,
    artistName: "Boards of Canada",
    foreignArtistId: "artist-mbid",
    monitored: true,
    monitor: "none",
  });
  lidarrClient.getAlbumByMbid = async () => null;
  lidarrClient.addAlbum = async () => {
    addCalls += 1;
    await addGate;
    return {
      id: 42,
      artistId: 7,
      foreignAlbumId: "concurrent-album-mbid",
      title: "Geogaddi",
      monitored: true,
      statistics: {
        percentOfTracks: 0,
        sizeOnDisk: 0,
      },
    };
  };

  try {
    const firstRequest = libraryManager.addAlbum(
      7,
      "concurrent-album-mbid",
      "Geogaddi",
    );
    const secondRequest = libraryManager.addAlbum(
      7,
      "concurrent-album-mbid",
      "Geogaddi",
    );
    releaseAdd();

    const [first, second] = await Promise.all([firstRequest, secondRequest]);
    assert.equal(addCalls, 1);
    assert.equal(first.id, "42");
    assert.equal(second.id, "42");
  } finally {
    lidarrClient.isConfigured = originalIsConfigured;
    lidarrClient.getArtist = originalGetArtist;
    lidarrClient.getAlbumByMbid = originalGetAlbumByMbid;
    lidarrClient.addAlbum = originalAddAlbum;
  }
});

test("addAlbum reports when Lidarr already owns an album under another artist", async () => {
  const originalIsConfigured = lidarrClient.isConfigured;
  const originalGetArtist = lidarrClient.getArtist;
  const originalGetAlbumByMbid = lidarrClient.getAlbumByMbid;
  const originalAddAlbum = lidarrClient.addAlbum;

  let addCalls = 0;
  lidarrClient.isConfigured = () => true;
  lidarrClient.getArtist = async () => ({
    id: 7,
    artistName: "Boards of Canada",
    foreignArtistId: "artist-mbid",
    monitored: true,
    monitor: "none",
  });
  lidarrClient.getAlbumByMbid = async () => ({
    id: 99,
    artistId: 8,
    foreignAlbumId: "owned-by-another-artist",
    title: "Geogaddi",
    monitored: true,
  });
  lidarrClient.addAlbum = async () => {
    addCalls += 1;
    throw new Error("AlbumExistsValidator: This album has already been added");
  };

  try {
    const result = await libraryManager.addAlbum(
      7,
      "owned-by-another-artist",
      "Geogaddi",
    );

    assert.equal(result.statusCode, 409);
    assert.equal(result.error, "Album already exists in Lidarr under a different artist");
    assert.equal(addCalls, 0);
  } finally {
    lidarrClient.isConfigured = originalIsConfigured;
    lidarrClient.getArtist = originalGetArtist;
    lidarrClient.getAlbumByMbid = originalGetAlbumByMbid;
    lidarrClient.addAlbum = originalAddAlbum;
  }
});

test("addAlbum monitors and searches the requested album after Lidarr conflict lag", async () => {
  const originalIsConfigured = lidarrClient.isConfigured;
  const originalGetArtist = lidarrClient.getArtist;
  const originalGetAlbumByMbid = lidarrClient.getAlbumByMbid;
  const originalAddAlbum = lidarrClient.addAlbum;
  const originalGetAlbum = lidarrClient.getAlbum;
  const originalMonitorAlbum = lidarrClient.monitorAlbum;
  const originalTriggerAlbumSearch = lidarrClient.triggerAlbumSearch;
  const originalUpdateArtistMonitoring = lidarrClient.updateArtistMonitoring;
  const originalWaitForAlbumByMbidForArtist =
    libraryManager.waitForAlbumByMbidForArtist;

  let monitorCalls = 0;
  let searchCalls = 0;
  let updateArtistMonitoringCalls = 0;

  lidarrClient.isConfigured = () => true;
  lidarrClient.getArtist = async () => ({
    id: 7,
    artistName: "Boards of Canada",
    foreignArtistId: "artist-mbid",
    monitored: false,
    monitor: "none",
  });
  lidarrClient.getAlbumByMbid = async () => null;
  lidarrClient.updateArtistMonitoring = async (_artistId, monitorOption) => {
    updateArtistMonitoringCalls += 1;
    assert.equal(monitorOption, "none");
    return {
      id: 7,
      artistName: "Boards of Canada",
      foreignArtistId: "artist-mbid",
      monitored: true,
      monitor: "none",
    };
  };
  lidarrClient.addAlbum = async () => {
    throw new Error("AlbumExistsValidator: This album has already been added");
  };
  libraryManager.waitForAlbumByMbidForArtist = async () => ({
    id: 42,
    artistId: "7",
    foreignAlbumId: "album-mbid",
    title: "Geogaddi",
    monitored: false,
    statistics: {
      percentOfTracks: 0,
      sizeOnDisk: 0,
    },
  });
  lidarrClient.monitorAlbum = async (albumId, monitored) => {
    monitorCalls += 1;
    assert.equal(albumId, 42);
    assert.equal(monitored, true);
  };
  lidarrClient.triggerAlbumSearch = async (albumId) => {
    searchCalls += 1;
    assert.equal(albumId, 42);
  };
  lidarrClient.getAlbum = async () => ({
    id: 42,
    artistId: 7,
    foreignAlbumId: "album-mbid",
    title: "Geogaddi",
    monitored: true,
    statistics: {
      percentOfTracks: 0,
      sizeOnDisk: 0,
    },
  });

  try {
    const album = await libraryManager.addAlbum(7, "album-mbid", "Geogaddi", {
      triggerSearch: true,
    });

    assert.equal(album.id, "42");
    assert.equal(album.monitored, true);
    assert.equal(updateArtistMonitoringCalls, 1);
    assert.equal(monitorCalls, 1);
    assert.equal(searchCalls, 1);
  } finally {
    lidarrClient.isConfigured = originalIsConfigured;
    lidarrClient.getArtist = originalGetArtist;
    lidarrClient.getAlbumByMbid = originalGetAlbumByMbid;
    lidarrClient.addAlbum = originalAddAlbum;
    lidarrClient.getAlbum = originalGetAlbum;
    lidarrClient.monitorAlbum = originalMonitorAlbum;
    lidarrClient.triggerAlbumSearch = originalTriggerAlbumSearch;
    lidarrClient.updateArtistMonitoring = originalUpdateArtistMonitoring;
    libraryManager.waitForAlbumByMbidForArtist =
      originalWaitForAlbumByMbidForArtist;
  }
});
