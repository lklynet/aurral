import type { ShareManifest } from "../../../lib/shareManifest.ts";

export const SHARE_ORIGIN = "https://aurral.org";
const PENDING_SHARE_KEY = "aurral:pending-share-import";

export function rememberShareImport() {
  try {
    sessionStorage.removeItem(PENDING_SHARE_KEY);
    const params = new URLSearchParams(window.location.search);
    const url = params.get("url");
    if (window.location.pathname.endsWith("/share/import") && url) {
      const next = new URLSearchParams({ url });
      const action = params.get("action");
      if (action === "open" || action === "details" || action === "files" || action === "import")
        next.set("action", action);
      sessionStorage.setItem(PENDING_SHARE_KEY, `/share/import?${next}`);
    }
  } catch {}
}

export function consumeShareImport() {
  try {
    const url = sessionStorage.getItem(PENDING_SHARE_KEY);
    sessionStorage.removeItem(PENDING_SHARE_KEY);
    if (!url) return null;
    return url.startsWith("/share/import?") ? url : `/share/import?url=${encodeURIComponent(url)}`;
  } catch {
    return null;
  }
}

export type ShareKind = ShareManifest["kind"];
export type ShareItem = { kind: ShareKind } & Record<string, unknown>;

const copyWithSelection = (text: string) => {
  if (typeof document === "undefined" || typeof document.execCommand !== "function") return false;
  const field = document.createElement("textarea");
  field.value = text;
  field.setAttribute("readonly", "");
  field.style.position = "fixed";
  field.style.opacity = "0";
  document.body.appendChild(field);
  field.select();
  try {
    return document.execCommand("copy");
  } catch {
    return false;
  } finally {
    field.remove();
  }
};

export async function shareLink(url: string, title: string) {
  const nav = typeof navigator === "undefined" ? null : navigator;
  if (typeof nav?.share === "function") {
    try {
      await nav.share({ title, url });
      return "shared";
    } catch (error) {
      if (error instanceof Error && error.name === "AbortError") return "cancelled";
    }
  }
  if (typeof nav?.clipboard?.writeText === "function") {
    try {
      await nav.clipboard.writeText(url);
      return "copied";
    } catch {}
  }
  if (copyWithSelection(url)) return "copied";
  throw new Error("Could not copy the share link");
}
