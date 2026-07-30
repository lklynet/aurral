const RELEASE_TAG_RE =
  /^v?(?<major>\d+)\.(?<minor>\d+)\.(?<patch>\d+)(?:-(?<prereleaseChannel>test|dev)\.(?<prerelease>\d+))?$/i;

export function normalizeReleaseVersion(value) {
  return String(value || "")
    .trim()
    .replace(/^v/, "");
}

export function parseReleaseVersion(value) {
  const normalized = normalizeReleaseVersion(value);
  const match = RELEASE_TAG_RE.exec(normalized);
  if (!match?.groups) {
    return null;
  }

  const major = Number(match.groups.major);
  const minor = Number(match.groups.minor);
  const patch = Number(match.groups.patch);
  const prereleaseChannel = match.groups.prereleaseChannel
    ? String(match.groups.prereleaseChannel).toLowerCase()
    : null;
  const prerelease = match.groups.prerelease == null ? null : Number(match.groups.prerelease);

  return {
    raw: String(value || ""),
    label: normalized,
    major,
    minor,
    patch,
    prerelease,
    channel: prereleaseChannel || "stable",
  };
}

export function compareReleaseVersions(left, right) {
  const a = typeof left === "string" ? parseReleaseVersion(left) : left;
  const b = typeof right === "string" ? parseReleaseVersion(right) : right;

  if (!a || !b) {
    return 0;
  }
  if (a.major !== b.major) {
    return a.major - b.major;
  }
  if (a.minor !== b.minor) {
    return a.minor - b.minor;
  }
  if (a.patch !== b.patch) {
    return a.patch - b.patch;
  }
  if (a.prerelease == null && b.prerelease == null) {
    return 0;
  }
  if (a.prerelease == null) {
    return 1;
  }
  if (b.prerelease == null) {
    return -1;
  }
  return a.prerelease - b.prerelease;
}

export function extractTagNameFromRef(ref) {
  const match = String(ref || "").match(/^refs\/tags\/(.+)$/);
  return match ? match[1] : "";
}

export function selectLatestReleaseForChannel(refs, channel) {
  const expectedChannel = channel === "test" || channel === "dev" ? channel : "stable";
  const candidates = (Array.isArray(refs) ? refs : [])
    .map((ref) => {
      const tagName =
        typeof ref === "string"
          ? ref
          : ref?.tag_name || ref?.name || extractTagNameFromRef(ref?.ref);
      const parsed = parseReleaseVersion(tagName);
      return parsed ? { parsed, tagName: `v${parsed.label}` } : null;
    })
    .filter((candidate) => candidate && candidate.parsed.channel === expectedChannel);

  if (!candidates.length) {
    return null;
  }

  candidates.sort((left, right) => compareReleaseVersions(right.parsed, left.parsed));

  return candidates[0];
}

function toTagName(version) {
  return `v${normalizeReleaseVersion(version)}`;
}

function getStableReleases(tags) {
  return (Array.isArray(tags) ? tags : [])
    .map((tag) => parseReleaseVersion(tag))
    .filter((release) => release && release.channel === "stable")
    .sort((left, right) => compareReleaseVersions(right, left));
}

export function nextPatchVersion(tags) {
  const latest = getStableReleases(tags)[0];
  return latest ? `${latest.major}.${latest.minor}.${latest.patch + 1}` : "0.0.1";
}

function matchesTarget(release, target) {
  return (
    release.major === target.major &&
    release.minor === target.minor &&
    release.patch === target.patch
  );
}

function getHeadTagForBranch(tags, branch, target) {
  const expectedChannel = branch === "test" || branch === "dev" ? branch : "stable";
  return (Array.isArray(tags) ? tags : [])
    .map((tag) => parseReleaseVersion(tag))
    .filter(
      (release) =>
        release && release.channel === expectedChannel && matchesTarget(release, target),
    )
    .sort((left, right) => compareReleaseVersions(right, left))[0];
}

export function formatRelease(release) {
  if (!release) {
    return "";
  }
  if (release.channel === "test" || release.channel === "dev") {
    return `${release.major}.${release.minor}.${release.patch}-${release.channel}.${release.prerelease}`;
  }
  return `${release.major}.${release.minor}.${release.patch}`;
}

export function resolveNextRelease({
  branch,
  targetVersion,
  allTags = [],
  headTags = [],
} = {}) {
  if (branch !== "main" && branch !== "test" && branch !== "dev") {
    return null;
  }

  const target = parseReleaseVersion(targetVersion);
  if (!target || target.channel !== "stable") {
    throw new Error(`Target version "${targetVersion || ""}" must be a stable semantic version.`);
  }

  const existingHeadRelease = getHeadTagForBranch(headTags, branch, target);
  if (existingHeadRelease) {
    const version = formatRelease(existingHeadRelease);
    return {
      tag: toTagName(version),
      version,
      channel: existingHeadRelease.channel,
      isPrerelease: existingHeadRelease.channel !== "stable",
      makeLatest: existingHeadRelease.channel === "stable",
      reusedExistingTag: true,
    };
  }

  const stableReleases = getStableReleases(allTags);
  const latestStable = stableReleases[0] || null;
  if (latestStable && compareReleaseVersions(target, latestStable) <= 0) {
    throw new Error(
      `Target version ${formatRelease(target)} must be newer than latest stable ${formatRelease(latestStable)}.`,
    );
  }

  if (branch === "main") {
    const version = formatRelease(target);
    if ((Array.isArray(allTags) ? allTags : []).some((tag) => normalizeReleaseVersion(tag) === version)) {
      throw new Error(`Release tag v${version} already exists on another commit.`);
    }
    return {
      tag: toTagName(version),
      version,
      channel: "stable",
      isPrerelease: false,
      makeLatest: true,
      reusedExistingTag: false,
    };
  }

  const stableTargetTag = toTagName(formatRelease(target));
  if (
    (Array.isArray(allTags) ? allTags : []).some(
      (tag) => toTagName(tag).toLowerCase() === stableTargetTag.toLowerCase(),
    )
  ) {
    throw new Error(`Stable release ${stableTargetTag} already exists; choose a newer target version.`);
  }

  const prereleaseBase = formatRelease(target);
  const existingPrereleases = (Array.isArray(allTags) ? allTags : [])
    .map((tag) => parseReleaseVersion(tag))
    .filter(
      (release) =>
        release &&
        release.channel === branch &&
        matchesTarget(release, target),
    )
    .sort((left, right) => compareReleaseVersions(right, left));

  const nextPrereleaseNumber =
    existingPrereleases[0]?.prerelease != null ? existingPrereleases[0].prerelease + 1 : 1;
  const version = `${prereleaseBase}-${branch}.${nextPrereleaseNumber}`;
  return {
    tag: toTagName(version),
    version,
    channel: branch,
    isPrerelease: true,
    makeLatest: false,
    reusedExistingTag: false,
  };
}
