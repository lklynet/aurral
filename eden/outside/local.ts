import { releaseDate, type Artist, type Outside } from "./music.ts";

// Lyrics, and everything "near me" needs: where the listener is and who plays there.

const HOME = {
  city: "Portland",
  state: "Oregon",
  stateCode: "OR",
  countryCode: "US",
  postal: "97201",
  latitude: 45.5152,
  longitude: -122.6784,
};
const LYRIC_LINE_SECONDS = 12;
const SHOWS = 24;
const DAY_MS = 86_400_000;

const stamp = (seconds: number) =>
  `[${String(Math.floor(seconds / 60)).padStart(2, "0")}:${String(seconds % 60).padStart(2, "0")}.00]`;

export const lrclib: Outside = {
  hosts: ["lrclib.net"],
  respond({ url }, music) {
    if (url.pathname !== "/api/get") return undefined;
    const title = url.searchParams.get("track_name");
    const track = music.findTracks(`${url.searchParams.get("artist_name")} ${title}`)[0];
    if (!track) return undefined;
    const lines = Array.from(
      { length: Math.max(1, Math.floor(track.durationMs / 1000 / LYRIC_LINE_SECONDS)) },
      (_, index) => ({ at: index * LYRIC_LINE_SECONDS, text: `${track.title}, line ${index + 1}` }),
    );
    return {
      id: track.number,
      trackName: track.title,
      artistName: track.artist.name,
      albumName: track.album.title,
      duration: Math.round(track.durationMs / 1000),
      instrumental: false,
      plainLyrics: lines.map((line) => line.text).join("\n"),
      syncedLyrics: lines.map((line) => `${stamp(line.at)} ${line.text}`).join("\n"),
    };
  },
};

const TOUR = [
  {
    city: "Seattle",
    stateCode: "WA",
    venue: "Climate Pledge Arena",
    latitude: 47.6221,
    longitude: -122.354,
  },
  {
    city: "Vancouver",
    stateCode: "BC",
    venue: "Rogers Arena",
    latitude: 49.2778,
    longitude: -123.1088,
  },
  {
    city: HOME.city,
    stateCode: HOME.stateCode,
    venue: "Moda Center",
    latitude: 45.5316,
    longitude: -122.6668,
  },
  {
    city: "San Francisco",
    stateCode: "CA",
    venue: "Chase Center",
    latitude: 37.768,
    longitude: -122.3877,
  },
  {
    city: "Los Angeles",
    stateCode: "CA",
    venue: "Kia Forum",
    latitude: 33.9583,
    longitude: -118.3417,
  },
  { city: "Denver", stateCode: "CO", venue: "Ball Arena", latitude: 39.7487, longitude: -105.0077 },
  {
    city: "Chicago",
    stateCode: "IL",
    venue: "United Center",
    latitude: 41.8807,
    longitude: -87.6742,
  },
  {
    city: "New York",
    stateCode: "NY",
    venue: "Madison Square Garden",
    latitude: 40.7505,
    longitude: -73.9934,
  },
];

const artistImages = (artist: Artist) =>
  artist.picture ? [{ url: artist.picture, ratio: "4_3", width: 1000 }] : [];

// An artist search gets that artist's tour: a run of dates from the coast inland, one at home.
const tourFor = (artist: Artist) =>
  TOUR.map((stop, index) => {
    const date = new Date(
      Date.now() + (30 + (artist.number % 7) + index * 3) * DAY_MS,
    ).toISOString();
    return {
      id: `eden-tour-${artist.number}-${index}`,
      name: `${artist.name} Live`,
      url: `https://www.ticketmaster.com/event/eden-tour-${artist.number}-${index}`,
      dates: {
        start: {
          localDate: date.slice(0, 10),
          ...(index !== 5 && { localTime: "20:00:00" }),
          dateTime: date,
        },
      },
      _embedded: {
        attractions: [{ name: artist.name, images: artistImages(artist) }],
        venues: [
          {
            name: stop.venue,
            city: { name: stop.city },
            state: { stateCode: stop.stateCode },
            country: { countryCode: stop.stateCode === "BC" ? "CA" : "US" },
            location: { latitude: String(stop.latitude), longitude: String(stop.longitude) },
          },
        ],
      },
    };
  });

export const ticketmaster: Outside = {
  hosts: ["app.ticketmaster.com"],
  respond({ url }, music) {
    if (!url.pathname.endsWith("/events.json")) return undefined;
    const keyword = url.searchParams.get("keyword");
    if (keyword) {
      const [artist] = music.findArtists(keyword);
      const events = artist ? tourFor(artist) : [];
      return { _embedded: { events }, page: { size: events.length, totalPages: 1, number: 0 } };
    }
    const events =
      Number(url.searchParams.get("page")) > 0
        ? []
        : music.popular.slice(0, SHOWS).map((artist, index) => {
            const date = new Date(Date.now() + (index + 1) * 4 * DAY_MS).toISOString();
            return {
              id: `eden-show-${artist.number}`,
              name: artist.name,
              url: `https://www.ticketmaster.com/event/eden-show-${artist.number}`,
              images: artistImages(artist),
              distance: 2 + index,
              dates: {
                start: { localDate: date.slice(0, 10), localTime: "20:00:00", dateTime: date },
              },
              _embedded: {
                attractions: [{ name: artist.name, images: artistImages(artist) }],
                venues: [
                  {
                    name: index % 2 ? "Eden Hall" : "The Garden",
                    city: { name: HOME.city },
                    state: { stateCode: HOME.stateCode, name: HOME.state },
                    country: { countryCode: HOME.countryCode },
                  },
                ],
              },
            };
          });
    return { _embedded: { events }, page: { size: events.length, totalPages: 1, number: 0 } };
  },
};

export const places: Outside = {
  hosts: ["api.zippopotam.us", "ipapi.co", "nominatim.openstreetmap.org"],
  respond({ url }) {
    if (url.hostname === "api.zippopotam.us") {
      return {
        "post code": HOME.postal,
        country: "United States",
        places: [
          {
            "place name": HOME.city,
            state: HOME.state,
            "state abbreviation": HOME.stateCode,
            latitude: String(HOME.latitude),
            longitude: String(HOME.longitude),
          },
        ],
      };
    }
    if (url.hostname === "ipapi.co") {
      return {
        postal: HOME.postal,
        city: HOME.city,
        region: HOME.state,
        region_code: HOME.stateCode,
        country_code: HOME.countryCode,
        latitude: HOME.latitude,
        longitude: HOME.longitude,
      };
    }
    return [
      {
        lat: String(HOME.latitude),
        lon: String(HOME.longitude),
        address: { city: HOME.city, state: HOME.state, country_code: "us" },
      },
    ];
  },
};

export const appleCharts: Outside = {
  hosts: ["rss.marketingtools.apple.com"],
  respond({ url }, music) {
    if (!url.pathname.endsWith("/albums.json")) return undefined;
    const results = music.popular.flatMap((artist) =>
      artist.albums.slice(0, 1).map((album) => ({
        id: String(album.number),
        name: album.title,
        artistName: artist.name,
        releaseDate: releaseDate(album),
        genres: artist.genres.slice(0, 2).map((name) => ({ name })),
      })),
    );
    return { feed: { title: "Top Albums", country: "us", results: results.slice(0, 100) } };
  },
};
