import { createPortal } from "react-dom";
import { forwardRef, useCallback, useEffect, useRef, useState } from "react";

const TooltipButton = forwardRef(function TooltipButton(
  {
    label,
    children,
    className = "",
    type = "button",
    disabled = false,
    title: tooltipTitle,
    "aria-label": ariaLabel,
    onFocus: onButtonFocus,
    onBlur: onButtonBlur,
    onPointerEnter: onButtonPointerEnter,
    onPointerLeave: onButtonPointerLeave,
    ...buttonProps
  },
  ref,
) {
  const tooltipLabel = tooltipTitle ?? label;
  const buttonRef = useRef(null);
  const tooltipRef = useRef(null);
  const [tooltipPosition, setTooltipPosition] = useState(null);
  const [isTooltipVisible, setIsTooltipVisible] = useState(false);

  const setButtonRef = useCallback(
    (node) => {
      buttonRef.current = node;
      if (typeof ref === "function") ref(node);
      else if (ref) ref.current = node;
    },
    [ref],
  );

  const updateTooltipPosition = useCallback(() => {
    const button = buttonRef.current;
    const tooltip = tooltipRef.current;
    if (!button || !tooltip) return;

    const buttonRect = button.getBoundingClientRect();
    const tooltipWidth = tooltip.offsetWidth;
    const tooltipHeight = tooltip.offsetHeight;
    const edge = 8;
    const gap = 8;
    const rightPosition = buttonRect.right + gap;
    const leftPosition = buttonRect.left - gap - tooltipWidth;
    const maxLeft = Math.max(edge, window.innerWidth - tooltipWidth - edge);
    const left =
      rightPosition + tooltipWidth <= window.innerWidth - edge
        ? rightPosition
        : leftPosition >= edge
          ? leftPosition
          : Math.min(Math.max(edge, rightPosition), maxLeft);
    const centerY = buttonRect.top + buttonRect.height / 2;
    const minTop = edge + tooltipHeight / 2;
    const maxTop = Math.max(minTop, window.innerHeight - edge - tooltipHeight / 2);
    const top = Math.min(Math.max(minTop, centerY), maxTop);

    setTooltipPosition({ left: `${left}px`, top: `${top}px` });
  }, []);

  const showTooltip = useCallback(() => {
    updateTooltipPosition();
    setIsTooltipVisible(true);
  }, [updateTooltipPosition]);

  useEffect(() => {
    if (!isTooltipVisible) return undefined;

    const handleViewportChange = () => updateTooltipPosition();
    window.addEventListener("resize", handleViewportChange);
    window.addEventListener("scroll", handleViewportChange, true);
    return () => {
      window.removeEventListener("resize", handleViewportChange);
      window.removeEventListener("scroll", handleViewportChange, true);
    };
  }, [isTooltipVisible, updateTooltipPosition]);

  return (
    <>
      <button
        {...buttonProps}
        ref={setButtonRef}
        type={type}
        className={className}
        disabled={disabled}
        aria-label={ariaLabel ?? tooltipLabel}
        onFocus={(event) => {
          onButtonFocus?.(event);
          showTooltip();
        }}
        onBlur={(event) => {
          onButtonBlur?.(event);
          setIsTooltipVisible(false);
        }}
        onPointerEnter={(event) => {
          onButtonPointerEnter?.(event);
          showTooltip();
        }}
        onPointerLeave={(event) => {
          onButtonPointerLeave?.(event);
          setIsTooltipVisible(false);
        }}
      >
        {children}
      </button>
      {typeof document !== "undefined"
        ? createPortal(
            <span
              ref={tooltipRef}
              className="aurral-tooltip"
              role="tooltip"
              aria-hidden="true"
              style={{
                ...tooltipPosition,
                opacity: isTooltipVisible ? 1 : 0,
                visibility: isTooltipVisible ? "visible" : "hidden",
              }}
            >
              {tooltipLabel}
            </span>,
            document.body,
          )
        : null}
    </>
  );
});

export default TooltipButton;
