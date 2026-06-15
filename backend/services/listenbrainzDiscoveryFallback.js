import NodeCache from "node-cache";
import { UUID_REGEX } from "../config/constants.js";
import {
  getLastfmApiKey,
  listenbrainzRequest,
  musicbrainzGetCachedArtistMbidByName,
  musicbrainzResolveArtistMbidByName,
} from "./apiClients.js";
import { hydrateArtistImages } from "./artistImageHydration.js";
import { getArtistGenres } from "./metadataProvider.js";

export const DISCOVERY_PROVIDER_LASTFM = "lastfm";
export const DISCOVERY_PROVIDER_LISTENBRAINZ_FALLBACK =
  "listenbrainz-fallback";

const LISTENBRAINZ_SITEWIDE_POOL_CACHE = new NodeCache({
  stdTTL: 6 * 60 * 60,
  checkperiod: 15 * 60,
  maxKeys: 8,
});
const LISTENBRAINZ_ENRICHED_POOL_CACHE = new NodeCache({
  stdTTL: 6 * 60 * 60,
  checkperiod: 15 * 60,
  maxKeys: 8,
});
const LISTENBRAINZ_SITEWIDE_POOL_LIMIT = 1000;
const LISTENBRAINZ_SITEWIDE_PAGE_SIZE = 100;
const LISTENBRAINZ_GENRE_ENRICH_CONCURRENCY = 8;

export const DEFAULT_DISCOVERY_GENRE_SECTIONS = [
  {
    name: "Rock",
    tags: [
      "rock",
      "classic rock",
      "alternative rock",
      "indie rock",
      "punk",
      "punk rock",
      "post-punk",
      "metal",
      "heavy metal",
      "hard rock",
      "grunge",
    ],
    artists: [
      "Radiohead",
      "The Beatles",
      "David Bowie",
      "Nirvana",
      "Queen",
      "Pink Floyd",
      "Led Zeppelin",
      "The Rolling Stones",
      "Foo Fighters",
      "Coldplay",
      "Arctic Monkeys",
      "The Strokes",
      "Metallica",
      "Black Sabbath",
      "The Clash",
      "Pixies",
    ],
  },
  {
    name: "Pop",
    tags: [
      "pop",
      "dance pop",
      "synthpop",
      "indie pop",
      "r&b",
      "rnb",
      "soul",
    ],
    artists: [
      "Taylor Swift",
      "Michael Jackson",
      "Madonna",
      "Beyonce",
      "Lady Gaga",
      "The Weeknd",
      "Ariana Grande",
      "Billie Eilish",
      "Dua Lipa",
      "Prince",
      "Kylie Minogue",
      "ABBA",
      "Frank Ocean",
      "SZA",
      "Stevie Wonder",
      "The Weeknd",
    ],
  },
  {
    name: "Hip-Hop",
    tags: ["hip-hop", "hip hop", "rap"],
    artists: [
      "Kendrick Lamar",
      "Nas",
      "A Tribe Called Quest",
      "OutKast",
      "JAY-Z",
      "Missy Elliott",
      "Wu-Tang Clan",
      "The Roots",
      "MF DOOM",
      "Lauryn Hill",
      "Run-D.M.C.",
      "Public Enemy",
    ],
  },
  {
    name: "Electronic",
    tags: [
      "electronic",
      "electronica",
      "edm",
      "house",
      "techno",
      "ambient",
      "downtempo",
      "idm",
    ],
    artists: [
      "Daft Punk",
      "The Chemical Brothers",
      "Aphex Twin",
      "Massive Attack",
      "Justice",
      "Disclosure",
      "Deadmau5",
      "Skrillex",
      "Fatboy Slim",
      "Underworld",
      "Four Tet",
      "Boards of Canada",
    ],
  },
  {
    name: "Indie & Alternative",
    tags: ["indie", "alternative", "alternative pop", "shoegaze", "dream pop"],
    artists: [
      "The Smiths",
      "Pixies",
      "The National",
      "Vampire Weekend",
      "Arcade Fire",
      "Sufjan Stevens",
      "Phoebe Bridgers",
      "Mitski",
      "Bon Iver",
      "Tame Impala",
      "Modest Mouse",
      "Belle and Sebastian",
    ],
  },
  {
    name: "Jazz",
    tags: ["jazz", "bebop", "swing"],
    artists: [
      "Miles Davis",
      "John Coltrane",
      "Herbie Hancock",
      "Thelonious Monk",
      "Nina Simone",
      "Ella Fitzgerald",
      "Duke Ellington",
      "Bill Evans",
      "Charles Mingus",
      "Chet Baker",
      "Kamasi Washington",
      "Sonny Rollins",
    ],
  },
  {
    name: "Folk & Country",
    tags: [
      "folk",
      "singer-songwriter",
      "folk rock",
      "country",
      "alt-country",
      "country rock",
      "americana",
    ],
    artists: [
      "Bob Dylan",
      "Joni Mitchell",
      "Nick Drake",
      "Joan Baez",
      "Simon & Garfunkel",
      "Leonard Cohen",
      "Cat Stevens",
      "Fleet Foxes",
      "Iron & Wine",
      "First Aid Kit",
      "Gillian Welch",
      "Townes Van Zandt",
      "Johnny Cash",
      "Dolly Parton",
      "Willie Nelson",
      "Emmylou Harris",
      "Patsy Cline",
      "Hank Williams",
      "Loretta Lynn",
      "Sturgill Simpson",
      "Kacey Musgraves",
      "Jason Isbell",
      "Chris Stapleton",
      "The Chicks",
    ],
  },
  {
    name: "Classical",
    tags: ["classical", "orchestral", "composer"],
    artists: [
      "Ludwig van Beethoven",
      "Wolfgang Amadeus Mozart",
      "Johann Sebastian Bach",
      "Franz Schubert",
      "Pyotr Ilyich Tchaikovsky",
      "Claude Debussy",
      "Frederic Chopin",
      "Antonio Vivaldi",
      "Johannes Brahms",
      "Igor Stravinsky",
      "Philip Glass",
      "Max Richter",
    ],
  },
];

