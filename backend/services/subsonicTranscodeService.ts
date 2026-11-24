import { stat } from "node:fs/promises";
import path from "node:path";
import { spawn } from "node:child_process";
import { parseFile } from "music-metadata";
import * as v from "valibot";
import type { IncomingMessage, ServerResponse } from "node:http";
import { asAppError } from "../../lib/errors.ts";
import { sendAudioFile } from "./audioFileStream.ts";
import { flacCopy } from "./flacCache.ts";
import { logger } from "./logger.ts";

const OUTPUT_FORMATS = {
  mp3: { codec: "libmp3lame", container: "mp3", contentType: "audio/mpeg", maxBitrate: 320 },
  opus: { codec: "libopus", container: "ogg", contentType: "audio/ogg", maxBitrate: 510 },
  aac: { codec: "aac", container: "adts", contentType: "audio/aac", maxBitrate: 512 },
  flac: { codec: "flac", container: "flac", contentType: "audio/flac", maxBitrate: 0 },
};

export const streamFormat = v.pipe(
  v.string(),
  v.toLowerCase(),
  v.picklist(["", "raw", "mp3", "opus", "aac", "flac"]),
);
export const streamBitRate = v.pipe(
  v.string(),
  v.regex(/^\d*$/),
  v.transform(Number),
  v.check((kbps) => Number.isSafeInteger(kbps) && (kbps === 0 || kbps >= 8)),
);
export const streamOffset = v.pipe(
  v.string(),
  v.transform(Number),
  v.check((seconds) => Number.isFinite(seconds) && seconds >= 0),
);
export const streamQuery = v.object({
  format: v.optional(streamFormat, ""),
  maxBitRate: v.optional(streamBitRate, ""),
  timeOffset: v.optional(streamOffset, ""),
});

type StreamOptions = {
  format: v.InferOutput<typeof streamFormat>;
  maxBitRate: number;
  timeOffset?: number;
};

const isMissing = (error: unknown) => {
  const code = asAppError(error)?.code;
  return code === "ENOENT" || code === "ENOTDIR";
};

async function planAudio(filePath: string, { format, maxBitRate, timeOffset }: StreamOptions) {
  if (format === "raw" || (!format && !maxBitRate)) return "raw";
  if (!format) {
    try {
      const sourceBitrate =
        (await parseFile(filePath, { skipCovers: true })).format.bitrate ||
        (await parseFile(filePath, { skipCovers: true, duration: true })).format.bitrate;
      if (sourceBitrate && maxBitRate * 1000 >= sourceBitrate) return "raw";
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
  if (format === "flac" && !timeOffset) {
    return path.extname(filePath).toLowerCase() === ".flac" ? "raw" : "flac";
  }
  const output = OUTPUT_FORMATS[format || "mp3"];
  const args = ["-hide_banner", "-loglevel", "error", "-nostdin"];
  if (timeOffset) args.push("-ss", String(timeOffset));
  args.push("-i", filePath, "-map", "0:a:0", "-vn", "-c:a", output.codec);
  if (output.maxBitrate) args.push("-b:a", `${Math.min(maxBitRate || 192, output.maxBitrate)}k`);
  args.push("-f", output.container, "pipe:1");
  return { args, contentType: output.contentType };
}

function sendTranscodeFailure(res: ServerResponse, error?: unknown) {
  res.statusCode = asAppError(error)?.code === "ENOENT" ? 503 : 500;
  res.setHeader("Content-Type", "text/plain; charset=utf-8");
  res.end("Audio transcoding unavailable");
  return true;
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
  if (plan === "flac") {
    const copy = await flacCopy(filePath).catch((error: unknown) => error);
    if (typeof copy !== "string") {
      logger.warn("library", "Could not convert a track to FLAC for playback", {
        path: filePath,
        error: asAppError(copy)?.message,
      });
      return sendTranscodeFailure(res, copy);
    }
    return sendAudioFile(req, res, copy, filePath);
  }
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
    sendTranscodeFailure(res, spawnError);
  }
  return true;
}
