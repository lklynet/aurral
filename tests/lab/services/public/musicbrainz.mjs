import { stableUuid } from "../brainzmash.mjs";
import { searchWords, trackDurationSeconds } from "../runtime.mjs";

export function createMusicBrainz(catalog) {
  const credit = (artist) => [{ name: artist.name, joinphrase: "", artist: { id: artist.id, name: artist.name, "sort-name": artist.name } }];
  const releaseGroup = (artist, album) => ({
    id: album.id,
    title: album.title,
    "primary-type": album.type,
    "secondary-types": [],
    "first-release-date": album.date,
    "artist-credit": credit(artist),
  });
  const albums = catalog.artists.flatMap((artist) => artist.albums.map((album) => ({ artist, album })));
  const matchesQuery = (query, text) => searchWords(query).some((word) => searchWords(text).includes(word));
  const variousArtists = { id: "89ad4ac3-39f7-470e-963a-56509c546377", name: "Various Artists" };
  const sampler = {
    id: stableUuid("musicbrainz:lab-sampler:release"),
    title: "Aurral Lab Sampler",
    status: "Official",
    date: "2026-01-01",
    "artist-credit": credit(variousArtists),
    "release-group": {
      id: stableUuid("musicbrainz:lab-sampler"),
      title: "Aurral Lab Sampler",
      "primary-type": "Album",
      "secondary-types": ["Compilation"],
      "first-release-date": "2026-01-01",
      "artist-credit": credit(variousArtists),
    },
  };

  return {
    name: "musicbrainz",
    hosts: ["musicbrainz.org"],
    handle({ method, url }) {
      if (method !== "GET" || !url.pathname.startsWith("/ws/2/")) return null;
      const query = String(url.searchParams.get("query") || "");
      const limit = Number(url.searchParams.get("limit")) || 25;
      const offset = Number(url.searchParams.get("offset")) || 0;
      const page = (items) => items.slice(offset, offset + limit);
      const [, , , entity, id] = url.pathname.split("/");

      if (entity === "recording" && !id) {
        const artistId = /arid:([0-9a-f-]{36})/i.exec(query)?.[1];
        const recordings = albums
          .filter(({ artist }) => !artistId || artist.id === artistId)
          .flatMap(({ artist, album }) =>
            album.tracks.map((title, index) => ({
              id: stableUuid(`${album.id}:recording:${index + 1}`),
              title,
              length: trackDurationSeconds(index) * 1000,
              "artist-credit": credit(artist),
              releases: [{
                id: stableUuid(`${album.id}:release`),
                title: album.title,
                status: "Official",
                date: album.date,
                "artist-credit": credit(artist),
                "release-group": releaseGroup(artist, album),
              }, ...(index === 0 && album === artist.albums[0] ? [sampler] : [])],
            })));
        return { status: 200, body: { created: new Date().toISOString(), count: recordings.length, offset, recordings: page(recordings) } };
      }
      if (entity === "release-group" && !id) {
        const found = albums.filter(({ artist, album }) => matchesQuery(query, `${artist.name} ${album.title}`));
        return { status: 200, body: { count: found.length, offset, "release-groups": page(found.map(({ artist, album }) => ({ ...releaseGroup(artist, album), score: 100 }))) } };
      }
      if (entity === "artist" && !id) {
        const found = catalog.artists.filter((artist) => matchesQuery(query, artist.name));
        return { status: 200, body: { count: found.length, offset, artists: page(found.map((artist) => ({ id: artist.id, name: artist.name, "sort-name": artist.name, type: artist.type, score: 100 }))) } };
      }
      if (entity === "artist" && id) {
        const artist = catalog.artists.find((entry) => entry.id === id);
        if (!artist) return { status: 404, body: { error: "Not Found" } };
        return {
          status: 200,
          body: {
            id: artist.id,
            name: artist.name,
            "sort-name": artist.name,
            type: artist.type,
            genres: artist.genres.map((name) => ({ name, count: 1 })),
            relations: [],
            "release-groups": artist.albums.map((album) => releaseGroup(artist, album)),
          },
        };
      }
      if (entity === "release-group" && id) {
        const entry = albums.find(({ album }) => album.id === id);
        return entry ? { status: 200, body: releaseGroup(entry.artist, entry.album) } : { status: 404, body: { error: "Not Found" } };
      }
      return null;
    },
  };
}
