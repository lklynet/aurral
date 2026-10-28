import { useSyncExternalStore } from "react";
import { getPaintedThemeMode, subscribeToTheme } from "../utils/theme.ts";

const OCTOBER = 9;

export function useSiteLogo() {
  const mode = useSyncExternalStore(subscribeToTheme, getPaintedThemeMode);
  return new Date().getMonth() === OCTOBER
    ? { src: `/arralogo-halloween-${mode}.svg`, className: " site-logo--pumpkin" }
    : { src: "/arralogo.svg", className: "" };
}
