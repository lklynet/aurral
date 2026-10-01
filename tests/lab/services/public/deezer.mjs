import { readFileSync } from "node:fs";
import { deezerIds } from "../deemix.mjs";
import { searchWords, solidPng, trackDurationSeconds } from "../runtime.mjs";

const IMAGE_HOST = "https://e-cdns-images.dzcdn.net";
const PREVIEW_HOST = "https://cdnt-preview.dzcdn.net";

export function createDeezer(catalog, { tracks }) {
  const artists = catalog.artists.map((artist) => ({ ...artist, deezerId: deezerIds(artist).artistId }));
  const entries = artists.flatMap((artist) =>
    artist.albums.flatMap((album) => album.tracks.map((title, index) => ({ artist, album, title, index, ...deezerIds(artist, album, index) }))));
  const pictures = (kind, id) => Object.fromEntries(
    [["", 120], ["_small", 56], ["_medium", 250], ["_big", 500], ["_xl", 1000]].map(([suffix, size]) => [
      `${kind}${suffix}`,
      `${IMAGE_HOST}/images/${kind === "picture" ? "artist" : "cover"}/${id}/${size}x${size}-000000-80-0-0.jpg`,
    ]),
  );
  const artistJson = (artist) => ({
    id: artist.deezerId,
    name: artist.name,
    link: `https://www.deezer.com/artist/${artist.deezerId}`,
    share: `https://www.deezer.com/artist/${artist.deezerId}`,
    nb_album: artist.albums.length,
    nb_fan: 1000 + artist.albums.length * 37,
    radio: true,
    tracklist: `https://api.deezer.com/artist/${artist.deezerId}/top?limit=50`,
    type: "artist",
    ...pictures("picture", artist.deezerId),
  });
  const albumJson = (artist, album) => ({
    id: deezerIds(artist, album).albumId,
    title: album.title,
    link: `https://www.deezer.com/album/${deezerIds(artist, album).albumId}`,
    release_date: album.date,
    record_type: album.type.toLowerCase(),
    fans: 500 + album.tracks.length * 11,
    tracklist: `https://api.deezer.com/album/${deezerIds(artist, album).albumId}/tracks`,
    type: "album",
    ...pictures("cover", deezerIds(artist, album).albumId),
  });
  const trackJson = (entry) => ({
    id: entry.trackId,
    readable: true,
    title: entry.title,
    title_short: entry.title,
    link: `https://www.deezer.com/track/${entry.trackId}`,
    duration: trackDurationSeconds(entry.index),
    track_position: entry.index + 1,
    rank: 500000 - entry.index * 1000,
    explicit_lyrics: false,
    preview: `${PREVIEW_HOST}/api/1/1/lab/${entry.trackId}.mp3`,
    artist: { id: entry.artistId, name: entry.artist.name, link: `https://www.deezer.com/artist/${entry.artistId}`, type: "artist", ...pictures("picture", entry.artistId) },
    album: albumJson(entry.artist, entry.album),
    type: "track",
  });
  const list = (data, url) => {
    const limit = Number(url.searchParams.get("limit")) || 25;
    const index = Number(url.searchParams.get("index")) || 0;
    return { status: 200, body: { data: data.slice(index, index + limit), total: data.length } };
  };
  const noData = { status: 200, body: { error: { type: "DataException", message: "no data", code: 800 } } };
  const matches = (query, text) => {
    const terms = searchWords(query);
    const words = new Set(searchWords(text));
    return terms.length > 0 && terms.every((term) => words.has(term));
  };

  return {
    name: "deezer",
    hosts: ["api.deezer.com", "e-cdns-images.dzcdn.net", "cdn-images.dzcdn.net", "cdnt-preview.dzcdn.net"],
    handle({ method, url, host }) {
      if (method !== "GET") return null;
      if (host === "e-cdns-images.dzcdn.net" || host === "cdn-images.dzcdn.net") {
        return { status: 200, raw: solidPng(url.pathname, 120), headers: { "content-type": "image/png" } };
      }
      if (host === "cdnt-preview.dzcdn.net") {
        const entry = entries.find((candidate) => url.pathname.endsWith(`/${candidate.trackId}.mp3`));
        if (!entry) return { status: 404, body: "Not found" };
        return { status: 200, raw: readFileSync(tracks.file(entry.artist, entry.album, entry.index, "mp3").path), headers: { "content-type": "audio/mpeg" } };
      }
      const parts = url.pathname.split("/").filter(Boolean);
      const query = url.searchParams.get("q");
      if (parts[0] === "search" && parts[1] === "artist") return list(artists.filter((artist) => matches(query, artist.name)).map(artistJson), url);
      if (parts[0] === "search" && parts[1] === "album") {
        return list(artists.flatMap((artist) => artist.albums.map((album) => ({ artist, album })))
          .filter(({ artist, album }) => matches(query, `${artist.name} ${album.title}`))
          .map(({ artist, album }) => ({ ...albumJson(artist, album), artist: artistJson(artist) })), url);
      }
      if (parts[0] === "search" && !parts[1]) {
        return list(entries.filter((entry) => matches(query, `${entry.artist.name} ${entry.title}`)).map(trackJson), url);
      }
      const artist = parts[0] === "artist" && artists.find((entry) => String(entry.deezerId) === parts[1]);
      if (parts[0] === "artist" && !artist) return noData;
      if (artist && !parts[2]) return { status: 200, body: artistJson(artist) };
      if (artist && parts[2] === "top") return list(entries.filter((entry) => entry.artist === artist).map(trackJson), url);
      if (artist && parts[2] === "albums") return list(artist.albums.map((album) => albumJson(artist, album)), url);
      if (artist && parts[2] === "related") return list(artists.filter((entry) => entry !== artist && entry.genres.some((genre) => artist.genres.includes(genre))).map(artistJson), url);
      if (parts[0] === "album") {
        const owner = artists.find((entry) => entry.albums.some((album) => String(deezerIds(entry, album).albumId) === parts[1]));
        const album = owner?.albums.find((entry) => String(deezerIds(owner, entry).albumId) === parts[1]);
        if (!album) return noData;
        if (parts[2] === "tracks") return list(entries.filter((entry) => entry.album === album).map(trackJson), url);
        return { status: 200, body: { ...albumJson(owner, album), artist: artistJson(owner), tracks: { data: entries.filter((entry) => entry.album === album).map(trackJson) } } };
      }
      if (parts[0] === "track") {
        const entry = entries.find((candidate) => String(candidate.trackId) === parts[1]);
        return entry ? { status: 200, body: trackJson(entry) } : noData;
      }
      if (parts[0] === "chart") {
        return { status: 200, body: { artists: { data: artists.map(artistJson) }, tracks: { data: entries.map(trackJson) } } };
      }
      return null;
    },
  };
}
