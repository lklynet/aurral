import { cloneElement, isValidElement, useCallback, useEffect, useId, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { getTooltipDescribedBy } from "./tooltip-accessibility.js";
import { createTooltipInteractionState } from "./tooltip-interaction.js";

function chainHandlers(current, next) {
  return (event) => {
    current?.(event);
    next(event);
  };
}

function hasTextContent(children) {
  if (typeof children === "string" || typeof children === "number") {
    return String(children).trim().length > 0;
  }

  if (Array.isArray(children)) return children.some(hasTextContent);
  if (!isValidElement(children) || children.props["aria-hidden"] === true) return false;
  return hasTextContent(children.props.children);
}

function needsTooltipLabel(element) {
  if (!isValidElement(element) || typeof element.type !== "string") return false;

  const { type, props } = element;
  const isControl =
    ["a", "button", "input", "select", "textarea"].includes(type) ||
    ["button", "checkbox", "link", "radio", "switch"].includes(props.role);
  if (!isControl) return false;

  return !(
    props["aria-label"] ||
    props["aria-labelledby"] ||
    props.alt ||
    hasTextContent(props.children)
  );
}

export default function Tooltip({ content, children }) {
  const tooltipId = useId();
  const tooltipRef = useRef(null);
  const triggerRef = useRef(null);
  const interactionRef = useRef(null);
  const [tooltipPosition, setTooltipPosition] = useState(null);
  const [isTooltipVisible, setIsTooltipVisible] = useState(false);

  if (!interactionRef.current) interactionRef.current = createTooltipInteractionState();

  const updateTooltipPosition = useCallback(() => {
    const trigger = triggerRef.current;
    const tooltip = tooltipRef.current;
    if (!trigger || !tooltip) return;

    const triggerRect = trigger.getBoundingClientRect();
    const tooltipWidth = tooltip.offsetWidth;
    const tooltipHeight = tooltip.offsetHeight;
    const edge = 8;
    const gap = 8;
    const rightPosition = triggerRect.right + gap;
    const leftPosition = triggerRect.left - gap - tooltipWidth;
    const maxLeft = Math.max(edge, window.innerWidth - tooltipWidth - edge);
    const left =
      rightPosition + tooltipWidth <= window.innerWidth - edge
        ? rightPosition
        : leftPosition >= edge
          ? leftPosition
          : Math.min(Math.max(edge, rightPosition), maxLeft);
    const centerY = triggerRect.top + triggerRect.height / 2;
    const minTop = edge + tooltipHeight / 2;
    const maxTop = Math.max(minTop, window.innerHeight - edge - tooltipHeight / 2);
    const top = Math.min(Math.max(minTop, centerY), maxTop);

    setTooltipPosition({ left: `${left}px`, top: `${top}px` });
  }, []);

  const showTooltip = useCallback((event, source) => {
    triggerRef.current = event.currentTarget;
    interactionRef.current.enter(source);
    updateTooltipPosition();
    setIsTooltipVisible(interactionRef.current.isVisible());
  }, [updateTooltipPosition]);

  const hideTooltip = useCallback((source) => {
    interactionRef.current.leave(source);
    setIsTooltipVisible(interactionRef.current.isVisible());
  }, []);

  const dismissTooltip = useCallback(() => {
    interactionRef.current.dismiss();
    setIsTooltipVisible(false);
  }, []);

  useEffect(() => {
    if (!isTooltipVisible) return undefined;

    const handleViewportChange = () => updateTooltipPosition();
    const handleKeyDown = (event) => {
      if (event.key === "Escape") dismissTooltip();
    };
    window.addEventListener("resize", handleViewportChange);
    window.addEventListener("scroll", handleViewportChange, true);
    window.addEventListener("keydown", handleKeyDown);
    return () => {
      window.removeEventListener("resize", handleViewportChange);
      window.removeEventListener("scroll", handleViewportChange, true);
      window.removeEventListener("keydown", handleKeyDown);
    };
  }, [dismissTooltip, isTooltipVisible, updateTooltipPosition]);

  if (!isValidElement(children) || content == null || content === "") return children;

  const needsLabel = needsTooltipLabel(children);
  const tooltipProvidesLabel =
    needsLabel || children.props["aria-label"] === String(content);
  const triggerProps = {
    "aria-describedby": getTooltipDescribedBy({
      existingDescribedBy: children.props["aria-describedby"],
      tooltipId,
      isVisible: isTooltipVisible,
      tooltipProvidesLabel,
    }),
    onBlur: chainHandlers(children.props.onBlur, () => hideTooltip("focus")),
    onFocus: chainHandlers(children.props.onFocus, (event) => showTooltip(event, "focus")),
    onPointerEnter: chainHandlers(children.props.onPointerEnter, (event) => showTooltip(event, "pointer")),
    onPointerLeave: chainHandlers(children.props.onPointerLeave, () => hideTooltip("pointer")),
  };

  if (needsLabel && content) triggerProps["aria-label"] = String(content);

  return (
    <>
      {cloneElement(children, triggerProps)}
      {typeof document !== "undefined"
        ? createPortal(
            <span
              ref={tooltipRef}
              id={tooltipId}
              className="aurral-tooltip"
              role="tooltip"
              aria-hidden={!isTooltipVisible}
              style={{
                ...tooltipPosition,
                opacity: isTooltipVisible ? 1 : 0,
                visibility: isTooltipVisible ? "visible" : "hidden",
              }}
            >
              {content}
            </span>,
            document.body,
          )
        : null}
    </>
  );
}
