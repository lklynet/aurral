export function createTooltipInteractionState() {
  const activeSources = new Set();
  let dismissed = false;

  const isVisible = () => !dismissed && activeSources.size > 0;

  return {
    enter(source) {
      activeSources.add(source);
      dismissed = false;
      return isVisible();
    },
    leave(source) {
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
