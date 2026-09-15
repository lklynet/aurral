import test from "node:test";
import assert from "node:assert/strict";

import { applyLidarrCommunityGuide } from "../../backend/services/lidarrCommunityGuide.js";

function createClient({ failCustomFormats = false } = {}) {
  const unrelatedFormat = {
    id: 99,
    name: "Existing Unrelated",
    specifications: [],
  };
  const createdFormats = [];
  const state = {
    customFormatPayloads: [],
    qualityProfilePayload: null,
    qualityProfileCalls: 0,
  };

  return {
    state,
    getQualityDefinitions: async () => [
      { id: 1, title: "MP3-320", quality: { id: 1, name: "MP3-320" } },
      { id: 2, title: "FLAC", quality: { id: 2, name: "FLAC" } },
    ],
    updateQualityDefinition: async (_id, payload) => payload,
    getCustomFormats: async () => [unrelatedFormat, ...createdFormats],
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
    createReleaseProfile: async (payload) => ({ id: 1, ...payload }),
    updateReleaseProfile: async (_id, payload) => ({ id: 1, ...payload }),
    getMetadataProfiles: async () => [
      {
        id: 1,
        name: "Standard",
        primaryAlbumTypes: ["Album"],
        secondaryAlbumTypes: ["Studio"],
      },
    ],
    createMetadataProfile: async (payload) => ({ id: 1, ...payload }),
    updateMetadataProfile: async (_id, payload) => ({ id: 1, ...payload }),
    getNamingConfig: async () => ({ renameTracks: false }),
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
      state.qualityProfileCalls += 1;
      state.qualityProfilePayload = payload;
      return { id: 2, name: payload.name };
    },
    updateQualityProfile: async (_id, payload) => {
      state.qualityProfileCalls += 1;
      state.qualityProfilePayload = payload;
      return { id: 1, name: payload.name };
    },
  };
}

test("applies the guide with Lidarr custom-format and profile contracts", async () => {
  const client = createClient();
  const result = await applyLidarrCommunityGuide(client);

  assert.deepEqual(result.errors, []);
  assert.equal(client.state.customFormatPayloads.length, 5);
  assert.ok(
    client.state.customFormatPayloads.every((format) =>
      format.specifications.every((specification) =>
        Array.isArray(specification.fields),
      ),
    ),
  );
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

  await assert.rejects(
    () => applyLidarrCommunityGuide(client),
    /Failed to apply custom formats/,
  );
  assert.equal(client.state.qualityProfileCalls, 0);
});
