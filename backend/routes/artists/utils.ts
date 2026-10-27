import * as v from "valibot";

export const invalidMbid = (mbid: string) => ({
  error: "Invalid MBID format",
  message: `"${mbid}" is not a valid MusicBrainz ID. MBIDs must be UUIDs.`,
});

export const queryText = v.optional(
  v.pipe(
    v.union([v.string(), v.array(v.string())]),
    v.transform((value) => (typeof value === "string" ? value.trim() : "")),
  ),
  "",
);

export const releaseTypesQuery = v.optional(
  v.pipe(
    v.string(),
    v.transform((types) =>
      types.trim()
        ? types
            .split(",")
            .map((value) => value.trim())
            .filter(Boolean)
        : null,
    ),
  ),
);

export const appearsOnLimitQuery = v.optional(
  v.pipe(
    v.string(),
    v.transform((limit) => {
      const parsed = Number.parseInt(limit, 10);
      return Number.isFinite(parsed) && parsed > 0 ? parsed : null;
    }),
  ),
);

export const buildArtistRequestKey = ({
  mbid,
  mode = "full",
  selectedReleaseTypes = null,
  appearsOnLimit = null,
}: {
  mbid: string;
  mode?: string;
  selectedReleaseTypes?: string[] | null;
  appearsOnLimit?: number | null;
}) => {
  const releaseTypesKey = Array.isArray(selectedReleaseTypes)
    ? [...selectedReleaseTypes].filter(Boolean).sort().join(",")
    : "";
  const limitValue = Number.parseInt(String(appearsOnLimit), 10);
  const limitKey = Number.isFinite(limitValue) && limitValue > 0 ? String(limitValue) : "";
  return [String(mbid || "").trim(), mode, releaseTypesKey, limitKey].join(":");
};
