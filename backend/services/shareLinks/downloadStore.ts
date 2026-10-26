import { db } from "../../config/db-sqlite.ts";
import type { ShareDownloadsRow } from "../../db/rows.ts";

export const getShareDownload = (jobId: string) =>
  db
    .prepare<[string], ShareDownloadsRow>("SELECT * FROM share_downloads WHERE job_id = ?")
    .get(jobId);

export function hasShareDownloads() {
  return Boolean(
    db
      .prepare(`SELECT 1 FROM share_downloads AS share
    JOIN playlist_download_jobs AS job ON job.id = share.job_id
    WHERE job.status IN ('pending', 'downloading') LIMIT 1`)
      .get(),
  );
}

export function saveShareDownload(jobId: string, url: string, trackPath: string) {
  db.prepare("INSERT INTO share_downloads (job_id, share_url, track_path) VALUES (?, ?, ?)").run(
    jobId,
    url,
    trackPath,
  );
}
