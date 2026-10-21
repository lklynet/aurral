import type { ReleaseGroup } from "./utils.ts";

const hasReleaseGroupType = (releaseGroup: ReleaseGroup | null | undefined, type: string) =>
  releaseGroup?.["primary-type"] === type ||
  (releaseGroup?.["secondary-types"] || []).includes(type);

export const matchesReleaseGroupTab = (
  releaseGroup: ReleaseGroup | null | undefined,
  tab: string,
  showLiveAlbums = true,
) => {
  const isLive = hasReleaseGroupType(releaseGroup, "Live");
  if (!showLiveAlbums && isLive) return false;
  if (tab === "all") return true;
  const isCompilation = hasReleaseGroupType(releaseGroup, "Compilation");
  if (tab === "compilations") return isCompilation;
  if (isCompilation) return false;
  if (tab === "singles") {
    return ["EP", "Single"].includes(releaseGroup?.["primary-type"]);
  }
  return releaseGroup?.["primary-type"] === "Album";
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
