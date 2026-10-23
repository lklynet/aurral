import type { LidarrClient } from "../../backend/services/lidarrClient.ts";
import { test } from "vite-plus/test";
import assert from "node:assert/strict";

import { applyLidarrCommunityGuide } from "../../backend/services/lidarrCommunityGuide.ts";

function createClient({
  failCustomFormats = false,
  extraFormatNames = [] as string[],
}: { failCustomFormats?: boolean; extraFormatNames?: string[] } = {}) {
  const unrelatedFormat = {
    id: 99,
    name: "Existing Unrelated",
    specifications: [],
  };
  const createdFormats: Awaited<ReturnType<LidarrClient["getCustomFormats"]>> = [];
  const extraFormats = extraFormatNames.map((name, index) => ({
    id: 100 + index,
    name,
    specifications: [],
  }));
  const state = {
    customFormatPayloads: [] as Parameters<
      Parameters<typeof applyLidarrCommunityGuide>[0]["createCustomFormat"]
    >[0][],
    qualityProfilePayload: null as {
      name: string;
      formatItems: { name: string; score: number }[];
    } | null,
    qualityProfileCalls: 0,
  };

  const client = {
    getQualityDefinitions: async () => [
      { id: 1, title: "MP3-320", quality: { id: 1, name: "MP3-320" } },
      { id: 2, title: "FLAC", quality: { id: 2, name: "FLAC" } },
    ],
    updateQualityDefinition: async (_id, payload) => payload,
    getCustomFormats: async () => [unrelatedFormat, ...extraFormats, ...createdFormats],
    createCustomFormat: async (payload) => {
      state.customFormatPayloads.push(payload);
      if (failCustomFormats) {
        throw new Error("custom format rejected");
      }
      const created = { ...payload, id: createdFormats.length + 1 };
      createdFormats.push(created);
      return created;
    },
    getReleaseProfiles: async () => [],
    createReleaseProfile: async (payload) => ({ id: 1, ...(payload as { name: string }) }),
    updateReleaseProfile: async (_id, payload) => ({ id: 1, ...(payload as { name: string }) }),
    getMetadataProfiles: async () => [
      {
        id: 1,
        name: "Standard",
        primaryAlbumTypes: ["Album"],
        secondaryAlbumTypes: ["Studio"],
      },
    ],
    createMetadataProfile: async (payload) => ({ id: 1, ...(payload as { name: string }) }),
    updateMetadataProfile: async (_id, payload) => ({ id: 1, ...(payload as { name: string }) }),
    getNamingConfig: async () => ({
      id: 1,
      renameTracks: false,
      standardTrackFormat: "",
      multiDiscTrackFormat: "",
      artistFolderFormat: "",
      albumFolderFormat: "",
    }),
    updateNamingConfig: async (payload) => payload,
    getQualityProfiles: async () => [
      {
        id: 1,
        name: "Standard",
        items: [
          { quality: { id: 1, name: "MP3-320" }, allowed: true, items: [] },
          { quality: { id: 2, name: "FLAC" }, allowed: false, items: [] },
        ],
      },
    ],
    createQualityProfile: async (payload) => {
      assert.ok(payload && typeof payload === "object" && "name" in payload);
      const profile = payload as { name: string; formatItems: { name: string; score: number }[] };
      state.qualityProfileCalls += 1;
      state.qualityProfilePayload = profile;
      return { id: 2, name: profile.name };
    },
    updateQualityProfile: async (_id, payload) => {
      assert.ok(payload && typeof payload === "object" && "name" in payload);
      const profile = payload as { name: string; formatItems: { name: string; score: number }[] };
      state.qualityProfileCalls += 1;
      state.qualityProfilePayload = profile;
      return { id: 1, name: profile.name };
    },
  } satisfies Parameters<typeof applyLidarrCommunityGuide>[0];
  return { ...client, state };
}

test("applies the guide with Lidarr custom-format and profile contracts", async () => {
  const client = createClient();
  const result = await applyLidarrCommunityGuide(client);

  assert.deepEqual([...result.errors], []);
  assert.equal(client.state.customFormatPayloads.length, 5);
  assert.ok(
    client.state.customFormatPayloads.every((format) =>
      format.specifications.every(
        (specification) =>
          specification != null &&
          typeof specification === "object" &&
          "fields" in specification &&
          Array.isArray(specification.fields),
      ),
    ),
  );
  assert.ok(client.state.qualityProfilePayload != null);
  assert.deepEqual(
    client.state.qualityProfilePayload.formatItems.map(({ name, score }) => ({ name, score })),
    [
      { name: "Existing Unrelated", score: 0 },
      { name: "Preferred Groups", score: 10 },
      { name: "CD", score: 2 },
      { name: "WEB", score: 1 },
      { name: "Lossless", score: 1 },
      { name: "Vinyl", score: -5 },
    ],
  );
});

test("does not submit a quality profile when a guide format fails", async () => {
  const client = createClient({ failCustomFormats: true });

  await assert.rejects(() => applyLidarrCommunityGuide(client), /Failed to apply custom formats/);
  assert.equal(client.state.qualityProfileCalls, 0);
});

test("scores a custom format named like an object property as unscored", async () => {
  const client = createClient({ extraFormatNames: ["constructor", "toString"] });
  await applyLidarrCommunityGuide(client);

  assert.ok(client.state.qualityProfilePayload != null);
  assert.deepEqual(
    client.state.qualityProfilePayload.formatItems
      .filter(({ name }) => name === "constructor" || name === "toString")
      .map(({ name, score }) => ({ name, score })),
    [
      { name: "constructor", score: 0 },
      { name: "toString", score: 0 },
    ],
  );
});
