import { stat } from "node:fs/promises";
import { spawn } from "node:child_process";
import { parseFile } from "music-metadata";
import { streamAudioFile } from "./audioFileStream.js";

const OUTPUT_FORMATS = {
  mp3: { codec: "libmp3lame", container: "mp3", contentType: "audio/mpeg", maxBitrate: 320 },
  opus: { codec: "libopus", container: "ogg", contentType: "audio/ogg", maxBitrate: 510 },
  aac: { codec: "aac", container: "adts", contentType: "audio/aac", maxBitrate: 512 },
};

export async function streamSubsonicAudio(res, filePath, { format, maxBitRate, timeOffset }) {
  if (format === "raw" || (!format && !maxBitRate)) return streamAudioFile(res, filePath);
  if (!format) {
    try {
      const metadata = await parseFile(filePath, { skipCovers: true });
      if (metadata.format.bitrate && maxBitRate * 1000 >= metadata.format.bitrate) {
        return streamAudioFile(res, filePath);
      }
    } catch (error) {
      if (error.code === "ENOENT" || error.code === "ENOTDIR") return false;
    }
  }
  try {
    if (!(await stat(filePath)).isFile()) return false;
  } catch (error) {
    if (error.code === "ENOENT" || error.code === "ENOTDIR") return false;
    throw error;
  }
  const output = OUTPUT_FORMATS[format || "mp3"];
  const bitrate = Math.min(maxBitRate || 192, output.maxBitrate);
  const args = ["-hide_banner", "-loglevel", "error", "-nostdin"];
  if (timeOffset) args.push("-ss", String(timeOffset));
  args.push("-i", filePath, "-map", "0:a:0", "-vn", "-c:a", output.codec,
    "-b:a", `${bitrate}k`, "-f", output.container, "pipe:1");

  return new Promise((resolve) => {
    const child = spawn("ffmpeg", args, { stdio: ["ignore", "pipe", "pipe"] });
    let spawnError;
    const stop = () => {
      child.stdout.destroy();
      if (child.exitCode == null && child.signalCode == null) child.kill("SIGTERM");
    };
    res.once("close", stop);
    child.stderr.resume();
    child.on("error", (error) => { spawnError = error; });
    res.set("Content-Type", output.contentType);
    child.stdout.pipe(res, { end: false });
    child.once("close", (code) => {
      res.off("close", stop);
      if (res.destroyed) return resolve(true);
      if (code === 0 && res.headersSent) {
        res.end();
      } else if (res.headersSent) {
        res.destroy();
      } else {
        res.status(spawnError?.code === "ENOENT" ? 503 : 500)
          .type("text/plain").send("Audio transcoding unavailable");
      }
      resolve(true);
    });
  });
}
