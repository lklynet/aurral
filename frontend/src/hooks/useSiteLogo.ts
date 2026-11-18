import { useSyncExternalStore } from "react";
import { getPaintedThemeMode, subscribeToTheme } from "../utils/theme.ts";

const OCTOBER = 9;

export function useSiteLogo() {
  const mode = useSyncExternalStore(subscribeToTheme, getPaintedThemeMode);
  return new Date().getMonth() === OCTOBER
    ? {
        src: `${import.meta.env.BASE_URL}arralogo-halloween-${mode}.svg`,
        className: " site-logo--pumpkin",
      }
    : { src: `${import.meta.env.BASE_URL}arralogo.svg`, className: "" };
}
