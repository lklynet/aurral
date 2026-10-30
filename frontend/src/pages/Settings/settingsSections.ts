import {
  Activity,
  Bell,
  Compass,
  Database,
  Download,
  Eye,
  Headphones,
  Library,
  Link,
  Monitor,
  Music,
  Server,
  SlidersHorizontal,
  User,
  Users,
} from "../../components/icons";

export const SETTINGS_SECTIONS = [
  { id: "profile", label: "Profile", icon: User, group: "account" },
  { id: "listening", label: "Listening", icon: Headphones, group: "account" },
  { id: "appearance", label: "Appearance", icon: Monitor, group: "account" },
  { id: "shared-links", label: "Shared links", icon: Link, group: "account" },
  { id: "general", label: "General", icon: SlidersHorizontal, group: "server" },
  { id: "users", label: "Users", icon: Users, group: "server" },
  { id: "library", label: "Library", icon: Library, group: "server" },
  { id: "monitoring", label: "Monitoring", icon: Eye, group: "server" },
  { id: "downloads", label: "Downloads", icon: Download, group: "server" },
  { id: "playback", label: "Playback", icon: Music, group: "server" },
  { id: "discovery", label: "Discovery", icon: Compass, group: "server" },
  { id: "notifications", label: "Notifications", icon: Bell, group: "server" },
  { id: "lidarr", label: "Lidarr", icon: Server, group: "server" },
  { id: "status", label: "Status", icon: Activity, group: "server" },
  { id: "metadata", label: "Metadata", icon: Database, group: "server", hidden: true },
] as const;

export type SettingsSection = (typeof SETTINGS_SECTIONS)[number];
export type SettingsSectionId = SettingsSection["id"];
export type SettingsGroupId = SettingsSection["group"];

export const SETTINGS_GROUPS: readonly { id: SettingsGroupId; label: string }[] = [
  { id: "account", label: "Account" },
  { id: "server", label: "Server" },
];

export const visibleSettingsSections = (canManageServer: boolean) =>
  SETTINGS_SECTIONS.filter(
    (section) => !("hidden" in section) && (section.group === "account" || canManageServer),
  );

const findSection = (id: string) => SETTINGS_SECTIONS.find((section) => section.id === id);

export function resolveSettingsPath(path: string | null, canManageServer: boolean) {
  const [sectionId = "", item = ""] = (path || "").split("/");
  const section = findSection(sectionId);
  if (!section || (section.group === "server" && !canManageServer)) {
    const fallback = canManageServer ? findSection("general") : undefined;
    return { section: fallback ?? SETTINGS_SECTIONS[0], item: null };
  }
  return { section, item: item || null };
}

type SettingsSearchMetadata = {
  sections?: string[];
  services?: Record<string, string>;
  fields?: Record<string, string>;
};

