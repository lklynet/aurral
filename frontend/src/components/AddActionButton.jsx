import { createPortal } from "react-dom";
import { forwardRef, useCallback, useEffect, useRef, useState } from "react";
import { Loader, Plus } from "lucide-react";

const AddActionButton = forwardRef(function AddActionButton(
  {
    label = "Add to Lidarr",
    icon: Icon = Plus,
    isLoading = false,
    disabled = false,
    className = "",
    type = "button",
    ...buttonProps
  },
  ref,
) {
  const {
    title: tooltipTitle,
    "aria-label": ariaLabel,
    onFocus: onButtonFocus,
    onBlur: onButtonBlur,
    onPointerEnter: onButtonPointerEnter,
    onPointerLeave: onButtonPointerLeave,
    ...restButtonProps
  } = buttonProps;
  const tooltipLabel = tooltipTitle ?? label;
  const classes = ["btn", "btn-add-action", className].filter(Boolean).join(" ");
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
        {...restButtonProps}
        ref={setButtonRef}
        type={type}
        className={classes}
        disabled={disabled || isLoading}
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
        <span className="btn-add-action__icon">
          {isLoading ? (
            <Loader className="animate-spin" aria-hidden="true" />
          ) : (
            <Icon aria-hidden="true" />
          )}
        </span>
      </button>
      {typeof document !== "undefined"
        ? createPortal(
            <span
              ref={tooltipRef}
              className="btn-add-action__tooltip"
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

export default AddActionButton;
