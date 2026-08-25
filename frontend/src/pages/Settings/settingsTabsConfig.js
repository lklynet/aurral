import {
  Bell,
  Compass,
  Database,
  Download,
  HardDrive,
  ListChecks,
  Monitor,
  Music,
  Rss,
  DatabaseSearch,
  Server,
  Users,
} from "lucide-react";

export const SETTINGS_TABS = [
  { id: "system", label: "System", icon: Monitor },
  { id: "storage-health", label: "Storage health", icon: HardDrive },
  { id: "tasks", label: "Tasks", icon: ListChecks },
  { id: "lidarr", label: "Lidarr", icon: Server },
  { id: "indexers", label: "Indexers", icon: DatabaseSearch },
  { id: "download-clients", label: "Download clients", icon: Download },
  { id: "playback", label: "Playback", icon: Music },
  { id: "connect", label: "Connect", icon: Bell },
  { id: "rss-news", label: "RSS news", icon: Rss },
  { id: "discover", label: "Discover", icon: Compass },
  { id: "metadata", label: "Metadata", icon: Database, hidden: true },
  { id: "users", label: "Users", icon: Users },
];

export const SETTINGS_NAV_TABS = SETTINGS_TABS.filter((tab) => !tab.hidden);

const SETTINGS_SEARCH_METADATA = {
  system: {
    sections: ["Runtime", "Data", "Display", "API key", "More info"],
    services: {
      Runtime: "version uptime host platform",
      Database: "sqlite data runtime",
      Docker: "container runtime",
    },
    fields: {
      Version: "application build",
      Uptime: "running process",
      Environment: "runtime mode hostname",
      Platform: "node operating system architecture",
      Container: "docker host process",
      "App data": "data directory",
      "Database path": "sqlite file",
      "Startup directory": "working directory",
      "API key": "X-Api-Key api_key authentication copy rotate",
    },
  },
  "storage-health": {
    sections: ["Health", "Disk space", "Storage health"],
    services: {
      Storage: "disk filesystem paths data directory",
      Downloads: "download paths free space",
      Database: "sqlite data storage",
    },
    fields: {
      Location: "mount path filesystem",
      Role: "storage purpose",
      "Free space": "disk available capacity",
      "Total space": "disk capacity",
      "Run checks": "verify storage library paths transfers playback",
    },
  },
  tasks: {
    sections: ["Scheduled", "Workers", "Queue"],
    services: {
      "Background tasks": "jobs workers",
      "Weekly Flow": "playlist flow",
    },
    fields: {
      Scheduled: "next run interval schedule",
      Workers: "processor status failures standby",
      Queue: "jobs running queued completed failed retry duration",
      "Clear stale": "stuck tasks jobs",
    },
  },
  lidarr: {
    sections: ["Connection", "Defaults", "Community guide"],
    services: {
      Lidarr: "music library artists albums",
      MusicBrainz: "metadata artist ids",
    },
    fields: {
      "Server URL": "address host connection",
      "API key": "credentials authentication",
      "External URL": "browser view on lidarr public address",
      "Default root folder": "library path",
      "Default quality profile": "lidarr profile",
      "Default metadata profile": "lidarr metadata",
      Tag: "lidarr tag",
      "Default monitoring option": "albums existing future missing latest first",
      "Search on add": "missing albums artists",
      "Community guide": "Davo recommended settings custom formats naming scheme",
    },
  },
  indexers: {
    sections: ["Connection", "Indexing", "Priority", "Details"],
    services: {
      Prowlarr: "indexer manager search",
      Usenet: "audio indexers",
    },
    fields: {
      "Enable Prowlarr": "turn on indexer manager",
      "Server URL": "address host connection",
      "API key": "credentials authentication",
      "Music categories": "audio category 3000",
      "Result limit": "maximum search results",
      "Enable in Aurral": "indexer enabled",
      Priority: "indexer order preference",
      Protocol: "usenet torrent",
      "Prowlarr status": "enabled disabled",
    },
  },
  "download-clients": {
    sections: ["Quality profile", "Downloads folder", "Remote path mappings", "Connection", "Behavior", "Downloads", "Advanced"],
    services: {
      slskd: "Soulseek download client",
      "yt-dlp": "YouTube web download client",
      NZBGet: "Usenet download client",
      SABnzbd: "Usenet download client",
    },
    fields: {
      "Quality profile": "default acceptable allowed formats rank preference cutoff upgrades",
      Qualities: "FLAC MP3 M4A 128 192 256 320 bitrate hi-res standard allowed cutoff drag rank",
      "Automatic upgrades": "upgrade searches Flow Static tracks",
      "Upgrade interval": "days between checks",
      Path: "downloads folder media library",
      "Applies to": "remote path mapping source client all",
      "Remote path": "download client path mapping",
      "Local path": "Aurral path mapping",
      "Enable slskd": "Soulseek on off",
      "Enable yt-dlp": "YouTube web on off",
      "Enable NZBGet": "Usenet on off",
      "Enable SABnzbd": "Usenet on off",
      "Server URL": "client address host connection",
      "API key": "client credentials authentication",
      Username: "NZBGet credentials",
      Password: "NZBGet credentials",
      "Source priority": "client order preference",
      "Staging path": "yt-dlp temporary download folder",
      Category: "Usenet downloads",
      "NZB priority": "NZBGet queue",
      "Completed download path": "NZBGet import folder",
      "Add NZBs paused": "NZBGet pause queue",
      "Clean up after runs": "SABnzbd history cleanup",
    },
  },
  playback: {
    sections: ["Playback servers", "Scrobbling", "Cover art", "Connection", "Account", "Aurral library path", "Main library (optional)", "Sync"],
    services: {
      Navidrome: "Subsonic music server",
      Plex: "Plexamp music server",
      Jellyfin: "Jellyfin music server",
      Scrobbling: "Last.fm ListenBrainz Koito completed plays",
    },
    fields: {
      "Server URL": "playback server address host connection",
      "Subsonic / Navidrome": "playback server connection",
      "API key": "Jellyfin credentials authentication",
      "User ID": "Jellyfin playlist owner",
      Username: "Navidrome Subsonic credentials",
      Password: "Navidrome Subsonic credentials",
      Account: "Plex link sign in authentication",
      "Plex server": "select server",
      "Plex Aurral Library path (optional)": "Plex library section path",
      "Include tracks from an existing library": "Plex main library",
      "Local path for this library (optional)": "Plex path mapping",
      Sync: "Navidrome scan playlists Plex refresh",
      "Last.fm": "scrobbling OAuth account",
      ListenBrainz: "scrobbling user token",
      Koito: "scrobbling API key URL",
    },
  },
  connect: {
    sections: ["Connections", "Webhooks", "Notification events", "Inbox"],
    services: {
      Gotify: "push notifications mobile alerts",
      "Last.fm": "recommendations API key secret scrobbling",
      Ticketmaster: "local shows events",
      Inbox: "library updates releases shows news discoveries",
      Webhooks: "notifications HTTP callbacks",
    },
    fields: {
      "Server URL": "Gotify address host connection",
      "Application token": "Gotify credentials API",
      "API key": "Last.fm recommendations and scrobbling credentials",
      "API secret": "Last.fm scrobbling credentials",
      "Consumer key": "Ticketmaster API credentials",
      "Search radius (miles)": "local shows concerts distance",
      "Local discovery": "Ticketmaster shows concerts artists",
      "Include recommended artists in local shows": "Ticketmaster discovery",
      "Include trending artists in local shows": "Ticketmaster discovery",
      URL: "webhook endpoint",
      Headers: "webhook HTTP header key value",
      Body: "webhook payload JSON",
      "Discover updated": "notification event webhook Gotify",
      "Weekly flow finished": "notification event webhook Gotify",
      "Request made": "notification event webhook Gotify",
      "Request available": "notification event webhook Gotify",
      "Enable inbox": "inbox on off",
      "Upcoming releases": "inbox albums",
      "Upcoming shows": "inbox concerts events",
      "Library artist news": "inbox RSS",
      "Recommended artist news": "inbox RSS",
      Discoveries: "inbox recommendations",
    },
  },
  "rss-news": {
    sections: ["RSS news", "Custom feeds", "Feed groups"],
    services: {
      News: "RSS articles artists library recommendations",
      Feeds: "music news sources custom feeds",
    },
    fields: {
      "Enable RSS news": "news on off",
      "Add RSS feed": "custom source",
      "Feed name": "custom RSS source",
      "Feed URL": "custom RSS address",
      "Feed groups": "major publications magazines indie alternative discovery hip hop rap pop mainstream electronic dance metal hard rock country americana jazz classical specialty regional concerts festivals live music",
    },
  },
  discover: {
    sections: ["Discovery behavior", "Cache status"],
    services: {
      "Last.fm": "recommendations listening history",
      ListenBrainz: "recommendations discovery fallback",
      "Release Radar": "personalized playlists",
    },
    fields: {
      "Auto-refresh frequency": "daily weekly monthly recommendations",
      "Discovery mode": "safer balanced deeper recommendations",
      "Recommended artists": "number per refresh",
      "Recommended playlists": "Discover Weekly Trending Mix Library Blend Listening History Release Radar",
      "Refresh discovery": "update recommendations now",
      "Clear image cache": "artwork cache reset",
      Provider: "Last.fm ListenBrainz fallback",
      "Last updated": "discovery cache status",
    },
  },
  metadata: {
    sections: ["Metadata server"],
    services: {
      BrainzMash: "MusicBrainz metadata provider",
    },
    fields: {
      "Base URL": "metadata server address endpoint",
    },
  },
  users: {
    sections: ["Change password", "Local network auto-login", "Users"],
    services: {
      Authentication: "login password security",
      Permissions: "roles access control",
      Plex: "account linking",
    },
    fields: {
      "Current password": "change password authentication",
      "New password": "change password authentication",
      "Confirm password": "change password authentication",
      "Auto-login": "local network bypass authentication login",
      Name: "create edit user account",
      Email: "create edit user account",
      Username: "create edit user account",
      Password: "create edit user account",
      Permissions: "roles manage users access",
      "Plex account": "link user playback identity",
    },
  },
};