const SETTINGS_SEARCH_METADATA: Partial<Record<SettingsSectionId, SettingsSearchMetadata>> = {
  profile: {
    sections: ["Password", "Sign-in methods", "Plex account", "Lidarr defaults"],
    services: {
      Google: "sign in connect account",
      SSO: "single sign-on OIDC identity provider connect",
      Plex: "link account playback identity",
    },
    fields: {
      "Current password": "change password authentication",
      "New password": "change set password authentication local",
      "Root folder": "Lidarr default library path artist adds",
      "Quality profile": "Lidarr default profile artist adds",
    },
  },
  listening: {
    sections: ["History", "Scrobbling", "Discovery tastes"],
    services: {
      "Last.fm": "scrobbling listening history username recommendations",
      ListenBrainz: "scrobbling user token listening history",
      Koito: "scrobbling API key URL listening history",
    },
    fields: {
      Source: "listening history provider recommendations local",
      "Reset discovery tastes": "more like this less like this blocklist",
    },
  },
  appearance: {
    sections: ["Theme"],
    fields: {
      Theme: "color scheme dark light presets custom colors import",
      "Immersive mode": "artwork colors tint",
      "Environment art": "sidebar backdrop",
    },
  },
  "shared-links": {
    sections: ["Shared links"],
    fields: { "Shared links": "share playlist artist album revoke" },
  },
  general: {
    sections: ["Display", "Subsonic", "API access", "Backup"],
    fields: {
      "Date and time format": "display all users",
      "Favorite flow tracks": "Subsonic keep library",
      "API key": "X-Api-Key api_key authentication copy rotate",
      "Back up": "backup export download config database",
      Restore: "restore import upload backup migrate move server",
    },
  },
  users: {
    sections: ["Users", "Sign-in", "Local network auto-login"],
    services: {
      Google: "sign in authentication OAuth login client ID secret redirect",
      Plex: "sign in with Plex login",
    },
    fields: {
      "Auto-login": "local network bypass authentication login",
      Username: "create edit user account",
      Permissions: "roles manage users access",
      "SSO-only": "sign in mode hide local login form SSO",
      Status: "active suspended disabled user account",
      "Claim by SSO sign-in": "legacy account adoption migration link identity upgrade",
    },
  },
  library: {
    sections: ["Downloads folder", "Read-only folders", "Import a folder", "Clean up Library"],
    fields: {
      "Downloads folder": "path media library root",
      "Read-only folders": "existing music never changes",
      "Import folder":
        "ingest existing music library folder move copy hardlink Lidarr root monitor",
      Mode: "move copy hardlink",
      "Fill in missing tags": "tagging retag MusicBrainz IDs genre year track numbers metadata",
      "Clean up Library": "rename organize tags files naming folders media management",
    },
  },
  monitoring: {
    sections: ["Default rules", "Missing tracks", "Removed from monitoring"],
    fields: {
      "Default rules":
        "monitor artists back catalogue discography new releases latest since year albums EPs singles live compilations soundtracks remixes demos DJ mixes mixtapes edition deluxe expanded top tracks popular",
      "Search again for missing tracks":
        "retry failed missing album tracks automatic schedule on off",
      "Search interval": "days between missing track searches",
      "Removed from monitoring": "excluded deleted albums tracks allow again exclusions",
    },
  },
  downloads: {
    sections: ["Download clients", "Quality", "Review queue", "Remote path mappings"],
    services: {
      slskd: "Soulseek download client",
      "yt-dlp": "YouTube web download client staging",
      NZBGet: "Usenet download client",
      SABnzbd: "Usenet download client",
      deemix: "Deezer download client bitrate",
      Prowlarr: "indexer manager search usenet categories",
    },
    fields: {
      "Quality profile":
        "FLAC MP3 M4A 128 192 256 320 bitrate hi-res allowed formats rank preference cutoff",
      "Automatic upgrades": "upgrade searches Flow Static tracks interval",
      "Maximum wait": "review queue held tracks deny automatically timeout",
      "Remote path mappings": "download client path mapping remote local",
    },
  },
  playback: {
    sections: ["Playback servers"],
    services: {
      Navidrome: "Subsonic music server playlists",
      Plex: "Plexamp music server library",
      Jellyfin: "Jellyfin music server playlists",
    },
    fields: {
      "Server URL": "playback server address host connection",
      Sync: "Navidrome scan playlists Plex refresh",
    },
  },
  discovery: {
    sections: ["Recommendations", "Status", "Sources"],
    services: {
      "Last.fm": "recommendations API key shared secret scrobbling",
      Ticketmaster: "local shows concerts events consumer key radius",
      News: "RSS articles feeds custom",
    },
    fields: {
      Refresh: "auto refresh frequency daily weekly monthly recommendations",
      Mode: "discovery mode safer balanced deeper recommendations",
      "Artists per refresh": "recommended artists number",
      "Refresh now": "update recommendations discovery",
      "Clear artwork cache": "stored artwork links native library image files reset",
      "Local shows": "Ticketmaster recommended trending artists",
      "Feed groups":
        "major publications magazines indie alternative discovery hip hop rap pop mainstream electronic dance metal hard rock country americana jazz classical regional concerts festivals live music",
    },
  },
  notifications: {
    sections: ["Inbox", "Push", "Webhooks", "Webhook events"],
    services: {
      Gotify: "push notifications mobile alerts token",
      Webhooks: "notifications HTTP callbacks headers body",
    },
    fields: {
      Inbox: "on off upcoming releases shows artist news recommended discoveries",
      "Discover updated": "notification event webhook Gotify",
      "Flow finished": "notification event webhook Gotify",
      "Request made": "notification event webhook Gotify",
      "Request available": "notification event webhook Gotify",
    },
  },
  lidarr: {
    sections: ["Connection", "Defaults", "Community guide"],
    fields: {
      Enabled: "enable disable turn off reconnect unreachable",
      "Server URL": "address host connection API key test",
      "External URL": "browser view on lidarr public address",
      "Root folder": "lidarr default path",
      "Quality profile": "lidarr default profile",
      "Metadata profile": "lidarr default metadata",
      Tag: "lidarr tag",
      Monitor: "default monitoring option albums existing future missing latest first",
      "Search on add": "missing albums artists",
      "Community guide": "Davo recommended settings custom formats naming scheme apply",
    },
  },
  status: {
    sections: ["Storage", "Tasks", "About"],
    fields: {
      "Storage health": "disk space free total paths run checks transfers playback",
      Tasks: "scheduled workers queue jobs running failed retry clear stale",
      Version: "runtime application build uptime environment platform container",
      "Database path": "sqlite data directory app data",
    },
  },
  metadata: {
    sections: ["Metadata server"],
    services: { BrainzMash: "MusicBrainz metadata provider" },
    fields: { "Base URL": "metadata server address endpoint" },
  },
};

const normalizeSearchText = (value: string) =>
  value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .trim();

const SETTINGS_SEARCH_ITEMS = SETTINGS_SECTIONS.flatMap((section) => {
  const metadata: SettingsSearchMetadata = SETTINGS_SEARCH_METADATA[section.id] || {};
  const item = (label: string, keywords = "") => ({
    key: `${section.id}:${label}`,
    label,
    section,
    searchText: normalizeSearchText(`${section.label} ${label} ${keywords}`),
  });
  return [
    item(section.label),
    ...(metadata.sections || []).map((label) => item(label)),
    ...Object.entries(metadata.services || {}).map(([label, keywords]) => item(label, keywords)),
    ...Object.entries(metadata.fields || {}).map(([label, keywords]) => item(label, keywords)),
  ];
});

export function searchSettings(query: string, canManageServer: boolean) {
  const terms = normalizeSearchText(query).split(" ").filter(Boolean);
  if (!terms.length) return [];
  return SETTINGS_SEARCH_ITEMS.filter(
    (item) =>
      (item.section.group === "account" || canManageServer) &&
      terms.every((term) => item.searchText.includes(term)),
  );
}
