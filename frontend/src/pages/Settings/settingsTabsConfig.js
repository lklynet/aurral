import {
  Bell,
  Compass,
  Database,
  Download,
  HardDrive,
  ListChecks,
  Monitor,
  Music,
  DatabaseSearch,
  Server,
  Users,
} from "lucide-react";

export const SETTINGS_TABS = [
  { id: "system", label: "System", icon: Monitor },
  { id: "storage-health", label: "Storage Health", icon: HardDrive },
  { id: "tasks", label: "Tasks", icon: ListChecks },
  { id: "lidarr", label: "Lidarr", icon: Server },
  { id: "indexers", label: "Indexers", icon: DatabaseSearch },
  { id: "download-clients", label: "Download Clients", icon: Download },
  { id: "playback", label: "Playback", icon: Music },
  { id: "connect", label: "Connect", icon: Bell },
  { id: "discover", label: "Discover", icon: Compass },
  { id: "metadata", label: "Metadata", icon: Database, hidden: true },
  { id: "users", label: "Users", icon: Users },
];

export const SETTINGS_NAV_TABS = SETTINGS_TABS.filter((tab) => !tab.hidden);

const SETTINGS_SEARCH_METADATA = {
  system: {
    sections: ["Runtime", "Data", "API Key", "More Info"],
    services: {
      Runtime: "version uptime host platform",
      Database: "sqlite data runtime",
      Docker: "container runtime",
    },
  },
  "storage-health": {
    sections: ["Health", "Disk Space", "Storage Health"],
    services: {
      Storage: "disk filesystem paths data directory",
      Downloads: "download paths free space",
      Database: "sqlite data storage",
    },
  },
  tasks: {
    sections: ["Scheduled", "Workers", "Queue"],
    services: {
      "Background tasks": "jobs workers",
      "Weekly Flow": "playlist flow",
    },
  },
  lidarr: {
    sections: ["Connection", "Defaults", "Community guide"],
    services: {
      Lidarr: "music library artists albums",
      MusicBrainz: "metadata artist ids",
    },
  },
  indexers: {
    sections: ["General", "Connection", "Indexing", "Priority", "Details"],
    services: {
      Prowlarr: "indexer manager search",
      Usenet: "audio indexers",
    },
  },
  "download-clients": {
    sections: ["Downloads Folder", "Remote Path Mappings", "General", "Connection", "Behavior", "Downloads", "Advanced"],
    services: {
      slskd: "Soulseek download client",
      "yt-dlp": "YouTube web download client",
      NZBGet: "Usenet download client",
      SABnzbd: "Usenet download client",
    },
  },
  playback: {
    sections: ["Playback Servers", "Navidrome Playlist Paths", "Cover Art", "Connection", "Account", "Aurral Library Path", "Main library", "Sync"],
    services: {
      Navidrome: "Subsonic music server",
      Plex: "Plexamp music server",
    },
  },
  connect: {
    sections: ["Connections", "Webhooks", "Notification Events", "Inbox"],
    services: {
      Gotify: "push notifications mobile alerts",
      "Last.fm": "listening history API",
      Ticketmaster: "local shows events",
      Inbox: "library updates releases shows news discoveries",
      Webhooks: "notifications HTTP callbacks",
    },
  },
  discover: {
    sections: ["Discovery Behavior", "Cache Status"],
    services: {
      "Last.fm": "recommendations listening history",
      ListenBrainz: "recommendations discovery fallback",
      "Release Radar": "personalized playlists",
    },
  },
  metadata: {
    sections: ["Metadata Server"],
    services: {
      BrainzMash: "MusicBrainz metadata provider",
    },
  },
  users: {
    sections: ["Change Password", "Local Network Auto-login", "Users"],
    services: {
      Authentication: "login password security",
      Permissions: "roles access control",
      Plex: "account linking",
    },
  },
};

const createSettingsSearchItem = (tab, kind, label, keywords = "") => ({
  id: tab.id,
  key: `${tab.id}:${kind}:${label}`,
  label,
  kind,
  tabLabel: tab.label,
  searchText: `${tab.label} ${tab.id} ${label} ${keywords}`.toLowerCase(),
});

export const SETTINGS_SEARCH_ITEMS = SETTINGS_NAV_TABS.flatMap((tab) => {
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

  return items;
});

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
