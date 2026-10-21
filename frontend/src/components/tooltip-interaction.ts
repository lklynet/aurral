type TooltipSource = "focus" | "pointer";

export function createTooltipInteractionState() {
  const activeSources = new Set<TooltipSource>();
  let dismissed = false;

  const isVisible = () => !dismissed && activeSources.size > 0;

  return {
    enter(source: TooltipSource) {
      activeSources.add(source);
      dismissed = false;
      return isVisible();
    },
    leave(source: TooltipSource) {
      activeSources.delete(source);
      return isVisible();
    },
    dismiss() {
      dismissed = true;
      return false;
    },
    isVisible,
  };
}
