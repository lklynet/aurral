import { useSyncExternalStore } from "react";
import { getThemeDocument, subscribeToTheme } from "../utils/theme.js";

export function useThemeDocument() {
  return useSyncExternalStore(subscribeToTheme, getThemeDocument);
}
