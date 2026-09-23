export function getTooltipDescribedBy({
  existingDescribedBy,
  tooltipId,
  isVisible,
  tooltipProvidesLabel,
}) {
  const descriptions = [existingDescribedBy];
  if (isVisible && !tooltipProvidesLabel) descriptions.push(tooltipId);
  return descriptions.filter(Boolean).join(" ") || undefined;
}
