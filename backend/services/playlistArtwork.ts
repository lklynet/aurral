import fs from "node:fs/promises";
import { randomUUID } from "node:crypto";
import getSharp from "./sharpConfig.ts";

const PLAYLIST_ARTWORK_WEBP_QUALITY = 85;

export async function writePlaylistArtworkWebpFromBuffer(buffer: Buffer, outputPath: string) {
  const sharp = await getSharp();
  const image = await sharp(buffer, { animated: false })
    .rotate()
    .resize(1000, 1000, { fit: "cover" })
    .webp({ quality: PLAYLIST_ARTWORK_WEBP_QUALITY })
    .toBuffer();
  await writePlaylistArtworkBuffer(image, outputPath);
}

export async function writePlaylistArtworkBuffer(buffer: Buffer, outputPath: string) {
  const temporary = `${outputPath}.${randomUUID()}.tmp`;
  try {
    await fs.writeFile(temporary, buffer);
    await fs.rename(temporary, outputPath);
  } finally {
    await fs.unlink(temporary).catch(() => {});
  }
}