const normalizeKey = (value) =>
  String(value || "")
    .trim()
    .toLowerCase();

const normalizeGenreText = (value) =>
  String(value || "")
    .normalize("NFKD")
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .replace(/\s+/g, " ")
    .trim();

const normalizeMbid = (value) => {
  const mbid = String(value || "").trim();
  return UUID_REGEX.test(mbid) ? mbid : null;
};

const getListenbrainzArtistMbid = (artist) => {
  const direct = normalizeMbid(artist?.artist_mbid);
  if (direct) return direct;
  const fromArray = Array.isArray(artist?.artist_mbids)
    ? artist.artist_mbids.find((value) => normalizeMbid(value))
    : null;
  return normalizeMbid(fromArray);
};

const artistKeys = (artist) => [
  normalizeKey(artist?.id),
  normalizeKey(artist?.mbid),
  normalizeKey(artist?.foreignArtistId),
  normalizeKey(artist?.name),
  normalizeKey(artist?.artistName),
].filter(Boolean);

const isExistingArtist = (artist, existingArtistKeys) =>
  artistKeys(artist).some((key) => existingArtistKeys?.has(key));

const normalizeCuratedArtist = async (entry, genre) => {
  const name = String(
    typeof entry === "string" ? entry : entry?.name || entry?.artistName || "",
  ).trim();
  if (!name) return null;
  const explicitMbid = normalizeMbid(
    typeof entry === "object" ? entry.mbid || entry.id : null,
  );
  const mbid =
    explicitMbid ||
    musicbrainzGetCachedArtistMbidByName(name) ||
    (await musicbrainzResolveArtistMbidByName(name).catch(() => null));
  if (!mbid) return null;
  return {
    id: mbid,
    mbid,
    navigateTo: mbid,
    name,
    sortName: name,
    type: "Artist",
    tags: [genre.name, ...(genre.tags || [])],
    genres: [genre.name],
    source: "listenbrainz-fallback",
    metaText: genre.name,
  };
};

