const RELEASE_TAG_RE = /^v?(?<major>\d+)\.(?<minor>\d+)\.(?<patch>\d+)$/;
const CONVENTIONAL_SUBJECT_RE = /^(?<type>[a-z]+)(?:\([^)]*\))?(?<breaking>!)?:/i;

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

  return {
    raw: String(value || ""),
    label: normalized,
    major: Number(match.groups.major),
    minor: Number(match.groups.minor),
    patch: Number(match.groups.patch),
  };
}

export function compareReleaseVersions(left, right) {
  const a = typeof left === "string" ? parseReleaseVersion(left) : left;
  const b = typeof right === "string" ? parseReleaseVersion(right) : right;

  if (!a || !b) {
    return 0;
  }
  return a.major - b.major || a.minor - b.minor || a.patch - b.patch;
}

export function extractTagNameFromRef(ref) {
  const match = String(ref || "").match(/^refs\/tags\/(.+)$/);
  return match ? match[1] : "";
}

function toReleases(tags) {
  return (Array.isArray(tags) ? tags : [])
    .map((tag) => parseReleaseVersion(tag))
    .filter(Boolean)
    .sort((left, right) => compareReleaseVersions(right, left));
}

export function selectLatestRelease(refs) {
  const latest = toReleases(
    (Array.isArray(refs) ? refs : []).map((ref) =>
      typeof ref === "string" ? ref : ref?.tag_name || ref?.name || extractTagNameFromRef(ref?.ref),
    ),
  )[0];

  return latest ? { parsed: latest, tagName: `v${latest.label}` } : null;
}

export function selectNightlyUpdate(currentVersion, latestSha) {
  const currentSha = String(currentVersion || "").split("+")[1] || "";
  const latest = String(latestSha || "");

  if (!currentSha || latest.length < 7 || latest.startsWith(currentSha)) {
    return null;
  }
  return { current: currentSha, latest: latest.slice(0, 7) };
}

export function suggestNextVersion(tags, commitSubjects = []) {
  const latest = toReleases(tags)[0] || { major: 0, minor: 0, patch: 0 };

  let bump = "patch";
  for (const subject of Array.isArray(commitSubjects) ? commitSubjects : []) {
    const match = CONVENTIONAL_SUBJECT_RE.exec(String(subject).trim());
    if (!match?.groups) {
      continue;
    }
    if (match.groups.breaking) {
      bump = "major";
      break;
    }
    if (match.groups.type.toLowerCase() === "feat") {
      bump = "minor";
    }
  }

  if (bump === "major") {
    return `${latest.major + 1}.0.0`;
  }
  if (bump === "minor") {
    return `${latest.major}.${latest.minor + 1}.0`;
  }
  return `${latest.major}.${latest.minor}.${latest.patch + 1}`;
}

export function resolveNextRelease({ targetVersion, allTags = [], headTags = [] } = {}) {
  const target = parseReleaseVersion(targetVersion);
  if (!target) {
    throw new Error(`Target version "${targetVersion || ""}" must be a stable semantic version.`);
  }

  const tag = `v${target.label}`;
  const matchesTarget = (candidate) => normalizeReleaseVersion(candidate) === target.label;

  if ((Array.isArray(headTags) ? headTags : []).some(matchesTarget)) {
    return { tag, version: target.label, reusedExistingTag: true };
  }

  if ((Array.isArray(allTags) ? allTags : []).some(matchesTarget)) {
    throw new Error(`Release tag ${tag} already exists on another commit.`);
  }

  const latestStable = toReleases(allTags)[0];
  if (latestStable && compareReleaseVersions(target, latestStable) <= 0) {
    throw new Error(
      `Target version ${target.label} must be newer than latest stable ${latestStable.label}.`,
    );
  }

  return { tag, version: target.label, reusedExistingTag: false };
}
