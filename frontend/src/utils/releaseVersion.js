const RELEASE_VERSION_RE =
  /^v?(?<major>\d+)\.(?<minor>\d+)\.(?<patch>\d+)(?:-(?<prereleaseChannel>test|dev)\.(?<prerelease>\d+))?$/i;

export function normalizeReleaseVersion(value) {
  return String(value || "").trim().replace(/^v/, "");
}

export function parseReleaseVersion(value) {
  const normalized = normalizeReleaseVersion(value);
  const match = RELEASE_VERSION_RE.exec(normalized);
  if (!match?.groups) {
    return null;
  }

  const major = Number(match.groups.major);
  const minor = Number(match.groups.minor);
  const patch = Number(match.groups.patch);
  const prereleaseChannel = match.groups.prereleaseChannel
    ? String(match.groups.prereleaseChannel).toLowerCase()
    : null;
  const prerelease =
    match.groups.prerelease == null ? null : Number(match.groups.prerelease);

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
  const expectedChannel =
    channel === "test" || channel === "dev" ? channel : "stable";
  const candidates = (Array.isArray(refs) ? refs : [])
    .map((ref) => {
      const tagName =
        typeof ref === "string"
          ? ref
          : ref?.tag_name || ref?.name || extractTagNameFromRef(ref?.ref);
      const parsed = parseReleaseVersion(tagName);
      return parsed ? { parsed, tagName: `v${parsed.label}` } : null;
    })
    .filter(
      (candidate) => candidate && candidate.parsed.channel === expectedChannel,
    );

  if (!candidates.length) {
    return null;
  }

  candidates.sort((left, right) =>
    compareReleaseVersions(right.parsed, left.parsed),
  );

  return candidates[0];
}
