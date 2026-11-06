import { useSyncExternalStore } from "react";
import { useOptionalAuth } from "../contexts/AuthContext";

type UserId = number | null | undefined;

export function userToggle(name: string, fallback: boolean) {
  const event = `aurral:${name}`;
  const storageKey = (userId: UserId) => `${name}:${userId ?? "anonymous"}`;

  const read = (userId: UserId) => {
    try {
      const value = window.localStorage.getItem(storageKey(userId));
      return value === null ? fallback : value === "true";
    } catch {
      return fallback;
    }
  };

  const subscribe = (onChange: () => void) => {
    window.addEventListener(event, onChange);
    window.addEventListener("storage", onChange);
    return () => {
      window.removeEventListener(event, onChange);
      window.removeEventListener("storage", onChange);
    };
  };

  const set = (userId: UserId, enabled: boolean) => {
    try {
      window.localStorage.setItem(storageKey(userId), String(enabled));
    } catch {}
    window.dispatchEvent(new Event(event));
  };

  const use = () => {
    const userId = useOptionalAuth()?.user?.id;
    return useSyncExternalStore(
      subscribe,
      () => read(userId),
      () => fallback,
    );
  };

  return { set, use };
}
