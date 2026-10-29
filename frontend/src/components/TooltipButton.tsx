import { forwardRef, type ComponentPropsWithoutRef } from "react";
import Tooltip from "./Tooltip";

type TooltipButtonProps = ComponentPropsWithoutRef<"button"> & {
  label?: string;
  tooltipPlacement?: "side" | "top";
};

const TooltipButton = forwardRef<HTMLButtonElement, TooltipButtonProps>(function TooltipButton(
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
    <Tooltip content={tooltipLabel} placement={tooltipPlacement} delay={1000}>
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
