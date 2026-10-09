import { useEffect } from "react";

const DEFAULT_TITLE = "Aurral";

let pageTitle = "";
let nowPlayingTitle = "";

function applyTitle() {
  document.title = nowPlayingTitle || (pageTitle ? `${pageTitle} - Aurral` : DEFAULT_TITLE);
}

export function useDocumentTitle(title) {
  useEffect(() => {
    pageTitle = title?.trim() || "";
    applyTitle();
    return () => {
      pageTitle = "";
      applyTitle();
    };
  }, [title]);
}

export function useNowPlayingTitle(title) {
  useEffect(() => {
    nowPlayingTitle = title?.trim() || "";
    applyTitle();
    return () => {
      nowPlayingTitle = "";
      applyTitle();
    };
  }, [title]);
}
