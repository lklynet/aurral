import { splitArtistTitleSegments } from "./candidateNormalizer.js";
import { isPromoGroup, stripPromoDescriptors } from "./semanticPolicy.js";
import { bestArtistSimilarity, MATCH_POLICY, normalizeMatchText, titleSimilarity } from "./nativeMatcher.js";

const VIDEO_WORDS = /\b(?:video|mv|clip)\b/iu;
const LYRIC_VIDEO = /\blyrics?\s+video\b/giu;
const ARTIST_SEGMENT_SIMILARITY = 0.6;

// "Fleetwood Mac - Topic" and "DaftPunkVEVO" are the artist's own channels.
function channelArtistName(channel) {
  return String(channel || "")
    .replace(/\s*-\s*topic$/iu, "")
    .replace(/\s*vevo$/iu, "")
    .replace(/\s+official$/iu, "")
    .trim();
}

// An upload on the artist's channel that is not a music video is the release
// audio, like the "- Topic" uploads YouTube makes from label feeds. Lyric
// videos and visualizers carry the studio audio; music videos are often cut
// differently.
export function readYoutubeUpload(title, channel, artistNames) {
  const channelArtist = channelArtistName(channel);
  const artistChannel = (bestArtistSimilarity(artistNames, channelArtist) ?? 0)
    >= MATCH_POLICY.minArtistSimilarity;
  return {
    channelArtist: artistChannel ? channelArtist : null,
    officialAudio: artistChannel && !VIDEO_WORDS.test(String(title || "").replace(LYRIC_VIDEO, "")),
  };
}

// Video titles read "Artist - Title (Official Video)", "Title - Artist",
// "Artist「Title」", or only "Title" on the artist's channel, often followed
// by "| Album". The segment that names the artist is the artist; of the rest,
// the part closest to the requested title is the title, and all of it keeps
// any version wording.
export function parseYoutubeTitle(title, artistNames, requestedTitle) {
  const raw = String(title || "").trim();
  const cleaned = stripPromoDescriptors(raw.replace(/[「『]([^」』]+)[」』]/gu, " - $1 - ")) || raw;
  const segments = cleaned.split(/\s+\|\s+/u)
    .flatMap((part) => splitArtistTitleSegments(part) || [part])
    .map((segment) => segment.trim())
    .filter((segment) => segment && !isPromoGroup(segment));
  if (segments.length === 0) return { title: cleaned, versionTitle: cleaned, artist: null };
  const scores = segments.map((segment) =>
    segments.length > 1 ? bestArtistSimilarity(artistNames, segment) ?? 0 : 0);
  const best = Math.max(...scores);
  const artistIndex = best >= ARTIST_SEGMENT_SIMILARITY ? scores.indexOf(best) : -1;
  const rest = segments.filter((_, index) => index !== artistIndex);
  const versionTitle = rest.join(" - ");
  const titleOption = [versionTitle, ...(rest.length > 1 ? rest : [])]
    .reduce((kept, option) =>
      titleSimilarity(requestedTitle, option) > titleSimilarity(requestedTitle, kept) ? option : kept);
  // In "Other Artist - Title" the first part names whoever else recorded it.
  const claimedArtist = artistIndex < 0 && segments.length === 2 && titleOption === segments[1]
    && titleSimilarity(requestedTitle, segments[1]) > titleSimilarity(requestedTitle, segments[0])
    ? segments[0] : null;
  return {
    title: titleOption,
    versionTitle,
    artist: artistIndex >= 0 ? segments[artistIndex] : claimedArtist,
  };
}

// yt-dlp tags a file with YouTube's own track and artist when it has them.
// Otherwise it splits the video title at its first dash, which puts the title
// of "Title - Artist" in the artist tag, or it names the uploader as the
// artist. Only then does the artist named in the video title count: in
// "Six Feet Under - Song - AC/DC" the tag names who performs the cover.
export function readYoutubeFile({ tagTitle, tagArtists = [], videoTitle, channel }, artistNames, requestedTitle) {
  const fromTags = parseYoutubeTitle(tagTitle, artistNames, requestedTitle);
  const fromVideo = videoTitle ? parseYoutubeTitle(videoTitle, artistNames, requestedTitle) : null;
  const upload = readYoutubeUpload(videoTitle, channel, artistNames);
  const uploader = normalizeMatchText(channelArtistName(channel));
  const credited = tagArtists.map(channelArtistName)
    .filter((name) => upload.channelArtist || !uploader || normalizeMatchText(name) !== uploader)
    .filter((name) => titleSimilarity(requestedTitle, name) < 1);
  const title = fromVideo && titleSimilarity(requestedTitle, fromVideo.title) > titleSimilarity(requestedTitle, fromTags.title)
    ? fromVideo.title : fromTags.title;
  return {
    title,
    versionTitle: [fromTags.versionTitle, fromVideo?.versionTitle].filter(Boolean).join(" "),
    artists: credited.length ? credited : [fromVideo?.artist].filter(Boolean),
    officialAudio: upload.officialAudio,
  };
}
