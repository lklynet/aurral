import { stat } from "node:fs/promises";
import { spawn } from "node:child_process";
import { parseFile } from "music-metadata";
import type { IncomingMessage, ServerResponse } from "node:http";
import { asAppError } from "../../lib/errors.ts";
import { sendAudioFile } from "./audioFileStream.ts";

const OUTPUT_FORMATS = {
  mp3: { codec: "libmp3lame", container: "mp3", contentType: "audio/mpeg", maxBitrate: 320 },
  opus: { codec: "libopus", container: "ogg", contentType: "audio/ogg", maxBitrate: 510 },
  aac: { codec: "aac", container: "adts", contentType: "audio/aac", maxBitrate: 512 },
};

type OutputFormat = keyof typeof OUTPUT_FORMATS;
export type SubsonicStreamFormat = "" | "raw" | OutputFormat;
type StreamOptions = { format: SubsonicStreamFormat; maxBitRate: number; timeOffset?: number };

const isMissing = (error: unknown) => {
  const code = asAppError(error)?.code;
  return code === "ENOENT" || code === "ENOTDIR";
};

async function planAudio(filePath: string, { format, maxBitRate, timeOffset }: StreamOptions) {
  if (format === "raw" || (!format && !maxBitRate)) return "raw";
  if (!format) {
    try {
      const metadata = await parseFile(filePath, { skipCovers: true });
      if (metadata.format.bitrate && maxBitRate * 1000 >= metadata.format.bitrate) return "raw";
    } catch (error) {
      if (isMissing(error)) return "missing";
    }
  }
  try {
    if (!(await stat(filePath)).isFile()) return "missing";
  } catch (error) {
    if (isMissing(error)) return "missing";
    throw error;
  }
  const output = OUTPUT_FORMATS[format || "mp3"];
  const bitrate = Math.min(maxBitRate || 192, output.maxBitrate);
  const args = ["-hide_banner", "-loglevel", "error", "-nostdin"];
  if (timeOffset) args.push("-ss", String(timeOffset));
  args.push(
    "-i",
    filePath,
    "-map",
    "0:a:0",
    "-vn",
    "-c:a",
    output.codec,
    "-b:a",
    `${bitrate}k`,
    "-f",
    output.container,
    "pipe:1",
  );
  return { args, contentType: output.contentType };
}

export async function streamSubsonicAudio(
  req: IncomingMessage,
  res: ServerResponse,
  filePath: string,
  options: StreamOptions,
) {
  const plan = await planAudio(filePath, options);
  if (plan === "raw") return sendAudioFile(req, res, filePath);
  if (plan === "missing") return false;
  if (req.method === "HEAD") {
    res.writeHead(200, { "Content-Type": plan.contentType }).end();
    return true;
  }
  const child = spawn("ffmpeg", plan.args, { stdio: ["ignore", "pipe", "pipe"] });
  let spawnError: NodeJS.ErrnoException | undefined;
  child.on("error", (error) => {
    spawnError = error;
  });
  const stop = () => {
    child.stdout.destroy();
    if (child.exitCode == null && child.signalCode == null) child.kill("SIGTERM");
  };
  res.once("close", stop);
  child.stderr.resume();
  res.setHeader("Content-Type", plan.contentType);
  child.stdout.pipe(res, { end: false });
  const code = await new Promise<number | null>((resolve) => child.once("close", resolve));
  res.off("close", stop);
  if (res.destroyed) return true;
  if (code === 0 && res.headersSent) {
    res.end();
  } else if (res.headersSent) {
    res.destroy();
  } else {
    res.statusCode = spawnError?.code === "ENOENT" ? 503 : 500;
    res.setHeader("Content-Type", "text/plain; charset=utf-8");
    res.end("Audio transcoding unavailable");
  }
  return true;
}
