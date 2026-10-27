import fs from "node:fs/promises";
import { createWriteStream } from "node:fs";
import path from "node:path";
import { Readable, Transform } from "node:stream";
import type { ReadableStream as NodeReadableStream } from "node:stream/web";
import { pipeline } from "node:stream/promises";
import { parseFile } from "music-metadata";
import { resolveAurralDataDir } from "../../config/data-dir.ts";
import { resolveDownloadRoot } from "../downloadPaths.ts";
import {
  buildTrackFileName,
  commitDownloadedFile,
  joinUnderRoot,
  writeAudioMetadata,
} from "../downloadUtils.ts";
import { downloadTracker } from "../downloadJobs/downloadTracker.ts";
import {
  isPipelinePayloadActive,
  withPipelineCommitLock,
} from "../downloadJobs/downloadCancellation.ts";
import { finalizePipelineJobSuccess } from "../pipelineHelpers.ts";
import type { PipelinePayload } from "../downloadPipeline.ts";
import { getShareDownload } from "./downloadStore.ts";
import { loadRemoteShare } from "./remote.ts";
import { UnsupportedTagFormatError } from "../audioTags.ts";

const FORMATS = new Set([
  "flac",
  "mp3",
  "mp4",
  "m4a",
  "ogg",
  "oga",
  "opus",
  "wav",
  "aac",
  "aiff",
  "aif",
  "wma",
  "webm",
  "ape",
  "wv",
]);

export async function processShareDownload(payload: PipelinePayload) {
  const job = downloadTracker.getJob(payload.jobId);
  const share = getShareDownload(payload.jobId);
  if (!job || !share || !isPipelinePayloadActive(payload)) return null;
  const remote = await loadRemoteShare(share.share_url);
  const file = remote.files?.tracks.find((track) => track.path === share.track_path);
  if (!remote.files || !file)
    throw new Error(
      "The sender's file is unavailable or downloads are no longer allowed. Retry when the share is online.",
    );
  const format = file.format || "";
  if (!FORMATS.has(format)) throw new Error("The shared file has an unsupported audio format.");
  downloadTracker.setDownloading(job.id);
  const directory = path.join(resolveAurralDataDir(), "share-downloads", job.id);
  const stagingPath = path.join(directory, `track.${format}`);
  try {
    await fs.mkdir(directory, { recursive: true });
    const response = await fetch(`${remote.files.base}/${share.track_path}/download`, {
      redirect: "manual",
      signal: AbortSignal.timeout(15 * 60 * 1000),
    });
    if (!response.ok || !response.body)
      throw new Error("The shared file could not be downloaded. Retry when the share is online.");
    let bytes = 0;
    const limit = new Transform({
      transform(chunk: Buffer, _encoding, done) {
        bytes += chunk.length;
        if (!isPipelinePayloadActive(payload))
          return done(new Error("The shared file transfer was cancelled."));
        if (bytes > 2 * 1024 ** 3)
          return done(new Error("The shared file exceeds the 2 GB import limit."));
        done(null, chunk);
      },
    });
    await pipeline(
      Readable.fromWeb(response.body as NodeReadableStream<Uint8Array>),
      limit,
      createWriteStream(stagingPath),
    );
    if (!bytes || (file.size !== null && bytes !== file.size))
      throw new Error("The shared file transfer was incomplete. Retry the download.");
    const metadata = await parseFile(stagingPath);
    if (!metadata.format.codec || !metadata.format.duration)
      throw new Error("The shared file is not a readable audio file.");
    const result = await withPipelineCommitLock(payload, async () => {
      try {
        await writeAudioMetadata(stagingPath, job);
      } catch (error) {
        if (!(error instanceof UnsupportedTagFormatError)) throw error;
      }
      const finalDirectory = joinUnderRoot(resolveDownloadRoot(), payload.destination || "");
      const finalPath = await commitDownloadedFile(
        stagingPath,
        path.join(finalDirectory, buildTrackFileName(job, `.${format}`)),
      );
      return finalizePipelineJobSuccess({ downloadTracker, job, committedFinalPath: finalPath });
    });
    return result.cancelled ? null : result.result;
  } finally {
    await fs.rm(directory, { recursive: true, force: true });
  }
}
