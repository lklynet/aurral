export const SPOTIFY_IMPORT_MAX_ARTISTS = 5000;

const MIN_PLAY_MS = 30_000;
const HALF_LIFE_MS = 2 * 365 * 24 * 60 * 60 * 1000;
const LIKED_TRACK_SCORE = 1;
const FOLLOWED_SCORE = 3;

export type SpotifyImportArtist = {
  name: string;
  plays: number;
  score: number;
  likedTracks: number;
  followed: boolean;
  firstPlayedAt: number | null;
  lastPlayedAt: number | null;
};

type Play = { artist: string; playedAt: number };
type FileKind = "extended" | "account" | "library";

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);
const records = (value: unknown) => (Array.isArray(value) ? value.filter(isRecord) : []);
const text = (value: unknown) => (typeof value === "string" ? value.trim() : "");

const baseName = (path: string) => path.split(/[\\/]/).pop() ?? "";

const fileKind = (path: string): FileKind | null => {
  const name = baseName(path);
  if (/^Streaming_History_Audio_.*\.json$/i.test(name)) return "extended";
  if (/^StreamingHistory(_music_)?\d+\.json$/i.test(name)) return "account";
  if (/^YourLibrary\.json$/i.test(name)) return "library";
  return null;
};

export const isSpotifyExportFile = (path: string) => fileKind(path) !== null;

const toPlays = (rows: unknown, kind: "extended" | "account") =>
  records(rows).flatMap((row): Play[] => {
    const artist = text(
      kind === "extended" ? row.master_metadata_album_artist_name : row.artistName,
    );
    const msPlayed = Number(kind === "extended" ? row.ms_played : row.msPlayed);
    const playedAt = Date.parse(
      kind === "extended" ? text(row.ts) : `${text(row.endTime).replace(" ", "T")}Z`,
    );
    return artist && msPlayed >= MIN_PLAY_MS && Number.isFinite(playedAt)
      ? [{ artist, playedAt }]
      : [];
  });

export function spotifyExportTally(now = Date.now()) {
  const seen = new Set<string>();
  const plays = { extended: new Map<string, Play[]>(), account: new Map<string, Play[]>() };
  const liked = new Map<string, { name: string; count: number }>();
  const followed = new Map<string, string>();

  const add = (path: string, data: unknown) => {
    const kind = fileKind(path);
    const name = baseName(path).toLowerCase();
    if (!kind || seen.has(name)) return false;
    seen.add(name);
    if (kind !== "library") {
      plays[kind].set(name, toPlays(data, kind));
      return true;
    }
    const library = isRecord(data) ? data : {};
    for (const track of records(library.tracks)) {
      const artist = text(track.artist);
      if (!artist) continue;
      const entry = liked.get(artist.toLowerCase()) ?? { name: artist, count: 0 };
      entry.count += 1;
      liked.set(artist.toLowerCase(), entry);
    }
    for (const artist of records(library.artists)) {
      const artistName = text(artist.name);
      if (artistName) followed.set(artistName.toLowerCase(), artistName);
    }
    return true;
  };

  const artists = () => {
    const tallies = new Map<string, SpotifyImportArtist>();
    const artistFor = (name: string) => {
      const key = name.toLowerCase();
      const existing = tallies.get(key);
      if (existing) return existing;
      const created: SpotifyImportArtist = {
        name,
        plays: 0,
        score: 0,
        likedTracks: 0,
        followed: false,
        firstPlayedAt: null,
        lastPlayedAt: null,
      };
      tallies.set(key, created);
      return created;
    };
    const history = plays.extended.size > 0 ? plays.extended : plays.account;
    for (const filePlays of history.values()) {
      for (const play of filePlays) {
        const artist = artistFor(play.artist);
        artist.plays += 1;
        artist.score += 0.5 ** (Math.max(0, now - play.playedAt) / HALF_LIFE_MS);
        artist.firstPlayedAt = Math.min(artist.firstPlayedAt ?? play.playedAt, play.playedAt);
        artist.lastPlayedAt = Math.max(artist.lastPlayedAt ?? play.playedAt, play.playedAt);
      }
    }
    for (const { name, count } of liked.values()) {
      const artist = artistFor(name);
      artist.likedTracks = count;
      artist.score += count * LIKED_TRACK_SCORE;
    }
    for (const name of followed.values()) {
      const artist = artistFor(name);
      artist.followed = true;
      artist.score += FOLLOWED_SCORE;
    }
    return [...tallies.values()]
      .map((artist) => ({ ...artist, score: Math.round(artist.score * 1000) / 1000 }))
      .sort((a, b) => b.score - a.score || b.plays - a.plays)
      .slice(0, SPOTIFY_IMPORT_MAX_ARTISTS);
  };

  return { add, artists };
}
