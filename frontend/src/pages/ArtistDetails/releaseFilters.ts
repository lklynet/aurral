import type { ReleaseGroup } from "./utils.ts";

const hasReleaseGroupType = (releaseGroup: ReleaseGroup | null | undefined, type: string) =>
  releaseGroup?.["primary-type"] === type ||
  (releaseGroup?.["secondary-types"] || []).includes(type);

export const isStudioRelease = (releaseGroup: ReleaseGroup | null | undefined) =>
  (releaseGroup?.["secondary-types"] || []).every((type) => type === "Compilation");

export const matchesReleaseGroupTab = (
  releaseGroup: ReleaseGroup | null | undefined,
  tab: string,
  includeOtherReleases = true,
) => {
  if (!includeOtherReleases && !isStudioRelease(releaseGroup)) return false;
  if (tab === "all") return true;
  const isCompilation = hasReleaseGroupType(releaseGroup, "Compilation");
  if (tab === "compilations") return isCompilation;
  if (isCompilation) return false;
  if (tab === "singles") {
    const primaryType = releaseGroup?.["primary-type"];
    return primaryType !== undefined && ["EP", "Single"].includes(primaryType);
  }
  return releaseGroup?.["primary-type"] === "Album";
};

export const preferStudioReleases = <T extends ReleaseGroup>(releaseGroups: T[], tab: string) => {
  const studio = releaseGroups.filter((releaseGroup) =>
    matchesReleaseGroupTab(releaseGroup, tab, false),
  );
  return studio.length > 0
    ? studio
    : releaseGroups.filter((releaseGroup) => matchesReleaseGroupTab(releaseGroup, tab));
};

export const matchesReleaseGroupSearch = (
  releaseGroup: ReleaseGroup | null | undefined,
  searchTerm: string | null | undefined,
) =>
  String(releaseGroup?.title || "")
    .toLowerCase()
    .includes(
      String(searchTerm || "")
        .trim()
        .toLowerCase(),
    );
