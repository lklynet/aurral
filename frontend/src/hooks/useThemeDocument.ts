import { useSyncExternalStore } from "react";
import { getThemeDocument, subscribeToTheme } from "../utils/theme.ts";

export function useThemeDocument() {
  return useSyncExternalStore(subscribeToTheme, getThemeDocument);
}
