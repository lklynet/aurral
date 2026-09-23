import { isValidElement } from "react";

export function hasAccessibleTextContent(children) {
  if (typeof children === "string" || typeof children === "number") {
    return String(children).trim().length > 0;
  }

  if (Array.isArray(children)) return children.some(hasAccessibleTextContent);
  if (
    !isValidElement(children) ||
    children.props["aria-hidden"] === true ||
    children.props["aria-hidden"] === "true"
  ) {
    return false;
  }
  return hasAccessibleTextContent(children.props.children);
}

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
