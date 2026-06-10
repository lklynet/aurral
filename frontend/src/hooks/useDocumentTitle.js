import { useEffect } from "react";

const DEFAULT_TITLE = "Aurral";

export function useDocumentTitle(title) {
  useEffect(() => {
    const trimmed = title?.trim() || "";
    document.title = trimmed ? `${trimmed} - Aurral` : DEFAULT_TITLE;
    return () => {
      document.title = DEFAULT_TITLE;
    };
  }, [title]);
}
