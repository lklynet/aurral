export function stackToast<Toast extends { duration: number }>(
  toasts: Toast[],
  toast: Toast,
  max: number,
) {
  const next = [toast, ...toasts];
  const overflow = next.length - max;
  const evicted =
    overflow > 0 ? next.filter((entry) => entry.duration !== Infinity).slice(-overflow) : [];
  return { kept: next.filter((entry) => !evicted.includes(entry)), evicted };
}
