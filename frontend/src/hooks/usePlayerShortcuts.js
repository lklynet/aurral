import { useEffect, useRef } from "react";

export const PLAYER_SHORTCUTS = {
  playPause: { keys: "Space", label: "Space" },
  previous: { keys: "Shift+ArrowLeft", label: "Shift+←" },
  next: { keys: "Shift+ArrowRight", label: "Shift+→" },
  seek: { keys: "ArrowLeft ArrowRight", label: "← →" },
  mute: { keys: "M", label: "M" },
};

const KEY_HANDLERS = [
  "input",
  "textarea",
  "select",
  "[contenteditable]:not([contenteditable='false'])",
  "[role='dialog']",
  "[role='alertdialog']",
  "[role='menu']",
  "[role='menubar']",
  "[role='listbox']",
  "[role='combobox']",
  "[role='slider']",
  "[role='spinbutton']",
  "[role='tablist']",
  "[role='radiogroup']",
  "[role='grid']",
  "[role='tree']",
  "[aria-roledescription='sortable']",
].join(",");

const SPACE_ACTIVATED = [
  "button",
  "a[href]",
  "summary",
  "[role='button']",
  "[role='link']",
  "[role='checkbox']",
  "[role='switch']",
  "[role='tab']",
  "[role='radio']",
  "[role='option']",
  "[role='menuitem']",
].join(",");

function scrollsSideways(element) {
  if (!element || element === document.body || element === document.documentElement) return false;
  if (element.scrollWidth <= element.clientWidth) return false;
  return ["auto", "scroll"].includes(window.getComputedStyle(element).overflowX);
}

function shortcutFor(event) {
  if (event.defaultPrevented || event.isComposing) return null;
  if (event.ctrlKey || event.metaKey || event.altKey) return null;
  const target = event.target instanceof Element ? event.target : null;
  if (target?.closest(KEY_HANDLERS)) return null;
  if (document.querySelector("[aria-modal='true']")) return null;

  if (event.key === " ") {
    if (event.shiftKey || event.repeat || target?.closest(SPACE_ACTIVATED)) return null;
    return "playPause";
  }
  if (event.key === "ArrowLeft" || event.key === "ArrowRight") {
    if (event.shiftKey) {
      if (event.repeat) return null;
      return event.key === "ArrowLeft" ? "previous" : "next";
    }
    if (scrollsSideways(target)) return null;
    return event.key === "ArrowLeft" ? "seekBack" : "seekForward";
  }
  if ((event.key === "m" || event.key === "M") && !event.shiftKey && !event.repeat) return "mute";
  return null;
}

export function usePlayerShortcuts(enabled, actions) {
  const actionsRef = useRef(actions);
  actionsRef.current = actions;

  useEffect(() => {
    if (!enabled) return undefined;
    const handleKeyDown = (event) => {
      const shortcut = shortcutFor(event);
      if (!shortcut) return;
      event.preventDefault();
      actionsRef.current[shortcut]?.();
    };
    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [enabled]);
}
