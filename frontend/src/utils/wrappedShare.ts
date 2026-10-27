import type { WrappedSummary } from "../../../backend/services/wrapped/metrics.ts";
import { resolveApiPath } from "./api/core.ts";

async function artwork(url: string) {
  const image = new Image();
  image.crossOrigin = "anonymous";
  image.src = url.startsWith("/api/") ? resolveApiPath(url) : url;
  await image.decode();
  return image;
}

export async function createWrappedImage(summary: WrappedSummary) {
  const canvas = document.createElement("canvas");
  canvas.width = 1080;
  canvas.height = 1920;
  const context = canvas.getContext("2d");
  if (!context) throw new Error("Image export is unavailable in this browser");
  context.fillStyle = "#000";
  context.fillRect(0, 0, canvas.width, canvas.height);
  context.fillStyle = "#fff";
  context.font = "600 30px Arial";
  context.fillText("Aurral Wrapped", 70, 72);
  context.font = "220px Georgia";
  context.fillText(String(summary.year), 60, 285);
  const covers = await Promise.all(
    summary.topAlbums.slice(0, 3).map(async (album) => {
      if (!album.artwork) return null;
      try {
        return await artwork(album.artwork);
      } catch {
        return null;
      }
    }),
  );
  if (covers.every((cover) => !cover)) {
    summary.topSongs.slice(0, 3).forEach((song, index) => {
      context.font = "600 45px Arial";
      let name = song.name;
      while (name.length > 1 && context.measureText(name).width > 900)
        name = name.slice(0, -2) + "…";
      context.fillText(name, 70, 480 + index * 130);
      context.font = "28px Arial";
      context.fillText(song.artist.slice(0, 55), 70, 531 + index * 130);
    });
  }
  for (let i = 0; i < covers.length; i++) {
    const cover = covers[i];
    if (!cover) continue;
    context.save();
    context.translate(245 + i * 285, 650 + (i === 1 ? -25 : 0));
    context.rotate((i - 1) * 0.12);
    const side = Math.min(cover.width, cover.height);
    context.drawImage(
      cover,
      (cover.width - side) / 2,
      (cover.height - side) / 2,
      side,
      side,
      -220,
      -220,
      440,
      440,
    );
    context.restore();
  }
  context.font = "800 142px Arial";
  context.fillText(summary.totalPlays.toLocaleString(), 65, 1120);
  context.font = "36px Arial";
  context.fillText("plays", 70, 1180);
  context.font = "32px Arial";
  context.fillText(
    `${summary.uniqueArtists.toLocaleString()} artists     ${summary.uniqueSongs.toLocaleString()} songs`,
    70,
    1270,
  );
  context.font = "600 43px Arial";
  summary.topArtists.slice(0, 3).forEach((artist, index) => {
    let name = artist.name;
    while (name.length > 1 && context.measureText(name).width > 920) name = name.slice(0, -2) + "…";
    context.fillText(name, 70, 1410 + index * 90);
  });
  context.font = "26px Arial";
  const format = new Intl.DateTimeFormat(undefined, {
    timeZone: summary.timeZone,
    month: "short",
    day: "numeric",
  });
  context.fillText(
    `${format.format(summary.start)} to ${format.format(summary.end - 1)} · aurral.org`,
    70,
    1850,
  );
  const blob = await new Promise<Blob>((resolve, reject) =>
    canvas.toBlob(
      (blob) => (blob ? resolve(blob) : reject(new Error("Image export failed"))),
      "image/png",
    ),
  );
  return new File([blob], `aurral-wrapped-${summary.year}.png`, { type: "image/png" });
}

export function downloadWrappedFile(file: File) {
  const url = URL.createObjectURL(file);
  const link = document.createElement("a");
  link.href = url;
  link.download = file.name;
  link.click();
  setTimeout(() => URL.revokeObjectURL(url), 60_000);
}
