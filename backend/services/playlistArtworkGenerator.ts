import { createHash, randomInt } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { getArtistImage } from "./imageService.ts";
import { fetchDeezerArtistImageUrl } from "./releaseGroupCoverService.ts";
import { buildStableImageProxyUrl, fetchRemoteImage, warmImageProxy } from "./imageProxyService.ts";
import {
  PLAYLIST_COVER_TEMPLATES,
  renderPlaylistCover,
  type PlaylistCoverTemplate,
} from "./playlistCoverTemplates.ts";
import { writePlaylistArtworkBuffer } from "./playlistArtwork.ts";
import type { PlaylistArtworkState, PlaylistArtworkStyle } from "./playlistArtworkState.ts";

export type PlaylistArtworkArtist = { artistName: string; artistMbid?: string | null };

export function getArtworkContentTypeForExtension(extension: string) {
  const normalized = extension.toLowerCase();
  if (normalized === ".webp") return "image/webp";
  if (normalized === ".jpg" || normalized === ".jpeg") return "image/jpeg";
  return "image/png";
}

export async function readPlaylistImageBuffer(url: string) {
  const source = buildStableImageProxyUrl(url) || url;
  if (/^https?:\/\//i.test(source)) return (await fetchRemoteImage(source)).buffer;
  const entry = await warmImageProxy(source);
  return fs.readFile(entry.imagePath);
}

export function playlistArtistSignature(artists: PlaylistArtworkArtist[]) {
  return createHash("sha256")
    .update(
      JSON.stringify(
        [
          ...new Set(
            artists.map(
              (artist) => `${artist.artistName.trim().toLowerCase()}:${artist.artistMbid || ""}`,
            ),
          ),
        ].sort(),
      ),
    )
    .digest("hex");
}

export type PlaylistCoverPick = {
  style: PlaylistArtworkStyle;
  artistKey: string | null;
  template: PlaylistCoverTemplate;
};

export function parsePlaylistCoverPick(value: unknown): PlaylistCoverPick | null {
  if (!value || typeof value !== "object") return null;
  const style: unknown = Reflect.get(value, "style");
  const artistKey: unknown = Reflect.get(value, "artistKey");
  const template = PLAYLIST_COVER_TEMPLATES.find(
    (candidate) => candidate === Reflect.get(value, "template"),
  );
  if ((style !== "artist" && style !== "simple") || !template) return null;
  return {
    style,
    artistKey: typeof artistKey === "string" && artistKey ? artistKey : null,
    template,
  };
}

function uniqueArtists(artists: PlaylistArtworkArtist[]) {
  const unique = new Map<string, PlaylistArtworkArtist>();
  for (const artist of artists) {
    const key = artist.artistName.trim().toLowerCase();
    if (key && (!unique.has(key) || !unique.get(key)?.artistMbid)) unique.set(key, artist);
  }
  return unique;
}

async function loadArtistImage(artist: PlaylistArtworkArtist) {
  try {
    let url: string | null = null;
    if (artist.artistMbid) {
      const image = await getArtistImage(artist.artistMbid, { artistName: artist.artistName });
      url =
        image.images.find((entry) => !entry.types?.some((type) => /front|album|cover/i.test(type)))
          ?.image || null;
    }
    url ||= await fetchDeezerArtistImageUrl({ artistName: artist.artistName });
    return url ? await readPlaylistImageBuffer(url) : null;
  } catch {
    return null;
  }
}

async function pickArtistImage(artists: PlaylistArtworkArtist[], previousKey?: string | null) {
  const unique = uniqueArtists(artists);
  const candidates = [...unique.entries()].filter(([key]) => key !== previousKey);
  for (let i = candidates.length - 1; i > 0; i--) {
    const j = randomInt(i + 1);
    [candidates[i], candidates[j]] = [candidates[j], candidates[i]];
  }
  const selected = candidates.slice(0, 6);
  const previous = previousKey ? unique.get(previousKey) : null;
  if (previous && previousKey) selected.push([previousKey, previous]);
  for (const [artistKey, artist] of selected) {
    const buffer = await loadArtistImage(artist);
    if (buffer) return { artistKey, buffer };
  }
  return null;
}

export async function shufflePlaylistCover({
  artists,
  style,
  previous = null,
}: {
  artists: PlaylistArtworkArtist[];
  style: PlaylistArtworkStyle;
  previous?: Pick<PlaylistArtworkState, "artistKey" | "template"> | null;
}) {
  const image = style === "artist" ? await pickArtistImage(artists, previous?.artistKey) : null;
  const index = previous?.template ? PLAYLIST_COVER_TEMPLATES.indexOf(previous.template) : -1;
  const template =
    PLAYLIST_COVER_TEMPLATES[
      index < 0
        ? randomInt(PLAYLIST_COVER_TEMPLATES.length)
        : (index + 1) % PLAYLIST_COVER_TEMPLATES.length
    ];
  return {
    pick: { style, artistKey: image?.artistKey ?? null, template } satisfies PlaylistCoverPick,
    imageBuffer: image?.buffer ?? null,
  };
}

async function loadPickedImage(artists: PlaylistArtworkArtist[], pick: PlaylistCoverPick) {
  const artist =
    pick.style === "artist" && pick.artistKey ? uniqueArtists(artists).get(pick.artistKey) : null;
  return artist ? loadArtistImage(artist) : null;
}

export async function renderPickedPlaylistCover({
  title,
  artists,
  pick,
}: {
  title: string;
  artists: PlaylistArtworkArtist[];
  pick: PlaylistCoverPick;
}) {
  return renderPlaylistCover({
    title,
    imageBuffer: await loadPickedImage(artists, pick),
    template: pick.template,
  });
}

export async function writeGeneratedPlaylistArtwork({
  outputPath,
  title,
  artists = [],
  style = "artist",
  previous = null,
  pick = null,
  keepPhoto = false,
}: {
  outputPath: string;
  title: string;
  artists?: PlaylistArtworkArtist[];
  style?: PlaylistArtworkStyle;
  previous?: PlaylistArtworkState | null;
  pick?: PlaylistCoverPick | null;
  keepPhoto?: boolean;
}) {
  const chosen = pick
    ? { pick, imageBuffer: await loadPickedImage(artists, pick) }
    : await shufflePlaylistCover({ artists, style, previous });
  if (keepPhoto && chosen.pick.style === "artist" && chosen.pick.artistKey && !chosen.imageBuffer)
    throw new Error("Artist photo unavailable");
  const buffer = await renderPlaylistCover({
    title,
    imageBuffer: chosen.imageBuffer,
    template: chosen.pick.template,
  });
  const target = path.join(
    path.dirname(outputPath),
    `${path.basename(outputPath, path.extname(outputPath))}.webp`,
  );
  await writePlaylistArtworkBuffer(buffer, target);
  for (const extension of [".jpg", ".png"])
    await fs.unlink(target.slice(0, -5) + extension).catch(() => {});
  const mode = chosen.pick.style;
  return {
    outputPath: target,
    state: {
      mode,
      title,
      artistKey: chosen.imageBuffer ? chosen.pick.artistKey : null,
      template: chosen.pick.template,
      sourceUrl: null,
      fallbackSignature:
        mode === "artist" && !chosen.imageBuffer ? playlistArtistSignature(artists) : null,
    } satisfies PlaylistArtworkState,
  };
}
