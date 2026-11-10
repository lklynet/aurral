import * as v from "valibot";
import {
  LIDARR_CONVERSION_REPORT_KEY,
  lidarrConversionReport,
} from "../config/lidarr-conversion.ts";
import { dbOps } from "../db/helpers/index.ts";
import { libraryManager } from "./libraryManager.ts";

const storedReport = () =>
  dbOps.getJSONSetting(LIDARR_CONVERSION_REPORT_KEY, lidarrConversionReport);

const describe = (report: v.InferOutput<typeof lidarrConversionReport> | null) =>
  report && { folders: report.folders, artistCount: report.artistIds.length };

// The conversion writes its report before the server starts and only a
// dismissal removes it, so the app shell reads it from memory.
let pending = describe(storedReport());

export const pendingLidarrConversion = () => pending;

export function dismissLidarrConversionReport({ monitorArtists }: { monitorArtists: boolean }) {
  const report = storedReport();
  const monitoredArtists =
    report && monitorArtists ? libraryManager.monitorArtistsWithDefaults(report.artistIds) : 0;
  dbOps.setJSONSetting(LIDARR_CONVERSION_REPORT_KEY, null);
  pending = null;
  return { monitoredArtists };
}
