import type { Response } from "express";
import { logger } from "../../services/logger.ts";
import { asAppError } from "../../../lib/errors.ts";

export const sendSSE = (res: Response & { flush?: () => void }, event: string, data: unknown) => {
  try {
    res.write(`event: ${event}\n`);
    res.write(`data: ${JSON.stringify(data)}\n\n`);
    if (res.flush && typeof res.flush === "function") {
      res.flush();
    }
  } catch (err) {
    const failure = asAppError(err);
    logger.error("sse", `Error sending event ${event}:`, { message: failure?.message });
  }
};

export const queryText = (value: unknown) => (typeof value === "string" ? value.trim() : "");

export const pendingArtistRequests = new Map();

export const buildArtistRequestKey = ({
  mbid,
  mode = "full",
  selectedReleaseTypes = null,
  appearsOnLimit = null,
}: {
  mbid: string;
  mode?: string;
  selectedReleaseTypes?: string[] | null;
  appearsOnLimit?: number | null;
}) => {
  const releaseTypesKey = Array.isArray(selectedReleaseTypes)
    ? [...selectedReleaseTypes].filter(Boolean).sort().join(",")
    : "";
  const limitValue = Number.parseInt(String(appearsOnLimit), 10);
  const limitKey = Number.isFinite(limitValue) && limitValue > 0 ? String(limitValue) : "";
  return [String(mbid || "").trim(), mode, releaseTypesKey, limitKey].join(":");
};
