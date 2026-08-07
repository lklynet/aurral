import { createHash } from "node:crypto";
import { dbOps } from "../../db/helpers/index.js";
import { getMetadataBaseUrl, getMetadataProviderHealthSnapshot as getBrainzmashHealthSnapshot } from "../providers/brainzmashProvider.js";

export const getLastfmApiKey = () => {
  const settings = dbOps.getSettings();
  return settings.integrations?.lastfm?.apiKey || process.env.LASTFM_API_KEY;
};

export const getTicketmasterApiKey = () => {
  const settings = dbOps.getSettings();
  const configuredValue = settings.integrations?.ticketmaster?.apiKey;
  if (configuredValue !== undefined && configuredValue !== null) {
    return String(configuredValue).trim();
  }
  return String(process.env.TICKETMASTER_API_KEY || "").trim();
};

export const DEFAULT_NEWS_GROUPS = [
  { id: "major", name: "Major Music Publications & Magazines" },
  { id: "indie", name: "Indie & Alternative Music Blogs" },
  { id: "discovery", name: "Music Discovery & Curation" },
  { id: "hiphop", name: "Hip-Hop & Rap" },
  { id: "pop", name: "Pop & Mainstream" },
  { id: "electronic", name: "Electronic & Dance Music" },
  { id: "metal", name: "Metal & Hard Rock" },
  { id: "country", name: "Country & Americana" },
  { id: "jazz", name: "Jazz" },
  { id: "classical", name: "Classical & Contemporary Classical" },
  { id: "specialty", name: "Genre Specialty" },
  { id: "regional", name: "Regional Music Scenes" },
  { id: "concerts", name: "Concerts, Festivals & Live Music" },
];

export const DEFAULT_NEWS_FEEDS = [
  { name: "Consequence", url: "https://consequence.net/feed/", group: "major", builtIn: true },
  { name: "NME", url: "https://www.nme.com/feed", group: "major", builtIn: true },
  { name: "NPR Music", url: "https://feeds.npr.org/1039/rss.xml", group: "major", builtIn: true },
  { name: "Pitchfork", url: "https://pitchfork.com/feed/feed-news/rss", group: "major", builtIn: true },
  { name: "Rolling Stone Music", url: "https://www.rollingstone.com/music/music-news/feed/", group: "major", builtIn: true },
  { name: "The Guardian Music", url: "https://www.theguardian.com/music/rss", group: "major", builtIn: true },
  { name: "uDiscover Music", url: "https://www.udiscovermusic.com/feed/", group: "major", builtIn: true },
  { name: "Stereogum", url: "https://www.stereogum.com/feed/", group: "indie", builtIn: true },
  { name: "Alternative Press", url: "https://www.altpress.com/feed/", group: "indie", builtIn: true },
  { name: "BrooklynVegan", url: "https://www.brooklynvegan.com/feed/", group: "indie", builtIn: true },
  { name: "Gorilla vs. Bear", url: "https://www.gorillavsbear.net/feed/", group: "indie", builtIn: true },
  { name: "Atwood Magazine", url: "https://atwoodmagazine.com/feed/", group: "indie", builtIn: true },
  { name: "Stereofox", url: "https://www.stereofox.com/feed/", group: "discovery", builtIn: true },
  { name: "New Music Buff", url: "https://newmusicbuff.com/feed/", group: "discovery", builtIn: true },
  { name: "HighClouds", url: "https://highclouds.org/feed/", group: "discovery", builtIn: true },
  { name: "Fluxblog", url: "https://fluxblog.org/feed/", group: "discovery", builtIn: true },
  { name: "Indie Music Filter", url: "https://indiemusicfilter.com/feed/", group: "discovery", builtIn: true },
  { name: "Hip-Hop Wired", url: "https://hiphopwired.com/feed/", group: "hiphop", builtIn: true },
  { name: "Rap Radar", url: "https://rapradar.com/feed/", group: "hiphop", builtIn: true },
  { name: "This Is RnB", url: "https://thisisrnb.com/feed/", group: "hiphop", builtIn: true },
  { name: "Popjustice", url: "https://popjustice.com/feed/", group: "pop", builtIn: true },
  { name: "EQ Music", url: "https://eqmusicblog.com/feed/", group: "pop", builtIn: true },
  { name: "This Must Be Pop", url: "https://www.thismustbepop.com/feed/", group: "pop", builtIn: true },
  { name: "Mixmag", url: "https://mixmag.net/feed", group: "electronic", builtIn: true },
  { name: "Dancing Astronaut", url: "https://dancingastronaut.com/feed/", group: "electronic", builtIn: true },
  { name: "EDM Sauce", url: "https://www.edmsauce.com/feed/", group: "electronic", builtIn: true },
  { name: "Your EDM", url: "https://www.youredm.com/feed/", group: "electronic", builtIn: true },
  { name: "Metal Injection", url: "https://metalinjection.net/feed", group: "metal", builtIn: true },
  { name: "MetalSucks", url: "https://www.metalsucks.net/feed/", group: "metal", builtIn: true },
  { name: "Metal Underground", url: "https://www.metalunderground.com/news/rss/", group: "metal", builtIn: true },
  { name: "Saving Country Music", url: "https://www.savingcountrymusic.com/feed/", group: "country", builtIn: true },
  { name: "The Boot", url: "https://theboot.com/feed/", group: "country", builtIn: true },
  { name: "No Depression", url: "https://nodepression.com/feed/", group: "country", builtIn: true },
  { name: "Jazz Journal", url: "https://jazzjournal.co.uk/feed/", group: "jazz", builtIn: true },
  { name: "Nextbop", url: "https://nextbop.com/feed/", group: "jazz", builtIn: true },
  { name: "All About Jazz", url: "https://www.allaboutjazz.com/rss", group: "jazz", builtIn: true },
  { name: "Slipped Disc", url: "https://slippedisc.com/feed/", group: "classical", builtIn: true },
  { name: "I Care if You Listen", url: "https://icareifyoulisten.com/feed/", group: "classical", builtIn: true },
  { name: "Classical Music", url: "https://www.classical-music.com/feed/", group: "classical", builtIn: true },
  { name: "Reggaeville", url: "https://www.reggaeville.com/feeds/news.xml", group: "specialty", builtIn: true },
  { name: "The AU Review", url: "https://www.theaureview.com/feed/", group: "regional", builtIn: true },
  { name: "Grimy Goods", url: "https://www.grimygoods.com/feed/", group: "regional", builtIn: true },
  { name: "Jambase", url: "https://www.jambase.com/feed", group: "concerts", builtIn: true },
].map((feed) => ({
  ...feed,
  id: createHash("sha1").update(feed.url).digest("hex").slice(0, 12),
  enabled: true,
}));

