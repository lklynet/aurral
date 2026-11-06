import { useSyncExternalStore } from "react";
import { useOptionalAuth } from "../contexts/AuthContext";

const NAV_BETA_EVENT = "aurral:nav-beta";

const storageKey = (userId: number | null | undefined) => `nav-beta:${userId ?? "anonymous"}`;

const readNavBeta = (userId: number | null | undefined) => {
  try {
    return window.localStorage.getItem(storageKey(userId)) === "true";
  } catch {
    return false;
  }
};

const subscribe = (onChange: () => void) => {
  window.addEventListener(NAV_BETA_EVENT, onChange);
  window.addEventListener("storage", onChange);
  return () => {
    window.removeEventListener(NAV_BETA_EVENT, onChange);
    window.removeEventListener("storage", onChange);
  };
};

export function setNavBeta(userId: number | null | undefined, enabled: boolean) {
  try {
    window.localStorage.setItem(storageKey(userId), String(enabled));
  } catch {}
  window.dispatchEvent(new Event(NAV_BETA_EVENT));
}

export function useNavBeta() {
  const userId = useOptionalAuth()?.user?.id;
  return useSyncExternalStore(
    subscribe,
    () => readNavBeta(userId),
    () => false,
  );
}
