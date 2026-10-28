import { useSyncExternalStore } from "react";
import { getPaintedThemeMode, subscribeToTheme } from "../utils/theme.ts";

const OCTOBER = 9;

export function useSiteLogo() {
  const mode = useSyncExternalStore(subscribeToTheme, getPaintedThemeMode);
  return new Date().getMonth() === OCTOBER ? `/arralogo-halloween-${mode}.svg` : "/arralogo.svg";
}
