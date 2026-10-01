const ROOT_FOLDER = "/music";

function statistics(albums = []) {
  const trackCount = albums.reduce((total, album) => total + album.statistics.trackCount, 0);
  return {
    albumCount: albums.length,
    trackFileCount: 0,
    trackCount,
    totalTrackCount: trackCount,
    sizeOnDisk: 0,
    percentOfTracks: 0,
  };
}

export function createLidarr(catalog, { apiKey }) {
  const state = { artists: [], albums: [], commands: [], nextArtistId: 1, nextAlbumId: 1, nextCommandId: 1 };
  const catalogArtists = new Map(catalog.artists.map((artist) => [artist.id, artist]));

  const artistResource = (artist) => ({
    ...artist,
    statistics: statistics(state.albums.filter((album) => album.artistId === artist.id)),
  });
  const findArtist = (id) => state.artists.find((artist) => String(artist.id) === String(id));
  const findAlbum = (id) => state.albums.find((album) => String(album.id) === String(id));
  const ok = (body, status = 200) => ({ status, body });
  const missing = (message) => ({ status: 404, body: { message } });

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
      id: state.nextArtistId++,
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
      path: `${payload.rootFolderPath}/${source.name}`,
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
    const monitorAll = payload.addOptions?.monitor === "all";
    const monitoredIds = new Set(payload.addOptions?.albumsToMonitor || []);
    for (const album of source.albums) {
      state.albums.push({
        id: state.nextAlbumId++,
        artistId: artist.id,
        foreignAlbumId: album.id,
        title: album.title,
        albumType: album.type,
        secondaryTypes: [],
        releaseDate: `${album.date}T00:00:00Z`,
        monitored: monitorAll || monitoredIds.has(album.id),
        anyReleaseOk: true,
        images: [],
        artist: { id: artist.id, artistName: artist.artistName, foreignArtistId: artist.foreignArtistId },
        statistics: { trackFileCount: 0, trackCount: album.tracks.length, totalTrackCount: album.tracks.length, sizeOnDisk: 0, percentOfTracks: 0 },
      });
    }
    return ok(artistResource(artist), 201);
  }

  const handler = ({ method, url, headers, body }) => {
    if (!url.pathname.startsWith("/api/v1/")) return null;
    if (headers["x-api-key"] !== apiKey) return { status: 401, body: { message: "Unauthorized" } };
    const path = url.pathname.slice("/api/v1".length).toLowerCase();
    const [, resource, id] = path.split("/");
    const query = url.searchParams;

    if (method === "GET" && path === "/system/status") {
      return ok({ appName: "Lidarr", instanceName: "Aurral Lab Lidarr", version: "2.0.0.0-lab", isProduction: false });
    }
    if (method === "GET" && path === "/rootfolder") return ok([{ id: 1, path: ROOT_FOLDER, accessible: true, freeSpace: 1e12 }]);
    if (method === "GET" && path === "/qualityprofile") return ok([{ id: 1, name: "Lab Lossless" }]);
    if (method === "GET" && path === "/metadataprofile") return ok([{ id: 1, name: "Standard" }]);
    if (method === "GET" && path === "/tag") return ok([]);
    if (method === "GET" && path === "/queue") return ok({ page: 1, pageSize: Number(query.get("pageSize")) || 10, totalRecords: 0, records: [] });
    if (method === "GET" && path === "/history") return ok({ page: 1, pageSize: Number(query.get("pageSize")) || 10, totalRecords: 0, records: [] });
    if (method === "GET" && (path === "/trackfile" || path === "/track")) return ok([]);

    if (resource === "artist" && id === "lookup" && method === "GET") {
      const term = String(query.get("term") || "").toLowerCase();
      const found = catalog.artists.filter((artist) => term && artist.name.toLowerCase().includes(term.replace(/^lidarr:/, "")));
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
        Object.assign(artist, body || {}, { id: artist.id, foreignArtistId: artist.foreignArtistId });
        return ok(artistResource(artist), 202);
      }
      if (method === "DELETE") {
        state.artists = state.artists.filter((entry) => entry !== artist);
        state.albums = state.albums.filter((album) => album.artistId !== artist.id);
        return ok({});
      }
    }
    if (resource === "album" && !id && method === "GET") {
      const artistId = query.get("artistId");
      const foreignAlbumId = query.get("foreignAlbumId");
      return ok(state.albums.filter((album) =>
        (!artistId || String(album.artistId) === artistId) && (!foreignAlbumId || album.foreignAlbumId === foreignAlbumId)));
    }
    if (resource === "album" && id) {
      const album = findAlbum(id);
      if (!album) return missing("Album not found");
      if (method === "GET") return ok(album);
      if (method === "PUT") {
        Object.assign(album, body || {}, { id: album.id, artistId: album.artistId, foreignAlbumId: album.foreignAlbumId });
        return ok(album, 202);
      }
    }
    if (resource === "command" && method === "POST" && !id) {
      const command = { id: state.nextCommandId++, name: body?.name, body: body || {}, status: "queued", queued: new Date().toISOString() };
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
  return handler;
}
