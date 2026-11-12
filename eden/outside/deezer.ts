import {
  pageOf,
  releaseDate,
  type Album,
  type Artist,
  type Music,
  type Outside,
  type Track,
} from "./music.ts";

const NO_DATA = { error: { type: "DataException", message: "no data", code: 800 } };
const PLAYLIST_BASE = 9000;
const PLAYLIST_TRACKS = 40;
const PLAYLISTS = 12;
// Aurral finds the country chart by its title and by Deezer's own charts account.
const CHARTS_USER = { id: 637006841, name: "Deezer Charts" };
const CHART_TITLES = ["Top USA", "Top Worldwide"];
const CHART_TRACKS = 100;
const PREVIEW_SECONDS = 30;
const PREVIEW_FRAME = Buffer.concat([Buffer.from([0xff, 0xfb, 0x90, 0xc4]), Buffer.alloc(413)]);
// Aurral sends the browser straight to a preview, so it has to be an address the
// browser can reach: the proxy's own port on this machine.
const PREVIEW_ORIGIN = `http://127.0.0.1:${process.env.EDEN_PORT_OUTSIDE || 8080}`;
export const PREVIEW_PATH = /^\/deezer\/preview\/\d+\.mp3$/;

// Thirty seconds of silent MP3: 128 kbps mono frames whose audio is all zeros.
export const previewClip = Buffer.concat(
  Array.from({ length: Math.ceil((PREVIEW_SECONDS * 44_100) / 1152) }, () => PREVIEW_FRAME),
);

const artist = (entry: Artist) => ({
  id: entry.number,
  name: entry.name,
  link: `https://www.deezer.com/artist/${entry.number}`,
  nb_album: entry.albums.length,
  nb_fan: entry.votes * 1000,
  picture_medium: entry.picture,
  picture_big: entry.picture,
  picture_xl: entry.picture,
  type: "artist",
});

const album = (entry: Album) => ({
  id: entry.number,
  title: entry.title,
  link: `https://www.deezer.com/album/${entry.number}`,
  record_type: entry.type.toLowerCase(),
  release_date: releaseDate(entry),
  cover_medium: entry.cover,
  cover_big: entry.cover,
  cover_xl: entry.cover,
  fans: entry.votes * 100,
  nb_tracks: entry.tracks.length,
  artist: { id: entry.artist.number, name: entry.artist.name },
  type: "album",
});

const track = (entry: Track) => ({
  id: entry.number,
  title: entry.title,
  title_short: entry.title,
  link: `https://www.deezer.com/track/${entry.number}`,
  preview: `${PREVIEW_ORIGIN}/deezer/preview/${entry.number}.mp3`,
  duration: Math.round(entry.durationMs / 1000),
  rank: entry.album.votes * 1000 - entry.position,
  track_position: entry.position,
  disk_number: entry.disc,
  artist: { id: entry.artist.number, name: entry.artist.name },
  album: {
    id: entry.album.number,
    title: entry.album.title,
    cover_medium: entry.album.cover,
    cover_xl: entry.album.cover,
  },
  type: "track",
});

const DEEZER_EDITOR = { id: 2, name: "Deezer" };