export const getFallbackGenreNames = () =>
  DEFAULT_DISCOVERY_GENRE_SECTIONS.map((section) => section.name);

export const getFallbackTagNames = () => [
  ...new Set(getFallbackGenreNames().filter(Boolean)),
];

export const findFallbackGenreSection = (tag) => {
  const wanted = normalizeKey(String(tag || "").replace(/^#/, ""));
  if (!wanted) return null;
  return (
    DEFAULT_DISCOVERY_GENRE_SECTIONS.find((section) =>
      [section.name, ...(section.tags || [])]
        .map(normalizeKey)
        .includes(wanted),
    ) || null
  );
};

const getFallbackGenreAliases = (tag) => {
  const section = findFallbackGenreSection(tag);
  if (section) {
    return [
      section.name,
      ...(Array.isArray(section.tags) ? section.tags : []),
    ].filter(Boolean);
  }
  const trimmed = String(tag || "").replace(/^#/, "").trim();
  return trimmed ? [trimmed] : [];
};

const getNormalizedArtistGenreTerms = (artist) => [
  ...(Array.isArray(artist?.genres) ? artist.genres : []),
  ...(Array.isArray(artist?.tags) ? artist.tags : []),
]
  .map(normalizeGenreText)
  .filter(Boolean);

const getNormalizedSectionAliases = (section) =>
  [...new Set([section.name, ...(Array.isArray(section.tags) ? section.tags : [])]
    .map(normalizeGenreText)
    .filter(Boolean))]
    .sort((left, right) => right.length - left.length);

const scoreGenreAliasMatch = (genreTerm, alias) => {
  if (!genreTerm || !alias) return 0;
  if (genreTerm === alias) return 100;
  if (genreTerm.startsWith(`${alias} `) || genreTerm.endsWith(` ${alias}`)) {
    return 60;
  }
  if (genreTerm.includes(` ${alias} `)) return 45;
  if (alias.length >= 5 && genreTerm.includes(alias)) return 25;
  return 0;
};

const classifyArtistToFallbackGenre = (artist) => {
  const genreTerms = getNormalizedArtistGenreTerms(artist);
  if (genreTerms.length === 0) return null;

  let bestSection = null;
  let bestScore = 0;

  for (const section of DEFAULT_DISCOVERY_GENRE_SECTIONS) {
    const aliases = getNormalizedSectionAliases(section);
    let sectionScore = 0;
    for (const genreTerm of genreTerms) {
      for (const alias of aliases) {
        sectionScore += scoreGenreAliasMatch(genreTerm, alias);
      }
    }
    if (sectionScore > bestScore) {
      bestScore = sectionScore;
      bestSection = section;
    }
  }

  return bestScore > 0 ? bestSection : null;
};

export const fetchListenbrainzGlobalTopArtists = async ({
  count = 64,
  offset = 0,
  range = "week",
} = {}) => {
  const data = await listenbrainzRequest("/1/stats/sitewide/artists", {
    count,
    offset,
    range,
  }).catch(() => null);
  const artists = Array.isArray(data?.payload?.artists)
    ? data.payload.artists
    : [];
  return artists
    .map((artist, index) => {
      const name = String(artist?.artist_name || "").trim();
      if (!name) return null;
      const mbid = getListenbrainzArtistMbid(artist);
      return {
        id: mbid,
        mbid,
        navigateTo: mbid,
        name,
        sortName: name,
        type: "Artist",
        source: "listenbrainz",
        popularityLabel: "Trending on ListenBrainz",
        listenCount: Number.parseInt(artist?.listen_count || 0, 10) || 0,
        popularityRank: index + 1,
        metaText: "Trending on ListenBrainz",
      };
    })
    .filter(Boolean);
};

const fetchListenbrainzSitewideArtistPool = async ({
  limit = LISTENBRAINZ_SITEWIDE_POOL_LIMIT,
  range = "all_time",
} = {}) => {
  const boundedLimit = Math.max(
    LISTENBRAINZ_SITEWIDE_PAGE_SIZE,
    Math.min(LISTENBRAINZ_SITEWIDE_POOL_LIMIT, Number(limit) || LISTENBRAINZ_SITEWIDE_POOL_LIMIT),
  );
  const cacheKey = `${range}:${boundedLimit}`;
  const cached = LISTENBRAINZ_SITEWIDE_POOL_CACHE.get(cacheKey);
  if (Array.isArray(cached)) return cached;

  const artists = [];
  for (
    let offset = 0;
    offset < boundedLimit;
    offset += LISTENBRAINZ_SITEWIDE_PAGE_SIZE
  ) {
    const page = await fetchListenbrainzGlobalTopArtists({
      count: Math.min(LISTENBRAINZ_SITEWIDE_PAGE_SIZE, boundedLimit - offset),
      offset,
      range,
    }).catch(() => []);
    const slice = Array.isArray(page) ? page : [];
    if (slice.length === 0) break;
    const ranked = slice.map((artist, index) => ({
      ...artist,
      popularityRank: offset + index + 1,
    }));
    artists.push(...ranked);
    if (slice.length < LISTENBRAINZ_SITEWIDE_PAGE_SIZE) break;
  }

  const deduped = [];
  const seen = new Set();
  for (const artist of artists) {
    const key = normalizeKey(artist?.mbid || artist?.id || artist?.name);
    if (!key || seen.has(key)) continue;
    seen.add(key);
    deduped.push(artist);
  }
  LISTENBRAINZ_SITEWIDE_POOL_CACHE.set(cacheKey, deduped);
  return deduped;
};

const enrichListenbrainzArtistPoolWithGenres = async (artists = []) => {
  const enriched = [];
  for (
    let index = 0;
    index < artists.length;
    index += LISTENBRAINZ_GENRE_ENRICH_CONCURRENCY
  ) {
    const batch = artists.slice(index, index + LISTENBRAINZ_GENRE_ENRICH_CONCURRENCY);
    const results = await Promise.allSettled(
      batch.map(async (artist) => {
        if (!artist?.name) return null;
        let mbid = normalizeMbid(artist?.mbid || artist?.id);
        if (!mbid) {
          mbid =
            musicbrainzGetCachedArtistMbidByName(artist.name) ||
            (await musicbrainzResolveArtistMbidByName(artist.name).catch(() => null));
        }
        if (!mbid) return null;
        const genres = await getArtistGenres(mbid).catch(() => []);
        return {
          ...artist,
          id: mbid,
          mbid,
          navigateTo: mbid,
          genres: Array.isArray(genres) ? genres.filter(Boolean) : [],
          tags: Array.isArray(genres) ? genres.filter(Boolean) : [],
        };
      }),
    );
    for (const result of results) {
      if (result.status === "fulfilled" && result.value) {
        enriched.push(result.value);
      }
    }
  }
  return enriched;
};

const getListenbrainzEnrichedGenrePool = async ({
  limit = LISTENBRAINZ_SITEWIDE_POOL_LIMIT,
  range = "all_time",
} = {}) => {
  const boundedLimit = Math.max(
    LISTENBRAINZ_SITEWIDE_PAGE_SIZE,
    Math.min(LISTENBRAINZ_SITEWIDE_POOL_LIMIT, Number(limit) || LISTENBRAINZ_SITEWIDE_POOL_LIMIT),
  );
  const cacheKey = `${range}:${boundedLimit}`;
  const cached = LISTENBRAINZ_ENRICHED_POOL_CACHE.get(cacheKey);
  if (Array.isArray(cached)) return cached;
  const rawPool = await fetchListenbrainzSitewideArtistPool({
    limit: boundedLimit,
    range,
  });
  const enriched = await enrichListenbrainzArtistPoolWithGenres(rawPool);
  LISTENBRAINZ_ENRICHED_POOL_CACHE.set(cacheKey, enriched);
  return enriched;
};

const buildFallbackGenrePoolsFromArtists = ({
  artists = [],
  existingArtistKeys = new Set(),
} = {}) => {
  const buckets = Object.fromEntries(
    DEFAULT_DISCOVERY_GENRE_SECTIONS.map((section) => [section.name, []]),
  );
  for (const artist of artists) {
    const section = classifyArtistToFallbackGenre(artist);
    if (!section?.name) continue;
    if (isExistingArtist(artist, existingArtistKeys)) continue;
    buckets[section.name].push({
      ...artist,
      source: artist.source || "listenbrainz",
      metaText: section.name,
      tags:
        Array.isArray(artist.tags) && artist.tags.length > 0
          ? artist.tags
          : [section.name, ...(section.tags || [])],
      genres:
        Array.isArray(artist.genres) && artist.genres.length > 0
          ? artist.genres
          : [section.name],
    });
  }
  return buckets;
};

export const buildListenbrainzFallbackGenrePools = async ({
  existingArtistKeys = new Set(),
  limit = LISTENBRAINZ_SITEWIDE_POOL_LIMIT,
  range = "all_time",
} = {}) => {
  const enrichedPool = await getListenbrainzEnrichedGenrePool({
    limit,
    range,
  });
  return buildFallbackGenrePoolsFromArtists({
    artists: enrichedPool,
    existingArtistKeys,
  });
};

const buildFallbackGenreSectionsFromPools = async (
  fallbackGenrePools,
  { hydrate = true, sectionSize = 12 } = {},
) => {
  const sections = [];
  for (const section of DEFAULT_DISCOVERY_GENRE_SECTIONS) {
    const artists = Array.isArray(fallbackGenrePools?.[section.name])
      ? fallbackGenrePools[section.name].slice(0, sectionSize)
      : [];
    if (artists.length === 0) continue;
    if (hydrate) {
      await hydrateArtistImages(artists, {
        limit: artists.length,
        batchSize: 6,
        delayMs: 25,
      });
    }
    sections.push({
      name: section.name,
      tags: [section.name],
      artists,
    });
  }
  return sections;
};

const buildGenreSection = async (
  genre,
  { existingArtistKeys = new Set(), hydrate = true } = {},
) => {
  const artists = (
    await Promise.all(
      genre.artists.map((artist) => normalizeCuratedArtist(artist, genre)),
    )
  )
    .filter(Boolean)
    .filter((artist) => !isExistingArtist(artist, existingArtistKeys));
  if (hydrate && artists.length > 0) {
    await hydrateArtistImages(artists, {
      limit: artists.length,
      batchSize: 6,
      delayMs: 25,
    });
  }
  if (artists.length === 0) return null;
  return {
    name: genre.name,
    tags: genre.tags,
    artists,
  };
};

export const buildDefaultGenreSections = async ({
  existingArtistKeys = new Set(),
  hydrate = true,
} = {}) => {
  const sections = [];
  for (const genre of DEFAULT_DISCOVERY_GENRE_SECTIONS) {
    const section = await buildGenreSection(genre, {
      existingArtistKeys,
      hydrate,
    });
    if (section) sections.push(section);
  }
  return sections;
};

export const searchFallbackGenreArtists = async ({
  tag,
  limit = 24,
  offset = 0,
  existingArtistKeys = new Set(),
  precomputedGenrePools = null,
} = {}) => {
  const aliases = getFallbackGenreAliases(tag);
  if (aliases.length === 0) return null;
  const targetSection = findFallbackGenreSection(tag);
  const targetSectionName = targetSection?.name || aliases[0];
  const fallbackGenrePools =
    precomputedGenrePools ||
    (await buildListenbrainzFallbackGenrePools({
      existingArtistKeys,
      limit: LISTENBRAINZ_SITEWIDE_POOL_LIMIT,
      range: "all_time",
    }));
  const matchingArtists = Array.isArray(fallbackGenrePools?.[targetSectionName])
    ? fallbackGenrePools[targetSectionName]
    : [];
  const pagedArtists = matchingArtists.slice(offset, offset + limit);
  if (pagedArtists.length > 0) {
    await hydrateArtistImages(pagedArtists, {
      limit: pagedArtists.length,
      batchSize: 8,
      delayMs: 25,
    });
  }
  if (matchingArtists.length > 0) {
    return {
      artists: pagedArtists,
      total: matchingArtists.length,
      section: {
        name: targetSectionName || String(tag || "").replace(/^#/, "").trim(),
        tags: aliases,
        artists: pagedArtists,
      },
    };
  }

  const section = findFallbackGenreSection(tag);
  if (!section) return null;
  const resolved = await buildGenreSection(section, {
    existingArtistKeys,
    hydrate: true,
  });
  const artists = Array.isArray(resolved?.artists) ? resolved.artists : [];
  return {
    artists: artists.slice(offset, offset + limit),
    total: artists.length,
    section: resolved || { name: section.name, tags: section.tags, artists: [] },
  };
};

export const getDiscoveryCapabilities = (hasLastfmKey = !!getLastfmApiKey()) => {
  const full = !!hasLastfmKey;
  return {
    personalizedRecommendations: full,
    globalTrending: true,
    genreSections: true,
    arbitraryTagSearch: full,
    relatedArtists: full,
    flows: {
      discover: full,
      trending: full,
      mix: full,
      focus: full,
    },
  };
};

export const getFlowCapabilities = (hasLastfmKey = !!getLastfmApiKey()) => {
  if (hasLastfmKey) {
    return {
      lastfmRequired: false,
      availableSources: ["discover", "mix", "trending", "focus"],
      unavailableSources: {},
    };
  }
  return {
    lastfmRequired: true,
    availableSources: [],
    unavailableSources: {
      discover: "Last.fm API key required",
      mix: "Last.fm API key required",
      trending: "Last.fm API key required",
      focus: "Last.fm API key required",
    },
  };
};

export const buildListenbrainzFallbackDiscovery = async ({
  existingArtistKeys = new Set(),
  onProgress = null,
} = {}) => {
  onProgress?.({
    phase: "warming_genre_pool",
    progress: 28,
    progressMessage: "Building ListenBrainz genre pool",
  });
  const fallbackGenrePools = await buildListenbrainzFallbackGenrePools({
    existingArtistKeys,
    limit: LISTENBRAINZ_SITEWIDE_POOL_LIMIT,
    range: "all_time",
  });
  const rawGlobalTop = await fetchListenbrainzGlobalTopArtists({
    count: 80,
    range: "week",
  });
  const globalTop = [];
  const seen = new Set();
  for (const artist of rawGlobalTop) {
    if (!artist?.name) continue;
    let mbid = normalizeMbid(artist.id);
    if (!mbid) {
      mbid =
        musicbrainzGetCachedArtistMbidByName(artist.name) ||
        (await musicbrainzResolveArtistMbidByName(artist.name).catch(() => null));
    }
    if (!mbid) continue;
    const entry = {
      ...artist,
      id: mbid,
      mbid,
      navigateTo: mbid,
    };
    const key = normalizeKey(mbid);
    if (seen.has(key)) continue;
    if (isExistingArtist(entry, existingArtistKeys)) continue;
    seen.add(key);
    globalTop.push(entry);
    if (globalTop.length >= 32) break;
  }

  await hydrateArtistImages(globalTop, {
    limit: globalTop.length,
    batchSize: 8,
    delayMs: 25,
  });

  onProgress?.({
    phase: "building_genres",
    progress: 55,
    progressMessage: "Preparing fallback genre sections",
  });
  let fallbackGenres = await buildFallbackGenreSectionsFromPools(fallbackGenrePools, {
    hydrate: true,
  });
  if (fallbackGenres.length === 0) {
    fallbackGenres = await buildDefaultGenreSections({
      existingArtistKeys,
      hydrate: true,
    });
  }
  const topGenres = fallbackGenres.map((section) => section.name);

  return {
    provider: DISCOVERY_PROVIDER_LISTENBRAINZ_FALLBACK,
    capabilities: getDiscoveryCapabilities(false),
    recommendations: [],
    globalTop,
    basedOn: [],
    topTags: getFallbackTagNames().filter(
      (tag) => !blockSets.tags.has(normalizeKey(tag)),
    ),
    topGenres,
    fallbackGenres,
    fallbackGenrePools,
    lastUpdated: new Date().toISOString(),
  };
};
