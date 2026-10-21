import { isValidElement, type ReactNode } from "react";

export function hasAccessibleTextContent(children: ReactNode): boolean {
  if (typeof children === "string" || typeof children === "number") {
    return String(children).trim().length > 0;
  }

  if (Array.isArray(children)) return children.some(hasAccessibleTextContent);
  if (
    !isValidElement<{ "aria-hidden"?: unknown; children?: ReactNode }>(children) ||
    children.props["aria-hidden"] === true ||
    children.props["aria-hidden"] === "true"
  ) {
    return false;
  }
  return hasAccessibleTextContent(children.props.children);
}

interface TooltipDescribedByOptions {
  existingDescribedBy?: string;
  tooltipId: string;
  isVisible: boolean;
  tooltipProvidesLabel: boolean;
}

export function getTooltipDescribedBy({
  existingDescribedBy,
  tooltipId,
  isVisible,
  tooltipProvidesLabel,
}: TooltipDescribedByOptions) {
  const descriptions = [existingDescribedBy];
  if (isVisible && !tooltipProvidesLabel) descriptions.push(tooltipId);
  return descriptions.filter(Boolean).join(" ") || undefined;
}