function playlists(music: Music) {
  if (music.playlists.length > 0) {
    return music.playlists.map(({ title, picture, trackCount, tracks }, index) => ({
      tracks,
      playlist: {
        id: PLAYLIST_BASE + index,
        title,
        description: "",
        nb_tracks: trackCount,
        picture_medium: picture,
        picture_big: picture,
        picture_xl: picture,
        link: `https://www.deezer.com/playlist/${PLAYLIST_BASE + index}`,
        user: DEEZER_EDITOR,
        creator: DEEZER_EDITOR,
        type: "playlist",
      },
    }));
  }
  const charts = CHART_TITLES.map((title, index) => ({
    tracks: music.hits.slice(index * 10, index * 10 + CHART_TRACKS),
    playlist: {
      id: PLAYLIST_BASE - 1 - index,
      title,
      description: "The most played tracks",
      nb_tracks: CHART_TRACKS,
      link: `https://www.deezer.com/playlist/${PLAYLIST_BASE - 1 - index}`,
      user: CHARTS_USER,
      creator: CHARTS_USER,
      type: "playlist",
    },
  }));
  const genres = music.genres.slice(0, PLAYLISTS).map((genre, index) => {
    const tracks = music
      .inGenre(genre)
      .flatMap((entry) => entry.albums[0]?.tracks.slice(0, 2) ?? [])
      .slice(0, PLAYLIST_TRACKS);
    return {
      tracks,
      playlist: {
        id: PLAYLIST_BASE + index,
        title: `${genre} essentials`,
        description: `The best-known ${genre} in Eden's catalogue`,
        nb_tracks: tracks.length,
        link: `https://www.deezer.com/playlist/${PLAYLIST_BASE + index}`,
        user: { id: 1, name: "Eden" },
        creator: { id: 1, name: "Eden" },
        type: "playlist",
      },
    };
  });
  return [...charts, ...genres];
}

// Deezer's search takes plain words or `artist:"a" track:"b"`.
const plainQuery = (query: string | null) =>
  (query ?? "").replace(/\b\w+:/g, " ").replace(/"/g, " ");

export const deezer: Outside = {
  hosts: ["api.deezer.com"],
  respond({ url }, music) {
    const list = (items: unknown[], total = items.length) => ({
      data: pageOf(items, url, "limit", "index"),
      total,
    });
    const query = plainQuery(url.searchParams.get("q"));
    const [, kind, id, part] = /^\/(\w+)(?:\/([^/]+))?(?:\/(\w+))?\/?$/.exec(url.pathname) ?? [];
    const number = Number(id);
    if (kind === "search") {
      if (id === "artist") return list(music.findArtists(query).map(artist));
      if (id === "playlist") {
        const words = query.toLowerCase().split(/\s+/).filter(Boolean);
        return list(
          playlists(music)
            .map((entry) => entry.playlist)
            .filter((entry) => words.every((word) => entry.title.toLowerCase().includes(word))),
        );
      }
      if (!id || id === "track") return list(music.findTracks(query).map(track));
    }
    if (kind === "artist") {
      const found = music.artistByNumber.get(number);
      if (!found) return NO_DATA;
      if (!part) return artist(found);
      if (part === "top")
        return list(found.albums.flatMap((entry) => entry.tracks.slice(0, 3)).map(track));
      if (part === "related") return list(music.related(found).map(artist));
      if (part === "albums") return list(found.albums.map(album));
      if (part === "playlists") {
        return list(
          playlists(music)
            .filter((entry) => entry.tracks.some((item) => item.artist.number === number))
            .map((entry) => entry.playlist),
        );
      }
    }
    if (kind === "album") {
      const found = music.albumByNumber.get(number);
      if (!found) return NO_DATA;
      if (!part) return { ...album(found), tracks: { data: found.tracks.map(track) } };
      if (part === "tracks") return list(found.tracks.map(track));
    }
    if (kind === "track") {
      const found = music.trackByNumber.get(number);
      return found ? track(found) : NO_DATA;
    }
    if (kind === "infos") return { country_iso: "US", country: "United States", open: true };
    if (kind === "chart" && part === "playlists") {
      return list(playlists(music).map((entry) => entry.playlist));
    }
    if (kind === "chart" && part === "artists") return list(music.popular.map(artist));
    if (kind === "chart" && part === "tracks") {
      const start = (number * 7) % music.hits.length;
      return list([...music.hits.slice(start), ...music.hits.slice(0, start)].map(track));
    }
    if (kind === "playlist") {
      const found = playlists(music).find((entry) => entry.playlist.id === number);
      if (!found) return NO_DATA;
      if (!part) return { ...found.playlist, tracks: { data: found.tracks.map(track) } };
      if (part === "tracks") return list(found.tracks.map(track));
    }
    return NO_DATA;
  },
};
