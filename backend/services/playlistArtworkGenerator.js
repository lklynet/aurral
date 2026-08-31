import { randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { dbOps } from "../db/helpers/index.js";
import { buildPlaylistArtworkWebpBuffer } from "./playlistArtwork.js";
import sharp from "./sharpConfig.js";
import {
  fetchImageBuffer,
  renderStylizedPhotoArtwork,
} from "./discovery/stylizedArtwork.js";
export const PLAYLIST_ARTWORK_STYLES = ["aurral", "photo"];

export function getPlaylistArtworkStyle() {
  const settings = dbOps.getSettings() || {};
  const style = String(settings?.playlistArtwork?.style || "photo")
    .trim()
    .toLowerCase();
  return PLAYLIST_ARTWORK_STYLES.includes(style) ? style : "photo";
}

export function getArtworkExtensionForStyle(style = getPlaylistArtworkStyle()) {
  return style === "photo" ? ".jpg" : ".webp";
}

export function getArtworkContentTypeForExtension(extension) {
  const normalized = String(extension || "").toLowerCase();
  if (normalized === ".webp") return "image/webp";
  if (normalized === ".jpg" || normalized === ".jpeg") return "image/jpeg";
  return "image/png";
}

export async function resolvePlaylistSourceImageUrl() {
  return `https://picsum.photos/800/800?random=${randomUUID()}`;
}

export async function buildGeneratedPlaylistArtworkBuffer({
  title,
  kind = "Playlist",
  style = null,
  paletteSeed = null,
}) {
  const resolvedStyle = style || getPlaylistArtworkStyle();
  const displayTitle = String(title || "").trim() || "Untitled";

  if (resolvedStyle === "aurral") {
    return buildPlaylistArtworkWebpBuffer({
      playlistName: displayTitle,
      kind,
    });
  }

  const sourceImageUrl = await resolvePlaylistSourceImageUrl();
  let sourceBuffer;
  try {
    sourceBuffer = await fetchImageBuffer(sourceImageUrl);
  } catch {
    const fallback = await buildPlaylistArtworkWebpBuffer({
      playlistName: displayTitle,
      kind,
    });
    return sharp(fallback).jpeg({ quality: 90, mozjpeg: true }).toBuffer();
  }
  return renderStylizedPhotoArtwork({
    imageBuffer: sourceBuffer,
    title: displayTitle,
    paletteSeed,
  });
}

const resolveArtworkOutputPath = (outputPath, style) => {
  const extension = getArtworkExtensionForStyle(style);
  const directory = path.dirname(outputPath);
  const baseName = path.basename(outputPath, path.extname(outputPath));
  return path.join(directory, `${baseName}${extension}`);
};

export async function writeGeneratedPlaylistArtwork({
  outputPath,
  title,
  kind = "Playlist",
  style = null,
  paletteSeed = null,
}) {
  const resolvedStyle = style || getPlaylistArtworkStyle();
  const targetPath = resolveArtworkOutputPath(outputPath, resolvedStyle);
  const directory = path.dirname(targetPath);
  const baseName = path.basename(targetPath, path.extname(targetPath));
  const keepExtension = path.extname(targetPath);

  for (const extension of [".jpg", ".webp", ".png"]) {
    if (extension === keepExtension) continue;
    await fs.unlink(path.join(directory, `${baseName}${extension}`)).catch(() => {});
  }

  const buffer = await buildGeneratedPlaylistArtworkBuffer({
    title,
    kind,
    style: resolvedStyle,
    paletteSeed,
  });
  await fs.writeFile(targetPath, buffer);
  return targetPath;
}
