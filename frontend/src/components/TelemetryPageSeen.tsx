import { useEffect, useRef } from "react";
import { useLocation } from "react-router";
import { telemetryPageForPath, type TelemetryPage } from "../../../lib/telemetry.ts";
import { useAuth } from "../contexts/AuthContext";
import { telemetryClient } from "../utils/api/clients/telemetry.ts";

const RESEND_AFTER_MS = 60 * 60 * 1000;

export default function TelemetryPageSeen() {
  const enabled = useAuth().bootstrap?.telemetry === true;
  const page = telemetryPageForPath(useLocation().pathname);
  const sentAt = useRef(new Map<TelemetryPage, number>());

  useEffect(() => {
    if (!enabled || !page) return;
    const now = Date.now();
    if (now - (sentAt.current.get(page) ?? 0) < RESEND_AFTER_MS) return;
    sentAt.current.set(page, now);
    const standalone = window.matchMedia("(display-mode: standalone)").matches;
    telemetryClient.seen.$post({ json: { page, standalone } }).catch(() => {});
  }, [enabled, page]);

  return null;
}
