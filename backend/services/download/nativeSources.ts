import { qbittorrentSource } from "../qbittorrentSource.ts";

export const nativeDownloadSource = (id: string | null | undefined) =>
  [qbittorrentSource].find((source) => source.id === id) ?? null;
