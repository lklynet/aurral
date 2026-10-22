import { forwardRef } from "react";
import Tooltip from "./Tooltip";

const TooltipButton = forwardRef(function TooltipButton(
  {
    label,
    children,
    className = "",
    type = "button",
    disabled = false,
    title: tooltipTitle,
    tooltipPlacement,
    "aria-label": ariaLabel,
    ...buttonProps
  },
  ref,
) {
  const tooltipLabel = tooltipTitle ?? label;

  return (
    <Tooltip content={tooltipLabel} placement={tooltipPlacement}>
      <button
        {...buttonProps}
        ref={ref}
        type={type}
        className={className}
        disabled={disabled}
        aria-label={ariaLabel ?? tooltipLabel}
      >
        {children}
      </button>
    </Tooltip>
  );
});

export default TooltipButton;
