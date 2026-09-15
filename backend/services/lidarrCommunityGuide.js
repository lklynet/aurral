const normalizeTypeName = (value) =>
  String(value || "")
    .toLowerCase()
    .replace(/[^a-z0-9]/g, "");

const getTypeName = (item) => {
  if (!item) return "";
  if (typeof item === "string") return item;
  if (typeof item.name === "string") return item.name;
  if (typeof item.value === "string") return item.value;
  if (typeof item.albumType?.name === "string")
    return item.albumType.name;
  return "";
};

export async function applyLidarrCommunityGuide(lidarrClient) {
  const results = {
    qualityDefinitions: [],
    customFormats: [],
    releaseProfile: null,
    metadataProfile: null,
    namingConfig: null,
    qualityProfile: null,
    errors: [],
  };

  const qualityDefs = await lidarrClient.getQualityDefinitions();

  const flacDef = qualityDefs.find((q) => q.quality?.name === "FLAC" || q.title === "FLAC");
  const flac24Def = qualityDefs.find(
    (q) => q.quality?.name === "FLAC 24bit" || q.title === "FLAC 24bit",
  );

  if (flacDef) {
    const _updated = await lidarrClient.updateQualityDefinition(flacDef.id, {
      ...flacDef,
      minSize: 0,
      maxSize: 1400,
      preferredSize: 895,
    });
    results.qualityDefinitions.push({
      name: "FLAC",
      updated: { min: 0, max: 1400, preferred: 895 },
    });
  }

  if (flac24Def) {
    const _updated = await lidarrClient.updateQualityDefinition(flac24Def.id, {
      ...flac24Def,
      minSize: 0,
      maxSize: 1495,
      preferredSize: 895,
    });
    results.qualityDefinitions.push({
      name: "FLAC 24bit",
      updated: { min: 0, max: 1495, preferred: 895 },
    });
  }

  const customFormats = [
      {
        name: "Preferred Groups",
        includeCustomFormatWhenRenaming: false,
        specifications: [
          {
            name: "DeVOiD",
            implementation: "ReleaseGroupSpecification",
            negate: false,
            required: false,
            fields: [{ name: "value", value: "\\bDeVOiD\\b" }],
          },
          {
            name: "PERFECT",
            implementation: "ReleaseGroupSpecification",
            negate: false,
            required: false,
            fields: [{ name: "value", value: "\\bPERFECT\\b" }],
          },
          {
            name: "ENRiCH",
            implementation: "ReleaseGroupSpecification",
            negate: false,
            required: false,
            fields: [{ name: "value", value: "\\bENRiCH\\b" }],
          },
        ],
      },
      {
        name: "CD",
        includeCustomFormatWhenRenaming: false,
        specifications: [
          {
            name: "CD",
            implementation: "ReleaseTitleSpecification",
            negate: false,
            required: false,
            fields: [{ name: "value", value: "\\bCD\\b" }],
          },
        ],
      },
      {
        name: "WEB",
        includeCustomFormatWhenRenaming: false,
        specifications: [
          {
            name: "WEB",
            implementation: "ReleaseTitleSpecification",
            negate: false,
            required: false,
            fields: [{ name: "value", value: "\\bWEB\\b" }],
          },
        ],
      },
      {
        name: "Lossless",
        includeCustomFormatWhenRenaming: false,
        specifications: [
          {
            name: "Flac",
            implementation: "ReleaseTitleSpecification",
            negate: false,
            required: false,
            fields: [{ name: "value", value: "\\blossless\\b" }],
          },
        ],
      },
      {
        name: "Vinyl",
        includeCustomFormatWhenRenaming: false,
        specifications: [
          {
            name: "Vinyl",
            implementation: "ReleaseTitleSpecification",
            negate: false,
            required: false,
            fields: [{ name: "value", value: "\\bVinyl\\b" }],
          },
        ],
      },
    ];

    const existingFormats = await lidarrClient.getCustomFormats();
    for (const format of customFormats) {
      const existing = existingFormats.find((f) => f.name === format.name);
      if (!existing) {
        try {
          const created = await lidarrClient.createCustomFormat(format);
          results.customFormats.push(created);
        } catch (err) {
          results.errors.push(
            `Failed to create custom format "${format.name}": ${err.message}`,
          );
        }
      } else {
        results.customFormats.push(existing);
      }
    }

    if (results.errors.length > 0) {
      throw new Error(`Failed to apply custom formats: ${results.errors.join(" ")}`);
    }

    const releaseProfilePayload = {
      name: "Aurral - Single Track Rip Filter",
      enabled: true,
      required: [],
      ignored: ["CUE", "FLAC/CUE"],
      preferred: [],
      tags: [],
    };

    const existingReleaseProfiles = await lidarrClient.getReleaseProfiles();
    const normalizeReleaseName = (value) =>
      String(value || "")
        .trim()
        .toLowerCase();
    const hasIgnoredMatch = (profile, value) =>
      Array.isArray(profile?.ignored) &&
      profile.ignored
        .map((item) => String(item || "").toLowerCase())
        .includes(String(value || "").toLowerCase());
    const existingReleaseProfile = existingReleaseProfiles.find((profile) => {
      if (!profile) return false;
      if (
        normalizeReleaseName(profile.name) ===
        normalizeReleaseName(releaseProfilePayload.name)
      ) {
        return true;
      }
      return (
        hasIgnoredMatch(profile, "CUE") &&
        hasIgnoredMatch(profile, "FLAC/CUE")
      );
    });

    if (existingReleaseProfile) {
      const updatedReleaseProfile = await lidarrClient.updateReleaseProfile(
        existingReleaseProfile.id,
        {
          ...releaseProfilePayload,
          id: existingReleaseProfile.id,
        },
      );
      results.releaseProfile = {
        id: updatedReleaseProfile.id,
        name: updatedReleaseProfile.name,
        updated: true,
      };
    } else {
      const createdReleaseProfile = await lidarrClient.createReleaseProfile(releaseProfilePayload);
      results.releaseProfile = {
        id: createdReleaseProfile.id,
        name: createdReleaseProfile.name,
      };
    }

  const metadataProfiles = await lidarrClient.getMetadataProfiles();
  const aurralMetadataProfile = metadataProfiles.find(
    (profile) => profile.name === "Aurral - Standard",
  );
  const standardProfile = metadataProfiles.find((profile) => profile.name === "Standard");
  const baseMetadataProfile = aurralMetadataProfile || standardProfile || metadataProfiles[0];

  if (!baseMetadataProfile) {
    throw new Error("No metadata profiles available in Lidarr");
  }

  const desiredPrimaryTypes = ["Album", "EP", "Single"];
  const desiredSecondaryTypes = ["Studio", "Soundtrack", "Remix", "DJ-mix", "Compilation"];

  const applyTypeSelection = (available, desired) => {
    if (!Array.isArray(available) || available.length === 0) {
      return desired.map((name) => ({ name, allowed: true }));
    }
    const desiredSet = new Set(desired.map((name) => normalizeTypeName(name)));
    return available.map((item) => {
      const itemName = getTypeName(item);
      const allowed = desiredSet.has(normalizeTypeName(itemName));
      if (typeof item === "string") {
        return { name: item, allowed };
      }
      return { ...item, allowed };
    });
  };

  const metadataProfilePayload = {
    ...baseMetadataProfile,
    name: "Aurral - Standard",
    primaryAlbumTypes: applyTypeSelection(
      baseMetadataProfile.primaryAlbumTypes,
      desiredPrimaryTypes,
    ),
    secondaryAlbumTypes: applyTypeSelection(
      baseMetadataProfile.secondaryAlbumTypes,
      desiredSecondaryTypes,
    ),
  };

  if (aurralMetadataProfile) {
    const updatedMetadataProfile = await lidarrClient.updateMetadataProfile(
      aurralMetadataProfile.id,
      metadataProfilePayload,
    );
    results.metadataProfile = {
      id: updatedMetadataProfile.id,
      name: updatedMetadataProfile.name,
      updated: true,
    };
  } else {
    const { id: _id, ...createPayload } = metadataProfilePayload;
    const createdMetadataProfile = await lidarrClient.createMetadataProfile(createPayload);
    results.metadataProfile = {
      id: createdMetadataProfile.id,
      name: createdMetadataProfile.name,
    };
  }

  const namingConfig = await lidarrClient.getNamingConfig();
  const updatedNamingConfig = {
    ...namingConfig,
    renameTracks: true,
    replaceIllegalCharacters: true,
    standardTrackFormat:
      "{Album Title} {(Album Disambiguation)}/{Artist Name}_{Album Title}_{track:00}_{Track Title}",
    multiDiscTrackFormat:
      "{Album Title} {(Album Disambiguation)}/{Artist Name}_{Album Title}_{medium:00}-{track:00}_{Track Title}",
    artistFolderFormat: "{Artist Name}",
  };

  await lidarrClient.updateNamingConfig(updatedNamingConfig);
  results.namingConfig = updatedNamingConfig;

  const existingProfiles = await lidarrClient.getQualityProfiles();
  let aurralProfile = existingProfiles.find((profile) => profile.name === "Aurral - HQ");
  const baseProfile = aurralProfile || existingProfiles[0];

  if (!baseProfile) {
    throw new Error("No quality profiles available in Lidarr");
  }

  const selectedQualityNames = ["MP3-320", "FLAC"];
  const baseItems = JSON.parse(JSON.stringify(baseProfile.items || []));
  const qualityItemMap = new Map();

  const collectQualityItems = (items) => {
    for (const item of items) {
      if (item?.quality?.name) {
        qualityItemMap.set(item.quality.name, item);
      }
      if (Array.isArray(item.items)) {
        collectQualityItems(item.items);
      }
    }
  };

  collectQualityItems(baseItems);

  const qualityDefItems = (qualityDefs || []).map((definition) => ({
    id: definition.id,
    name: definition.title || definition.quality?.name,
    quality: {
      id: definition.quality?.id,
      name: definition.quality?.name || definition.title,
    },
    allowed: false,
    items: [],
  }));

  for (const defItem of qualityDefItems) {
    if (defItem.quality?.name && !qualityItemMap.has(defItem.quality.name)) {
      qualityItemMap.set(defItem.quality.name, defItem);
    }
  }

  const normalizeQualityItem = (item, allowed) => ({
    ...item,
    allowed,
    items: [],
  });

  const selectedItems = selectedQualityNames
    .map((name) => qualityItemMap.get(name))
    .filter(Boolean)
    .map((item) => normalizeQualityItem(item, true));

  const otherItems = Array.from(qualityItemMap.entries())
    .filter(([name]) => !selectedQualityNames.includes(name))
    .map(([, item]) => normalizeQualityItem(item, false));

  const profileItems = [...otherItems, ...selectedItems];
  const flacQualityId = qualityItemMap.get("FLAC")?.quality?.id;

  const allCustomFormats = await lidarrClient.getCustomFormats();
  const formatItems = allCustomFormats.map((cf) => {
    const scores = {
      "Preferred Groups": 10,
      CD: 2,
      WEB: 1,
      Lossless: 1,
      Vinyl: -5,
    };
    return {
      format: cf.id,
      name: cf.name,
      score: scores[cf.name] || 0,
    };
  });

  if (formatItems.length === 0) {
    results.errors.push("No custom formats were created; quality profile minFormatScore set to 0.");
  }

  const profileData = {
    ...baseProfile,
    name: "Aurral - HQ",
    upgradeAllowed: true,
    cutoff: flacQualityId ?? baseProfile.cutoff,
    items: profileItems,
    minFormatScore: formatItems.length > 0 ? 1 : 0,
    cutoffFormatScore: 0,
    formatItems,
  };

  if (!aurralProfile) {
    const { id: _id, ...createPayload } = profileData;
    aurralProfile = await lidarrClient.createQualityProfile(createPayload);
    results.qualityProfile = {
      id: aurralProfile.id,
      name: aurralProfile.name,
    };
  } else {
    const updatedProfile = await lidarrClient.updateQualityProfile(aurralProfile.id, profileData);
    results.qualityProfile = {
      id: updatedProfile.id,
      name: updatedProfile.name,
      updated: true,
    };
  }

  return results;
}
