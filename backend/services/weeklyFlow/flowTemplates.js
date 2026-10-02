import {
  DISCOVER_PLAYLIST_PRESETS,
  RELEASE_RADAR_PRESET,
} from "../../config/discoverPlaylistPresets.js";
import { getUserDiscovery } from "../discovery/userDiscovery.js";

const LISTENING_HISTORY_TEMPLATE_ID = "focus-listening-history";
const TEMPLATES = [...DISCOVER_PLAYLIST_PRESETS, RELEASE_RADAR_PRESET];

const getHistoryArtists = async (userId) => {
  const { body } = await getUserDiscovery(userId, 0, 0);
  const seen = new Set();
  const artists = [];
  for (const entry of body.basedOn || []) {
    const source = String(entry?.source || "").trim().toLowerCase();
    const name = String(entry?.name || entry?.artistName || "").trim();
    if (!source || source === "library" || !name || seen.has(name.toLowerCase())) continue;
    seen.add(name.toLowerCase());
    artists.push(name);
    if (artists.length >= 3) break;
  }
  return artists;
};

export async function listFlowTemplates(user) {
  const historyArtists = await getHistoryArtists(user.id);
  return TEMPLATES.map((template) => ({
    id: template.id,
    name: template.name,
    description: template.description,
    available: template.id !== LISTENING_HISTORY_TEMPLATE_ID || historyArtists.length > 0,
  }));
}

export async function buildFlowFromTemplate(user, templateId) {
  const template = TEMPLATES.find((entry) => entry.id === String(templateId || "").trim());
  if (!template) {
    throw Object.assign(new Error("Unknown flow template"), { statusCode: 400 });
  }
  const relatedArtists =
    template.id === LISTENING_HISTORY_TEMPLATE_ID ? await getHistoryArtists(user.id) : [];
  if (template.id === LISTENING_HISTORY_TEMPLATE_ID && relatedArtists.length === 0) {
    throw Object.assign(
      new Error("Listening History needs listening history. Connect a history provider or play some music first."),
      { statusCode: 400 },
    );
  }
  return {
    name: template.name,
    description:
      relatedArtists.length > 0
        ? `Tracks related to ${relatedArtists.join(", ")}`
        : template.description,
    discoverPresetId: template.id,
    mix: template.mix,
    size: template.size,
    deepDive: template.deepDive === true,
    tags: [],
    relatedArtists,
    scheduleDays: [5],
    scheduleTime: "00:00",
  };
}
