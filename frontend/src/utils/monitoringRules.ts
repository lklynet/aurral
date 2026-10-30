import type { MonitoringRules } from "../components/MonitoringRulesFields.tsx";

export const MAX_LATEST_RELEASES = 10;
export const MAX_TOP_TRACKS = 50;

export const CATALOG_OPTIONS: { value: MonitoringRules["catalog"]; label: string }[] = [
  { value: "all", label: "Everything" },
  { value: "since", label: "Since a year" },
  { value: "latest", label: "Latest releases" },
  { value: "none", label: "Nothing" },
];

export const RELEASE_TYPE_OPTIONS = [
  { value: "album", label: "Albums" },
  { value: "ep", label: "EPs" },
  { value: "single", label: "Singles" },
];

export const EXTRA_TYPE_OPTIONS = [
  { value: "live", label: "Live" },
  { value: "compilation", label: "Compilations" },
  { value: "soundtrack", label: "Soundtracks" },
  { value: "remix", label: "Remixes" },
  { value: "demo", label: "Demos" },
  { value: "dj-mix", label: "DJ mixes" },
  { value: "mixtape/street", label: "Mixtapes" },
];

export const EDITION_OPTIONS: { value: MonitoringRules["edition"]; label: string }[] = [
  { value: "standard", label: "Standard" },
  { value: "expanded", label: "Expanded" },
];

export const RELEASE_SKIP_REASONS = {
  complete: "Already in your library",
  covered: "Another release has its songs",
  excluded: "You removed it",
  unmonitored: "You stopped monitoring it",
  managed_by_lidarr: "Managed by Lidarr",
  metadata_unavailable: "Its tracklist could not be loaded",
};

export const TRACK_SKIP_REASONS = {
  excluded: "You removed it",
  in_library: "Already in your library",
  on_release: "On a release above",
  queued: "Already downloading",
};

const labelsFor = (
  values: readonly string[] | null | undefined,
  options: { value: string; label: string }[],
) => options.filter((option) => values?.includes(option.value)).map((option) => option.label);

export const joinWords = (words: string[]) =>
  words.length <= 1 ? words.join("") : `${words.slice(0, -1).join(", ")} and ${words.at(-1)}`;

const lowerFirst = (text: string) => text.charAt(0).toLowerCase() + text.slice(1);

function describeScope(rules: MonitoringRules) {
  const catalog = {
    all: "Everything",
    since: `Everything since ${rules.sinceYear}`,
    latest:
      rules.latestCount === 1 ? "The latest release" : `The latest ${rules.latestCount} releases`,
    none: null,
  }[rules.catalog];
  if (!catalog) return rules.newReleases ? "New releases" : null;
  return rules.newReleases ? `${catalog} and new releases` : catalog;
}

export function describeMonitoringRules(rules: MonitoringRules | null | undefined) {
  if (!rules) return "";
  const scope = describeScope(rules);
  const types = joinWords(labelsFor(rules.types, RELEASE_TYPE_OPTIONS));
  const extras = labelsFor(rules.extraTypes, EXTRA_TYPE_OPTIONS).map(lowerFirst);
  const parts = [
    scope,
    scope ? (extras.length ? `${types}, including ${joinWords(extras)}` : types) : null,
    rules.topTracks > 0
      ? `Top ${rules.topTracks} ${rules.topTracks === 1 ? "track" : "tracks"}`
      : null,
    rules.edition === "expanded" ? "Expanded editions" : null,
  ];
  return parts.filter(Boolean).join(" · ");
}

export const plural = (count: number, singular: string, pluralForm = `${singular}s`) =>
  `${count} ${count === 1 ? singular : pluralForm}`;

export function describeDownloadCount({
  releases = 0,
  tracks = 0,
}: {
  releases?: number;
  tracks?: number;
}) {
  const parts = [
    releases > 0 ? plural(releases, "release") : null,
    tracks > 0 ? plural(tracks, "top track") : null,
  ].filter(Boolean) as string[];
  return parts.length ? joinWords(parts) : "";
}

export const rulesForEditing = (
  state:
    | { rules?: MonitoringRules | null; defaultRules?: MonitoringRules | null }
    | null
    | undefined,
) => state?.rules || state?.defaultRules || null;