const normalizeSearchText = (value) =>
  String(value || "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .trim();

const createSettingsSearchItem = (tab, kind, label, keywords = "") => ({
  id: tab.id,
  key: `${tab.id}:${kind}:${label}`,
  label,
  kind,
  tabLabel: tab.label,
  searchText: normalizeSearchText(`${tab.label} ${tab.id} ${label} ${keywords}`),
});

export const SETTINGS_SEARCH_ITEMS = SETTINGS_TABS.flatMap((tab) => {
  const metadata = SETTINGS_SEARCH_METADATA[tab.id] || {};
  const items = [createSettingsSearchItem(tab, "page", tab.label, tab.id)];

  for (const section of metadata.sections || []) {
    items.push(createSettingsSearchItem(tab, "section", section));
  }

  for (const [service, keywords] of Object.entries(metadata.services || {})) {
    if (service.toLowerCase() !== tab.label.toLowerCase()) {
      items.push(createSettingsSearchItem(tab, "service", service, keywords));
    }
  }

  for (const [field, keywords] of Object.entries(metadata.fields || {})) {
    const existing = items.find((item) => item.label.toLowerCase() === field.toLowerCase());
    if (existing) {
      existing.searchText = normalizeSearchText(`${existing.searchText} ${keywords}`);
    } else {
      items.push(createSettingsSearchItem(tab, "setting", field, keywords));
    }
  }

  return items;
});

export function searchSettingsItems(query) {
  const terms = normalizeSearchText(query).split(" ").filter(Boolean);
  if (!terms.length) return [];
  return SETTINGS_SEARCH_ITEMS.filter((item) =>
    terms.every((term) => item.searchText.includes(term)),
  );
}

export const SETTINGS_TAB_IDS = SETTINGS_TABS.map((tab) => tab.id);

export const DEFAULT_SETTINGS_TAB = "system";

export const LEGACY_SETTINGS_TAB_MAP = {
  integrations: "lidarr",
  library: "lidarr",
  playlists: "download-clients",
  downloads: "system",
  storage: "storage-health",
  general: "system",
  notifications: "connect",
};

export function normalizeSettingsTabId(tabId) {
  if (!tabId) return DEFAULT_SETTINGS_TAB;
  const legacy = LEGACY_SETTINGS_TAB_MAP[tabId];
  if (legacy) return legacy;
  return SETTINGS_TAB_IDS.includes(tabId) ? tabId : DEFAULT_SETTINGS_TAB;
}

export function getSettingsTabById(tabId) {
  const normalized = normalizeSettingsTabId(tabId);
  return SETTINGS_TABS.find((tab) => tab.id === normalized) || SETTINGS_TABS[0];
}
