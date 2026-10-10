import { useCallback } from "react";
import { useShareContext } from "../contexts/ShareContext";
import { useToast } from "../contexts/ToastContext";
import { buildShareUrl, shareLink } from "../utils/shareLink";

export function useShareAction() {
  const { showSuccess, showError } = useToast();

  return useCallback(
    async (item, label) => {
      const url = buildShareUrl(item);
      if (!url) {
        showError(`${label} is missing the name needed to share it.`);
        return;
      }
      try {
        const outcome = await shareLink(url, label);
        if (outcome === "copied") showSuccess(`Copied a share link for ${label}`);
      } catch {
        showError({
          message: "Could not copy the share link. Open it and copy the address instead.",
          action: { label: "Open link", onClick: () => window.open(url, "_blank", "noopener") },
          duration: 8000,
        });
      }
    },
    [showError, showSuccess],
  );
}

export function useLibraryShareAction() {
  return useShareContext().openShare;
}
