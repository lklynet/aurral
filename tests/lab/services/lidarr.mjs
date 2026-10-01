import fs from "node:fs";
import path from "node:path";
import { stableUuid } from "./brainzmash.mjs";
import { copyInto, trackDurationSeconds } from "./runtime.mjs";

export function createLidarr(catalog, { apiKey, mediaRoot, downloads, tracks: trackFiles, webhook }) {
  const rootFolder = path.join(mediaRoot, "lidarr");
  const state = { artists: [], albums: [], tracks: [], trackFiles: [], queue: [], history: [], commands: [] };
  const ids = { artist: 1, album: 1, track: 1, trackFile: 1, queue: 1, history: 1, command: 1 };
  state.ids = ids;
  const catalogArtists = new Map(catalog.artists.map((artist) => [artist.id, artist]));

  const ok = (body, status = 200) => ({ status, body });
  const missing = (message) => ({ status: 404, body: { message } });
  const findArtist = (id) => state.artists.find((artist) => String(artist.id) === String(id));
  const findAlbum = (id) => state.albums.find((album) => String(album.id) === String(id));
  const releaseTitle = (artist, album) => `${artist.artistName} - ${album.title} (${album.releaseDate.slice(0, 4)}) [FLAC]`;

  function albumStatistics(album) {
    const albumTracks = state.tracks.filter((track) => track.albumId === album.id);
    const files = state.trackFiles.filter((file) => file.albumId === album.id);
    const sizeOnDisk = files.reduce((total, file) => total + file.size, 0);
    return {
      trackFileCount: files.length,
      trackCount: albumTracks.length,
      totalTrackCount: albumTracks.length,
      sizeOnDisk,
      percentOfTracks: albumTracks.length ? Math.round((files.length / albumTracks.length) * 100) : 0,
    };
  }

  const albumResource = (album) => ({ ...album, statistics: albumStatistics(album) });
  const artistResource = (artist) => {
    const albums = state.albums.filter((album) => album.artistId === artist.id).map(albumStatistics);
    const sum = (key) => albums.reduce((total, stats) => total + stats[key], 0);
    const trackCount = sum("trackCount");
    return {
      ...artist,
      statistics: {
        albumCount: albums.length,
        trackFileCount: sum("trackFileCount"),
        trackCount,
        totalTrackCount: trackCount,
        sizeOnDisk: sum("sizeOnDisk"),
        percentOfTracks: trackCount ? Math.round((sum("trackFileCount") / trackCount) * 100) : 0,
      },
    };
  };

  function record(eventType, artist, album, extra = {}) {
    state.history.unshift({
      id: ids.history++,
      eventType,
      artistId: artist.id,
      albumId: album.id,
      sourceTitle: releaseTitle(artist, album),
      date: new Date().toISOString(),
      quality: { quality: { id: 6, name: "FLAC" } },
      data: {},
      ...extra,
    });
  }

  function importAlbum(artist, album, downloadId) {
    const source = catalogArtists.get(artist.foreignArtistId)?.albums.find((entry) => entry.id === album.foreignAlbumId);
    if (!source) return;
    const albumDir = path.join(artist.path, album.title);
    for (const track of state.tracks.filter((entry) => entry.albumId === album.id)) {
      const index = track.absoluteTrackNumber - 1;
      const cached = trackFiles.file(catalogArtists.get(artist.foreignArtistId), source, index);
      const target = copyInto(cached.path, path.join(albumDir, `${String(track.trackNumber).padStart(2, "0")} - ${track.title}.flac`));
      const file = {
        id: ids.trackFile++,
        artistId: artist.id,
        albumId: album.id,
        path: target,
        relativePath: path.relative(artist.path, target),
        size: cached.size,
        dateAdded: new Date().toISOString(),
        quality: { quality: { id: 6, name: "FLAC" }, revision: { version: 1, real: 0 } },
        mediaInfo: { audioFormat: "FLAC", audioBitrate: "700 kbps", audioChannels: 1, audioBits: "16bit", audioSampleRate: "44.1 kHz" },
      };
      state.trackFiles.push(file);
      Object.assign(track, { trackFileId: file.id, hasFile: true });
    }
    record("trackFileImported", artist, album, { downloadId });
    record("downloadImported", artist, album, { downloadId });
    if (webhook?.url) {
      const webhookArtist = { id: artist.id, artistName: artist.artistName, foreignArtistId: artist.foreignArtistId, path: artist.path };
      fetch(`${webhook.url}/api/webhooks/lidarr`, {
        method: "POST",
        headers: { "content-type": "application/json", "x-api-key": webhook.apiKey },
        body: JSON.stringify({
          eventType: "Download",
          instanceName: "Aurral Lab Lidarr",
          artist: webhookArtist,
          album: { id: album.id, title: album.title, foreignAlbumId: album.foreignAlbumId, releaseDate: album.releaseDate, artist: webhookArtist },
          isUpgrade: false,
          downloadClient: "Lab SABnzbd",
          downloadId,
        }),
      }).catch((error) => console.error(`Lidarr webhook to Aurral failed: ${error.message}`));
    }
  }

  function grab(album) {
    const artist = findArtist(album.artistId);
    if (!artist || state.queue.some((item) => item.albumId === album.id)) return;
    if (albumStatistics(album).trackFileCount >= albumStatistics(album).trackCount) return;
    const downloadId = `LAB${String(ids.queue).padStart(6, "0")}`;
    const size = state.tracks
      .filter((track) => track.albumId === album.id)
      .reduce((total, track) => {
        const source = catalogArtists.get(artist.foreignArtistId).albums.find((entry) => entry.id === album.foreignAlbumId);
        return total + trackFiles.file(catalogArtists.get(artist.foreignArtistId), source, track.absoluteTrackNumber - 1).size;
      }, 0);
    const item = downloads.add({
      id: ids.queue++,
      artistId: artist.id,
      albumId: album.id,
      downloadId,
      size,
      title: releaseTitle(artist, album),
      complete: () => {
        state.queue = state.queue.filter((entry) => entry !== item);
        importAlbum(artist, album, downloadId);
      },
    });
    state.queue.push(item);
    record("grabbed", artist, album, { downloadId, data: { indexer: "Lab Usenet Indexer", downloadClient: "Lab SABnzbd" } });
  }

  function queueResource(item) {
    const { stage, fraction } = downloads.progress(item);
    const artist = findArtist(item.artistId);
    const album = findAlbum(item.albumId);
    const sizeleft = Math.round(item.size * (1 - fraction));
    return {
      id: item.id,
      artistId: item.artistId,
      albumId: item.albumId,
      artist: artist && { id: artist.id, artistName: artist.artistName, foreignArtistId: artist.foreignArtistId },
      album: album && { id: album.id, title: album.title, foreignAlbumId: album.foreignAlbumId },
      title: item.title,
      size: item.size,
      sizeleft,
      timeleft: stage === "queued" ? "00:00:05" : "00:00:02",
      status: stage === "queued" ? "queued" : "downloading",
      trackedDownloadStatus: "ok",
      trackedDownloadState: stage === "completed" ? "importPending" : "downloading",
      statusMessages: [],
      downloadId: item.downloadId,
      protocol: "usenet",
      downloadClient: "Lab SABnzbd",
      indexer: "Lab Usenet Indexer",
      outputPath: path.join(mediaRoot, "usenet", "complete", item.title),
    };
  }

  function search(albumIds) {
    for (const id of albumIds) {
      const album = findAlbum(id);
      if (album?.monitored) grab(album);
    }
  }

  function addArtist(payload) {
    if (!payload?.foreignArtistId || !payload?.rootFolderPath || !payload?.qualityProfileId) {
      return { status: 400, body: [{ propertyName: "ForeignArtistId", errorMessage: "Artist details are incomplete" }] };
    }
    if (state.artists.some((artist) => artist.foreignArtistId === payload.foreignArtistId)) {
      return { status: 400, body: [{ propertyName: "ForeignArtistId", errorMessage: "This artist has already been added" }] };
    }
    const source = catalogArtists.get(payload.foreignArtistId);
    if (!source) {
      return { status: 400, body: [{ propertyName: "ForeignArtistId", errorMessage: "Invalid Artist ID. Unable to find artist in metadata" }] };
    }
    const artist = {
      id: ids.artist++,
      artistName: source.name,
      sortName: source.name.toLowerCase(),
      foreignArtistId: source.id,
      artistType: source.type,
      status: "continuing",
      ended: false,
      overview: "Synthetic artist from the Aurral Lab Lidarr fixture.",
      genres: source.genres,
      images: [],
      links: [],
      path: path.join(payload.rootFolderPath, source.name),
      rootFolderPath: payload.rootFolderPath,
      qualityProfileId: payload.qualityProfileId,
      metadataProfileId: payload.metadataProfileId ?? 1,
      monitored: payload.monitored !== false,
      monitorNewItems: payload.monitorNewItems || "none",
      tags: Array.isArray(payload.tags) ? payload.tags : [],
      added: new Date().toISOString(),
      addOptions: payload.addOptions || {},
    };
    state.artists.push(artist);
    const monitor = payload.addOptions?.monitor;
    const monitoredIds = new Set(payload.addOptions?.albumsToMonitor || []);
    const sorted = [...source.albums].sort((left, right) => left.date.localeCompare(right.date));
    for (const albumSource of source.albums) {
      const monitored =
        monitoredIds.has(albumSource.id) ||
        monitor === "all" ||
        (monitor === "latest" && albumSource === sorted.at(-1)) ||
        (monitor === "first" && albumSource === sorted[0]);
      const album = {
        id: ids.album++,
        artistId: artist.id,
        foreignAlbumId: albumSource.id,
        title: albumSource.title,
        albumType: albumSource.type,
        secondaryTypes: [],
        releaseDate: `${albumSource.date}T00:00:00Z`,
        monitored,
        anyReleaseOk: true,
        images: [],
        artist: { id: artist.id, artistName: artist.artistName, foreignArtistId: artist.foreignArtistId },
      };
      state.albums.push(album);
      albumSource.tracks.forEach((title, index) => {
        state.tracks.push({
          id: ids.track++,
          artistId: artist.id,
          albumId: album.id,
          foreignTrackId: stableUuid(`${albumSource.id}:track:${index + 1}`),
          foreignRecordingId: stableUuid(`${albumSource.id}:recording:${index + 1}`),
          title,
          trackNumber: String(index + 1),
          absoluteTrackNumber: index + 1,
          mediumNumber: 1,
          duration: trackDurationSeconds(index) * 1000,
          hasFile: false,
          trackFileId: 0,
        });
      });
    }
    if (payload.addOptions?.searchForMissingAlbums) {
      search(state.albums.filter((album) => album.artistId === artist.id).map((album) => album.id));
    }
    return ok(artistResource(artist), 201);
  }

  function removeAlbumData(album, deleteFiles) {
    for (const file of state.trackFiles.filter((entry) => entry.albumId === album.id)) {
      if (deleteFiles) fs.rmSync(file.path, { force: true });
    }
    state.trackFiles = state.trackFiles.filter((entry) => entry.albumId !== album.id);
    state.tracks = state.tracks.filter((entry) => entry.albumId !== album.id);
    for (const item of state.queue.filter((entry) => entry.albumId === album.id)) downloads.remove(item);
    state.queue = state.queue.filter((entry) => entry.albumId !== album.id);
  }

  const handler = ({ method, url, headers, body }) => {
    if (!url.pathname.startsWith("/api/v1/")) return null;
    if (headers["x-api-key"] !== apiKey) return { status: 401, body: { message: "Unauthorized" } };
    const path = url.pathname.slice("/api/v1".length).toLowerCase();
    const [, resource, id] = path.split("/");
    const query = url.searchParams;
    const page = (records) => ok({ page: Number(query.get("page")) || 1, pageSize: Number(query.get("pageSize")) || 10, totalRecords: records.length, records });

    for (const item of [...state.queue]) downloads.progress(item);

    if (method === "GET" && path === "/system/status") {
      return ok({ appName: "Lidarr", instanceName: "Aurral Lab Lidarr", version: "2.0.0.0-lab", isProduction: false });
    }
    if (method === "GET" && path === "/rootfolder") return ok([{ id: 1, path: rootFolder, accessible: true, freeSpace: 1e12 }]);
    if (method === "GET" && path === "/qualityprofile") return ok([{ id: 1, name: "Lab Lossless" }]);
    if (method === "GET" && path === "/metadataprofile") return ok([{ id: 1, name: "Standard" }]);
    if (method === "GET" && path === "/tag") return ok([]);
    if (method === "GET" && path === "/queue") {
      const records = state.queue.map(queueResource);
      return page(records);
    }
    if (method === "GET" && resource === "queue" && id) {
      const item = state.queue.find((entry) => String(entry.id) === id);
      return item ? ok(queueResource(item)) : missing("Queue item not found");
    }
    if (method === "DELETE" && resource === "queue" && id) {
      const item = state.queue.find((entry) => String(entry.id) === id);
      if (!item) return missing("Queue item not found");
      downloads.remove(item);
      state.queue = state.queue.filter((entry) => entry !== item);
      return ok({});
    }
    if (method === "GET" && path === "/history") {
      const pageSize = Number(query.get("pageSize")) || 20;
      const start = ((Number(query.get("page")) || 1) - 1) * pageSize;
      return ok({ page: Number(query.get("page")) || 1, pageSize, totalRecords: state.history.length, records: state.history.slice(start, start + pageSize) });
    }
    if (method === "GET" && path === "/track") {
      const albumId = query.get("albumId");
      const artistId = query.get("artistId");
      return ok(state.tracks.filter((track) => (!albumId || String(track.albumId) === albumId) && (!artistId || String(track.artistId) === artistId)));
    }
    if (method === "GET" && path === "/trackfile") {
      const albumId = query.get("albumId");
      const artistId = query.get("artistId");
      const fileIds = query.getAll("trackFileIds").flatMap((value) => value.split(",")).filter(Boolean);
      return ok(state.trackFiles.filter((file) =>
        (!albumId || String(file.albumId) === albumId) &&
        (!artistId || String(file.artistId) === artistId) &&
        (!fileIds.length || fileIds.includes(String(file.id)))));
    }
    if (method === "DELETE" && resource === "trackfile" && id) {
      const file = state.trackFiles.find((entry) => String(entry.id) === id);
      if (!file) return missing("Track file not found");
      fs.rmSync(file.path, { force: true });
      state.trackFiles = state.trackFiles.filter((entry) => entry !== file);
      for (const track of state.tracks.filter((entry) => entry.trackFileId === file.id)) Object.assign(track, { hasFile: false, trackFileId: 0 });
      return ok({});
    }

    if (resource === "artist" && id === "lookup" && method === "GET") {
      const term = String(query.get("term") || "").toLowerCase().replace(/^lidarr:/, "");
      const found = catalog.artists.filter((artist) => term && (artist.id === term || artist.name.toLowerCase().includes(term)));
      return ok(found.map((artist) => ({ artistName: artist.name, foreignArtistId: artist.id, artistType: artist.type })));
    }
    if (resource === "artist" && !id) {
      if (method === "GET") return ok(state.artists.map(artistResource));
      if (method === "POST") return addArtist(body);
    }
    if (resource === "artist" && id) {
      const artist = findArtist(id);
      if (!artist) return missing("Artist not found");
      if (method === "GET") return ok(artistResource(artist));
      if (method === "PUT") {
        Object.assign(artist, body || {}, { id: artist.id, foreignArtistId: artist.foreignArtistId, path: artist.path });
        return ok(artistResource(artist), 202);
      }
      if (method === "DELETE") {
        const deleteFiles = query.get("deleteFiles") === "true";
        for (const album of state.albums.filter((entry) => entry.artistId === artist.id)) removeAlbumData(album, deleteFiles);
        if (deleteFiles) fs.rmSync(artist.path, { recursive: true, force: true });
        state.artists = state.artists.filter((entry) => entry !== artist);
        state.albums = state.albums.filter((album) => album.artistId !== artist.id);
        return ok({});
      }
    }
    if (resource === "album" && !id && method === "GET") {
      const artistId = query.get("artistId");
      const foreignAlbumId = query.get("foreignAlbumId");
      const albumIds = query.getAll("albumIds").flatMap((value) => value.split(",")).filter(Boolean);
      return ok(state.albums
        .filter((album) =>
          (!artistId || String(album.artistId) === artistId) &&
          (!foreignAlbumId || album.foreignAlbumId === foreignAlbumId) &&
          (!albumIds.length || albumIds.includes(String(album.id))))
        .map(albumResource));
    }
    if (resource === "album" && !id && method === "POST") {
      const album = state.albums.find((entry) => entry.foreignAlbumId === body?.foreignAlbumId && entry.artistId === body?.artistId);
      if (!album) return { status: 400, body: [{ propertyName: "ForeignAlbumId", errorMessage: "Album not found for this artist" }] };
      album.monitored = body.monitored !== false;
      return ok(albumResource(album), 201);
    }
    if (resource === "album" && id === "monitor" && method === "PUT") {
      for (const albumId of body?.albumIds || []) {
        const album = findAlbum(albumId);
        if (album) album.monitored = body.monitored === true;
      }
      return ok(state.albums.filter((album) => (body?.albumIds || []).includes(album.id)).map(albumResource), 202);
    }
    if (resource === "album" && id) {
      const album = findAlbum(id);
      if (!album) return missing("Album not found");
      if (method === "GET") return ok(albumResource(album));
      if (method === "PUT") {
        Object.assign(album, body || {}, { id: album.id, artistId: album.artistId, foreignAlbumId: album.foreignAlbumId });
        return ok(albumResource(album), 202);
      }
      if (method === "DELETE") {
        removeAlbumData(album, query.get("deleteFiles") === "true");
        state.albums = state.albums.filter((entry) => entry !== album);
        return ok({});
      }
    }
    if (resource === "command" && method === "POST" && !id) {
      const name = String(body?.name || "");
      if (name === "AlbumSearch") search(body.albumIds || []);
      if (name === "ArtistSearch" || name === "MissingAlbumSearch") {
        search(state.albums.filter((album) => !body.artistId || album.artistId === body.artistId).map((album) => album.id));
      }
      const command = { id: ids.command++, name, body: body || {}, status: "queued", queued: new Date().toISOString() };
      state.commands.push(command);
      return ok(command, 201);
    }
    if (resource === "command" && method === "GET") {
      for (const command of state.commands) command.status = "completed";
      if (!id) return ok(state.commands);
      const command = state.commands.find((entry) => String(entry.id) === id);
      return command ? ok(command) : missing("Command not found");
    }
    return null;
  };
  handler.state = state;
  handler.restore = (saved) => {
    for (const key of ["artists", "albums", "tracks", "trackFiles", "history", "commands"]) state[key] = saved[key] || [];
    Object.assign(ids, saved.ids || {});
    for (const item of saved.queue || []) {
      const album = findAlbum(item.albumId);
      if (album) grab(album);
    }
  };
  return handler;
}
