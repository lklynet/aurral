import type { ToastItem } from "../components/Toast.tsx";

const repeats = (a: ToastItem, b: ToastItem) =>
  !a.action &&
  !a.onClose &&
  !b.action &&
  !b.onClose &&
  a.type === b.type &&
  a.title === b.title &&
  a.message === b.message;

export function stackToast(toasts: ToastItem[], toast: ToastItem, max: number) {
  const next = [toast, ...toasts.filter((entry) => !repeats(entry, toast))];
  const overflow = next.length - max;
  const evicted =
    overflow > 0 ? next.filter((entry) => entry.duration !== Infinity).slice(-overflow) : [];
  return { kept: next.filter((entry) => !evicted.includes(entry)), evicted };
}
