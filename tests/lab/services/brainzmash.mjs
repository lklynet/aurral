import { createHash } from "node:crypto";

export function stableUuid(seed) {
  const hex = createHash("sha1").update(seed).digest("hex");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-4${hex.slice(13, 16)}-8${hex.slice(17, 20)}-${hex.slice(20, 32)}`;
}

function artistSummary(artist) {
  return {
    id: artist.id,
    artistname: artist.name,
    sortname: artist.name,
    type: artist.type,
    status: "active",
    disambiguation: "",
    overview: "Synthetic artist metadata from the Aurral Lab.",
    genres: artist.genres,
    artistaliases: [],
    images: [],
    links: [],
  };
}

function artistBody(artist) {
  return {
    ...artistSummary(artist),
    Albums: artist.albums.map((album) => ({
      Id: album.id,
      Title: album.title,
      Type: album.type,
      SecondaryTypes: [],
      ReleaseStatuses: ["Official"],
      FirstReleaseDate: album.date,
    })),
  };
}

function albumBody(artist, album) {
  return {
    id: album.id,
    title: album.title,
    type: album.type,
    secondarytypes: [],
    artistid: artist.id,
    artists: [artistSummary(artist)],
    releasedate: album.date,
    genres: artist.genres,
    images: [],
    links: [],
    releases: [
      {
        id: stableUuid(`${album.id}:release`),
        title: album.title,
        status: "Official",
        releasedate: album.date,
        country: ["XW"],
        label: ["Aurral Lab"],
        media: [{ Format: "Digital Media", Name: "", Position: 1 }],
        track_count: album.tracks.length,
        tracks: album.tracks.map((title, index) => ({
          id: stableUuid(`${album.id}:track:${index + 1}`),
          recordingid: stableUuid(`${album.id}:recording:${index + 1}`),
          trackname: title,
          trackposition: index + 1,
          mediumnumber: 1,
          durationms: 180000 + index * 1000,
          artistid: artist.id,
        })),
      },
    ],
  };
}

function matches(text, query) {
  return text.toLowerCase().includes(String(query || "").trim().toLowerCase());
}

export function createBrainzmash(catalog) {
  const artists = new Map(catalog.artists.map((artist) => [artist.id, artist]));
  const albums = new Map(
    catalog.artists.flatMap((artist) => artist.albums.map((album) => [album.id, { artist, album }])),
  );

  return ({ method, url }) => {
    if (method !== "GET") return null;
    const limit = Number(url.searchParams.get("limit")) || 24;
    const query = url.searchParams.get("query");
    const [, kind, id] = url.pathname.split("/");
    if (kind === "artist" && id) {
      const artist = artists.get(id);
      return artist ? { status: 200, body: artistBody(artist) } : { status: 404, body: { error: "Artist not found" } };
    }
    if (kind === "album" && id) {
      const entry = albums.get(id);
      return entry ? { status: 200, body: albumBody(entry.artist, entry.album) } : { status: 404, body: { error: "Album not found" } };
    }
    if (url.pathname === "/search/artist") {
      const found = catalog.artists.filter((artist) => query && matches(artist.name, query));
      return { status: 200, body: found.slice(0, limit).map(artistSummary) };
    }
    if (url.pathname === "/search/album") {
      const artistName = url.searchParams.get("artist");
      const found = [...albums.values()].filter(
        ({ artist, album }) => query && matches(album.title, query) && (!artistName || matches(artist.name, artistName)),
      );
      return {
        status: 200,
        body: found.slice(0, limit).map(({ artist, album }) => {
          const { releases: _releases, ...summary } = albumBody(artist, album);
          return summary;
        }),
      };
    }
    return null;
  };
}
