import {
  cloneElement,
  isValidElement,
  useCallback,
  useEffect,
  useId,
  useRef,
  useState,
  type FocusEvent,
  type PointerEvent,
  type ReactNode,
} from "react";
import { createPortal } from "react-dom";
import { getTooltipDescribedBy, hasAccessibleTextContent } from "./tooltip-accessibility.ts";
import { createTooltipInteractionState } from "./tooltip-interaction.ts";

type TooltipPlacement = "side" | "top";
type TooltipSource = "focus" | "pointer";

interface TriggerProps {
  "aria-label"?: string;
  "aria-labelledby"?: string;
  "aria-describedby"?: string;
  "aria-hidden"?: boolean | "true" | "false";
  alt?: string;
  role?: string;
  children?: ReactNode;
  onBlur?: (event: FocusEvent<HTMLElement>) => void;
  onFocus?: (event: FocusEvent<HTMLElement>) => void;
  onPointerDown?: (event: PointerEvent<HTMLElement>) => void;
  onPointerEnter?: (event: PointerEvent<HTMLElement>) => void;
  onPointerLeave?: (event: PointerEvent<HTMLElement>) => void;
}

function chainHandlers<E>(current: ((event: E) => void) | undefined, next: (event: E) => void) {
  return (event: E) => {
    current?.(event);
    next(event);
  };
}

function needsTooltipLabel(element: ReactNode) {
  if (!isValidElement<TriggerProps>(element) || typeof element.type !== "string") return false;

  const { type, props } = element;
  const isControl =
    ["a", "button", "input", "select", "textarea"].includes(type as string) ||
    (["button", "checkbox", "link", "radio", "switch"] as (string | undefined)[]).includes(
      props.role,
    );
  if (!isControl) return false;

  return !(
    props["aria-label"] ||
    props["aria-labelledby"] ||
    props.alt ||
    hasAccessibleTextContent(props.children)
  );
}

interface TooltipProps {
  content?: ReactNode;
  placement?: TooltipPlacement;
  delay?: number;
  children: ReactNode;
}

export default function Tooltip({
  content,
  placement = "side",
  delay = 0,
  children,
}: TooltipProps) {
  const tooltipId = useId();
  const tooltipRef = useRef<HTMLSpanElement | null>(null);
  const triggerRef = useRef<HTMLElement | null>(null);
  const interactionRef = useRef<ReturnType<typeof createTooltipInteractionState> | null>(null);
  const showTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const [tooltipPosition, setTooltipPosition] = useState<{ left: string; top: string } | null>(
    null,
  );
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
    const maxLeft = Math.max(edge, window.innerWidth - tooltipWidth - edge);

    if (placement === "top") {
      const centeredLeft = triggerRect.left + triggerRect.width / 2 - tooltipWidth / 2;
      const aboveTop = triggerRect.top - gap - tooltipHeight / 2;
      const belowTop = triggerRect.bottom + gap + tooltipHeight / 2;
      setTooltipPosition({
        left: `${Math.min(Math.max(edge, centeredLeft), maxLeft)}px`,
        top: `${aboveTop - tooltipHeight / 2 >= edge ? aboveTop : belowTop}px`,
      });
      return;
    }

    const rightPosition = triggerRect.right + gap;
    const leftPosition = triggerRect.left - gap - tooltipWidth;
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
  }, [placement]);

  const showTooltip = useCallback(
    (trigger: HTMLElement, source: TooltipSource) => {
      triggerRef.current = trigger;
      interactionRef.current!.enter(source);
      updateTooltipPosition();
      setIsTooltipVisible(interactionRef.current!.isVisible());
    },
    [updateTooltipPosition],
  );

  const cancelPendingShow = useCallback(() => {
    if (showTimerRef.current) clearTimeout(showTimerRef.current);
    showTimerRef.current = null;
  }, []);

  useEffect(() => cancelPendingShow, [cancelPendingShow]);

  const hideTooltip = useCallback((source: TooltipSource) => {
    interactionRef.current!.leave(source);
    setIsTooltipVisible(interactionRef.current!.isVisible());
  }, []);

  const dismissTooltip = useCallback(() => {
    interactionRef.current!.dismiss();
    setIsTooltipVisible(false);
  }, []);

  useEffect(() => {
    if (!isTooltipVisible) return undefined;

    const handleViewportChange = () => updateTooltipPosition();
    const handleKeyDown = (event: KeyboardEvent) => {
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

  if (!isValidElement<TriggerProps>(children) || content == null || content === "") return children;

  const needsLabel = needsTooltipLabel(children);
  const tooltipProvidesLabel = needsLabel || children.props["aria-label"] === String(content);
  const triggerProps: TriggerProps = {
    "aria-describedby": getTooltipDescribedBy({
      existingDescribedBy: children.props["aria-describedby"],
      tooltipId,
      isVisible: isTooltipVisible,
      tooltipProvidesLabel,
    }),
    onBlur: chainHandlers(children.props.onBlur, () => hideTooltip("focus")),
    onFocus: chainHandlers(children.props.onFocus, (event) => {
      if (event.target.matches(":focus-visible")) showTooltip(event.currentTarget, "focus");
    }),
    onPointerDown: chainHandlers(children.props.onPointerDown, cancelPendingShow),
    onPointerEnter: chainHandlers(children.props.onPointerEnter, (event) => {
      const trigger = event.currentTarget;
      cancelPendingShow();
      if (delay <= 0) return showTooltip(trigger, "pointer");
      showTimerRef.current = setTimeout(() => {
        showTimerRef.current = null;
        showTooltip(trigger, "pointer");
      }, delay);
    }),
    onPointerLeave: chainHandlers(children.props.onPointerLeave, () => {
      cancelPendingShow();
      hideTooltip("pointer");
    }),
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
