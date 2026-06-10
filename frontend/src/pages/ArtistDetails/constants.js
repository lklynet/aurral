export const TAG_COLORS = [
  "#845336",
  "#57553c",
  "#a17e3e",
  "#43454f",
  "#604848",
  "#5c6652",
  "#a18b62",
  "#8c4f4a",
  "#898471",
  "#c8b491",
  "#65788f",
  "#755e4a",
  "#718062",
  "#bc9d66",
];

export const primaryReleaseTypes = ["Album", "EP", "Single"];
export const secondaryReleaseTypes = [
  "Live",
  "Remix",
  "Compilation",
  "Demo",
  "Broadcast",
  "Soundtrack",
  "Spokenword",
  "Other",
];
export const allReleaseTypes = [...primaryReleaseTypes, ...secondaryReleaseTypes];

export const emptyArtistShape = {
  disambiguation: "",
  "type-id": null,
  type: null,
  country: null,
  "life-span": { begin: null, end: null, ended: false },
  tags: [],
  genres: [],
  relations: [],
  "appears-on-release-groups": [],
  "release-group-count": 0,
  "release-count": 0,
};

export const ARTIST_DETAILS_FILTER_KEY = "artistDetailsFilterSettings";
