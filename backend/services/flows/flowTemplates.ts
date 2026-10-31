import {
  DISCOVER_PLAYLIST_PRESETS,
  LISTENING_HISTORY_PRESET_ID,
} from "../../config/discoverPlaylistPresets.ts";
import { getUserDiscovery } from "../discovery/userDiscovery.ts";
import type { RequestUser } from "../../middleware/requestUser.ts";

export const getRecentListeningArtists = (userId: number) => {
  const { body } = getUserDiscovery(userId, 0, 0);
  const seen = new Set<string>();
  const artists: string[] = [];
  for (const entry of body.basedOn || []) {
    const source = String(entry?.source || "")
      .trim()
      .toLowerCase();
    const name = String(entry?.name || entry?.artistName || "").trim();
    if (!source || source === "library" || !name || seen.has(name.toLowerCase())) continue;
    seen.add(name.toLowerCase());
    artists.push(name);
    if (artists.length >= 3) break;
  }
  return artists;
};

export function listFlowTemplates(user: RequestUser) {
  const hasHistory = getRecentListeningArtists(user.id).length > 0;
  return DISCOVER_PLAYLIST_PRESETS.map((template) => ({
    id: template.id,
    name: template.name,
    description: template.description,
    available: template.id !== LISTENING_HISTORY_PRESET_ID || hasHistory,
  }));
}

export function buildFlowFromTemplate(user: RequestUser, templateId: unknown) {
  const template = DISCOVER_PLAYLIST_PRESETS.find(
    (entry) => entry.id === String(templateId || "").trim(),
  );
  if (!template) {
    throw Object.assign(new Error("Unknown flow template"), { statusCode: 400 });
  }
  const recentListening = template.id === LISTENING_HISTORY_PRESET_ID;
  if (recentListening && getRecentListeningArtists(user.id).length === 0) {
    throw Object.assign(
      new Error(
        "Listening History needs listening history. Connect a history provider or play some music first.",
      ),
      { statusCode: 400 },
    );
  }
  return {
    name: template.name,
    description: template.description,
    discoverPresetId: template.id,
    mix: template.mix,
    size: template.size,
    deepDive: false,
    recentListening,
    tags: [],
    relatedArtists: [],
    scheduleDays: [5],
    scheduleTime: "00:00",
  };
}
