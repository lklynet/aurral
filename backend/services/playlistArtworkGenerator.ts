import { createHash, randomInt } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { getArtistImage } from "./imageService.ts";
import { fetchDeezerArtistImageUrl } from "./releaseGroupCoverService.ts";
import { buildStableImageProxyUrl, fetchRemoteImage, warmImageProxy } from "./imageProxyService.ts";
import { PLAYLIST_COVER_TEMPLATES, renderPlaylistCover } from "./playlistCoverTemplates.ts";
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

async function pickArtistImage(artists: PlaylistArtworkArtist[], previousKey?: string | null) {
  const unique = new Map<string, PlaylistArtworkArtist>();
  for (const artist of artists) {
    const key = artist.artistName.trim().toLowerCase();
    if (key && (!unique.has(key) || !unique.get(key)?.artistMbid)) unique.set(key, artist);
  }
  const candidates = [...unique.entries()].filter(([key]) => key !== previousKey);
  for (let i = candidates.length - 1; i > 0; i--) {
    const j = randomInt(i + 1);
    [candidates[i], candidates[j]] = [candidates[j], candidates[i]];
  }
  const selected = candidates.slice(0, 6);
  const previous = previousKey ? unique.get(previousKey) : null;
  if (previous && previousKey) selected.push([previousKey, previous]);
  for (const [artistKey, artist] of selected) {
    try {
      let url: string | null = null;
      if (artist.artistMbid) {
        const image = await getArtistImage(artist.artistMbid, { artistName: artist.artistName });
        url =
          image.images.find(
            (entry) => !entry.types?.some((type) => /front|album|cover/i.test(type)),
          )?.image || null;
      }
      url ||= await fetchDeezerArtistImageUrl({ artistName: artist.artistName });
      if (url) return { artistKey, buffer: await readPlaylistImageBuffer(url) };
    } catch {}
  }
  return null;
}

export async function writeGeneratedPlaylistArtwork({
  outputPath,
  title,
  artists = [],
  style = "artist",
  previous = null,
}: {
  outputPath: string;
  title: string;
  artists?: PlaylistArtworkArtist[];
  style?: PlaylistArtworkStyle;
  previous?: PlaylistArtworkState | null;
}) {
  const image = style === "artist" ? await pickArtistImage(artists, previous?.artistKey) : null;
  const index = previous?.template ? PLAYLIST_COVER_TEMPLATES.indexOf(previous.template) : -1;
  const template =
    PLAYLIST_COVER_TEMPLATES[
      index < 0
        ? randomInt(PLAYLIST_COVER_TEMPLATES.length)
        : (index + 1) % PLAYLIST_COVER_TEMPLATES.length
    ];
  const buffer = await renderPlaylistCover({ title, imageBuffer: image?.buffer, template });
  const target = path.join(
    path.dirname(outputPath),
    `${path.basename(outputPath, path.extname(outputPath))}.webp`,
  );
  await writePlaylistArtworkBuffer(buffer, target);
  for (const extension of [".jpg", ".png"])
    await fs.unlink(target.slice(0, -5) + extension).catch(() => {});
  return {
    outputPath: target,
    state: {
      mode: style,
      artistKey: image?.artistKey || null,
      template: image ? template : previous?.template || null,
      sourceUrl: null,
      fallbackSignature: style === "artist" && !image ? playlistArtistSignature(artists) : null,
    } satisfies PlaylistArtworkState,
  };
}