export const normalizeNewsFeeds = (feeds) => {
  const builtInsByUrl = new Map(DEFAULT_NEWS_FEEDS.map((feed) => [feed.url, feed]));
  const storedByUrl = new Map(
    (Array.isArray(feeds) ? feeds : []).map((feed) => [String(feed?.url || "").trim(), feed]),
  );
  const source = [
    ...DEFAULT_NEWS_FEEDS.map((feed) => {
      const stored = storedByUrl.get(feed.url);
      return stored ? { ...feed, enabled: stored.enabled !== false } : feed;
    }),
    ...(Array.isArray(feeds) ? feeds : []).filter((feed) => !builtInsByUrl.has(String(feed?.url || "").trim())),
  ];
  const seen = new Set();
  return source
    .map((feed) => {
      const url = String(feed?.url || "").trim();
      if (!/^https?:\/\//i.test(url)) return null;
      const builtIn = builtInsByUrl.get(url);
      return {
        id: String(feed?.id || builtIn?.id || createHash("sha1").update(url).digest("hex").slice(0, 12)),
        name: String(feed?.name || builtIn?.name || new URL(url).hostname).trim().slice(0, 100),
        url,
        group: String(feed?.group || builtIn?.group || "custom").trim().toLowerCase() || "custom",
        enabled: feed?.enabled !== false,
        builtIn: Boolean(builtIn),
      };
    })
    .filter((feed) => {
      if (!feed || seen.has(feed.url)) return false;
      seen.add(feed.url);
      return true;
    })
    .slice(0, 50);
};

export const normalizeNewsGroups = (groups) => {
  const enabled = groups && typeof groups === "object" ? groups : {};
  return Object.fromEntries(
    DEFAULT_NEWS_GROUPS.map((group) => [group.id, enabled[group.id] !== false]),
  );
};

export const getNewsSettings = () => {
  const settings = dbOps.getSettings();
  const news = settings.integrations?.news || {};
  return {
    enabled: news.enabled !== false,
    feeds: normalizeNewsFeeds(news.feeds),
    groups: normalizeNewsGroups(news.groups),
  };
};

export const getMusicBrainzContact = () => {
  const settings = dbOps.getSettings();
  return (
    settings.integrations?.musicbrainz?.email ||
    process.env.CONTACT_EMAIL ||
    "user@example.com"
  );
};

export const getMusicbrainzApiBaseUrl = () => {
  return getMetadataBaseUrl();
};

export const getMetadataProviderHealthSnapshot = () => {
  return getBrainzmashHealthSnapshot();
};
