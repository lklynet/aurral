const RELEASE_TAG_RE = /^v?(?<major>\d+)\.(?<minor>\d+)\.(?<patch>\d+)$/;
const NIGHTLY_VERSION_RE = /^nightly\.(?<run>\d+)\+(?<sha>[0-9a-f]{7,40})$/;
const CONVENTIONAL_SUBJECT_RE = /^(?<type>[a-z]+)(?:\([^)]*\))?(?<breaking>!)?:/i;
const RELEASE_NOTE_ITEM_RE = /^(?:[-*+]\s+|\d+[.)]\s+)/;

type ReleaseRef = string | { tag_name?: string; name?: string; ref?: string };

export function normalizeReleaseVersion(value: string | undefined) {
  return String(value || "")
    .trim()
    .replace(/^v/, "");
}

export function parseReleaseVersion(value: string | undefined) {
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

type ReleaseVersion = NonNullable<ReturnType<typeof parseReleaseVersion>>;

export function compareReleaseVersions(
  left: ReleaseVersion | string | null,
  right: ReleaseVersion | string | null,
) {
  const a = typeof left === "string" ? parseReleaseVersion(left) : left;
  const b = typeof right === "string" ? parseReleaseVersion(right) : right;

  if (!a || !b) {
    return 0;
  }
  return a.major - b.major || a.minor - b.minor || a.patch - b.patch;
}

export function extractTagNameFromRef(ref: string | undefined) {
  const match = String(ref || "").match(/^refs\/tags\/(.+)$/);
  return match ? match[1] : "";
}

function toReleases(tags: string[]) {
  return (Array.isArray(tags) ? tags : [])
    .map((tag) => parseReleaseVersion(tag))
    .filter(Boolean)
    .sort((left, right) => compareReleaseVersions(right, left));
}

export function selectLatestRelease(refs: ReleaseRef[]) {
  const latest = toReleases(
    (Array.isArray(refs) ? refs : []).map((ref) =>
      typeof ref === "string" ? ref : ref?.tag_name || ref?.name || extractTagNameFromRef(ref?.ref),
    ),
  )[0];

  return latest ? { parsed: latest, tagName: `v${latest.label}` } : null;
}

export function parseNightlyVersion(value: string | undefined) {
  const match = NIGHTLY_VERSION_RE.exec(String(value || ""));
  return match?.groups ? { run: Number(match.groups.run), sha: match.groups.sha } : null;
}

export function releaseChannel(version: string | undefined) {
  if (parseReleaseVersion(version)) return "stable";
  if (parseNightlyVersion(version)) return "nightly";
  return null;
}

export function extractReleaseNoteItems(body: string | null | undefined, maxItems = 8) {
  return String(body || "")
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => RELEASE_NOTE_ITEM_RE.test(line))
    .map((line) =>
      line
        .replace(RELEASE_NOTE_ITEM_RE, "")
        .replace(/\[([^\]]+)\]\([^)]*\)/g, "$1")
        .replace(/\s+https?:\/\/\S+/g, "")
        .replace(/\s+in\s*$/i, "")
        .replace(/\s+/g, " ")
        .trim(),
    )
    .filter(Boolean)
    .slice(0, Math.max(0, maxItems));
}

export function suggestNextVersion(tags: string[], commitSubjects: string[] = []) {
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

export function resolveNextRelease({
  targetVersion,
  allTags = [],
  headTags = [],
}: { targetVersion?: string; allTags?: string[]; headTags?: string[] } = {}) {
  const target = parseReleaseVersion(targetVersion);
  if (!target) {
    throw new Error(`Target version "${targetVersion || ""}" must be a stable semantic version.`);
  }

  const tag = `v${target.label}`;
  const matchesTarget = (candidate: string) => normalizeReleaseVersion(candidate) === target.label;

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
