import assert from "node:assert/strict";
import { vi, type TestContext } from "vite-plus/test";
import axios from "../../lib/axiosFetch.ts";

const METADATA_HOST = "brainzmash.example.test";

type TrackFixture = {
  title: string;
  recordingId?: string;
  oldRecordingIds?: string[];
  position?: number;
  disc?: number;
  durationMs?: number;
  artistId?: string;
};

type GroupFixture = {
  id: string;
  title: string;
  artist: string;
  artistId?: string;
  trackArtists?: { id: string; name: string }[];
  secondaryTypes?: string[];
  releases: {
    id: string;
    title?: string;
    status?: string;
    trackCount?: number;
    tracks: (string | TrackFixture)[];
  }[];
};

// A release group as BrainzMash serves it. A track is a title, or a title
// with its place, length, recording, and credit; a track credited to someone
// else names one of `trackArtists`.
export function brainzmashGroup({
  id,
  title,
  artist,
  artistId = `${id}-artist`,
  trackArtists = [],
  secondaryTypes = [],
  releases,
}: GroupFixture) {
  return {
    id,
    title,
    artistid: artistId,
    artists: [{ id: artistId, name: artist }, ...trackArtists].map((entry) => ({
      id: entry.id,
      artistname: entry.name,
    })),
    secondarytypes: secondaryTypes,
    releases: releases.map((release) => ({
      id: release.id,
      title: release.title || title,
      status: release.status || "Official",
      ...(release.trackCount ? { track_count: release.trackCount } : {}),
      tracks: release.tracks.map((entry, index) => {
        const track = typeof entry === "string" ? { title: entry } : entry;
        return {
          id: `${release.id}-track-${index + 1}`,
          trackname: track.title,
          recordingid: track.recordingId || `${release.id}-recording-${index + 1}`,
          oldrecordingids: track.oldRecordingIds || [],
          trackposition: track.position ?? index + 1,
          mediumnumber: track.disc ?? 1,
          durationms: track.durationMs ?? 200000,
          artistid: track.artistId || artistId,
        };
      }),
    })),
  };
}

// Serves the given groups from the metadata provider and nothing else, so
// a release loads by its ID through the real metadata path. An unavailable
// path answers 503, and a missing one 404, as a provider that does not know it.
// A searchable provider also finds a group by its exact title.
export async function serveGroups<Group extends { id: string; title?: string; releases?: unknown }>(
  t: TestContext,
  groups: Group[],
  {
    unavailable = () => false,
    missing = () => false,
    searchable = false,
  }: {
    unavailable?: (path: string) => boolean;
    missing?: (path: string) => boolean;
    searchable?: boolean;
  } = {},
) {
  const { dbOps } = await import("../../backend/db/helpers/index.ts");
  const { clearApiCaches } = await import("../../backend/services/apiClients/clearCache.ts");
  const settings = dbOps.getSettings();
  dbOps.updateSettings({
    ...settings,
    integrations: {
      ...settings.integrations,
      metadata: {
        ...settings.integrations?.metadata,
        baseUrl: `https://${METADATA_HOST}`,
        enableNarrowFallbacks: false,
      },
    },
  });
  clearApiCaches();
  t.onTestFinished(() => clearApiCaches());
  const byPath = new Map(groups.map((group) => [`/album/${group.id}`, group]));
  const original = axios.get;
  return vi.spyOn(axios, "get").mockImplementation(async (url, ...rest) => {
    const parsed = new URL(url);
    if (parsed.hostname !== METADATA_HOST) return original.call(axios, url, ...rest);
    const down = unavailable(parsed.pathname);
    const query = String(
      rest[0]?.params?.query ?? parsed.searchParams.get("query") ?? "",
    ).toLowerCase();
    const found =
      searchable && parsed.pathname === "/search/album"
        ? groups
            .filter((group) => String(group.title || "").toLowerCase() === query)
            .map(({ releases, ...group }) => group)
        : null;
    const data = down || missing(parsed.pathname) ? null : found || byPath.get(parsed.pathname);
    if (data)
      return {
        status: 200,
        statusText: "OK",
        headers: {},
        data: structuredClone(data),
      };
    throw Object.assign(new Error(down ? "metadata unavailable" : "not found"), {
      response: { status: down ? 503 : 404 },
    });
  });
}

// The manifest the resolver builds for a group's first release, for callers
// that take one directly.
export async function releaseManifest(spec: GroupFixture) {
  const { toNormalizedAlbum } =
    await import("../../backend/services/providers/brainzmashMappers.ts");
  const { toReleaseManifest } = await import("../../backend/services/releaseManifest.ts");
  const group = toNormalizedAlbum(brainzmashGroup(spec));
  const release = group.releases[0];
  assert.ok(release);
  return toReleaseManifest(group, release);
}
