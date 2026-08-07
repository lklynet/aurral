import { useCallback, useEffect, useRef, useState } from "react";
import {
  AlertCircle,
  CheckCircle,
  Info,
  LoaderCircle,
  TriangleAlert,
  X,
} from "lucide-react";

const TOAST_ICONS = {
  success: CheckCircle,
  error: AlertCircle,
  info: Info,
  warning: TriangleAlert,
  loading: LoaderCircle,
};

const TOAST_EXIT_DURATION = 180;

export function Toast({ toast, onDismiss, index = 0 }) {
  const { id, type = "info", title, message, description, action, duration = 3000 } = toast;
  const [isExiting, setIsExiting] = useState(false);
  const timerRef = useRef(null);
  const exitTimerRef = useRef(null);
  const remainingRef = useRef(Math.max(0, Number(duration) || 3000));
  const startedAtRef = useRef(null);
  const interactionRef = useRef(false);
  const dismissedRef = useRef(false);

  const clearTimer = useCallback(() => {
    if (timerRef.current !== null) {
      window.clearTimeout(timerRef.current);
      timerRef.current = null;
    }
  }, []);

  const dismiss = useCallback(() => {
    if (dismissedRef.current) return;
    dismissedRef.current = true;
    clearTimer();
    startedAtRef.current = null;
    setIsExiting(true);
    exitTimerRef.current = window.setTimeout(() => {
      onDismiss(id);
    }, TOAST_EXIT_DURATION);
  }, [clearTimer, id, onDismiss]);

  const pauseTimer = useCallback(() => {
    if (startedAtRef.current === null) return;
    remainingRef.current = Math.max(
      0,
      remainingRef.current - (Date.now() - startedAtRef.current),
    );
    startedAtRef.current = null;
    clearTimer();
  }, [clearTimer]);

  const startTimer = useCallback(() => {
    if (
      dismissedRef.current ||
      interactionRef.current ||
      document.visibilityState !== "visible" ||
      !document.hasFocus() ||
      startedAtRef.current !== null
    ) {
      return;
    }

    if (remainingRef.current <= 0) {
      dismiss();
      return;
    }

    startedAtRef.current = Date.now();
    timerRef.current = window.setTimeout(dismiss, remainingRef.current);
  }, [dismiss]);

  const syncTimer = useCallback(() => {
    if (document.visibilityState !== "visible" || !document.hasFocus()) {
      pauseTimer();
      return;
    }
    startTimer();
  }, [pauseTimer, startTimer]);

  useEffect(() => {
    remainingRef.current = Math.max(0, Number(duration) || 3000);
    const handleVisibilityChange = () => syncTimer();

    document.addEventListener("visibilitychange", handleVisibilityChange);
    window.addEventListener("focus", handleVisibilityChange);
    window.addEventListener("blur", handleVisibilityChange);
    syncTimer();

    return () => {
      document.removeEventListener("visibilitychange", handleVisibilityChange);
      window.removeEventListener("focus", handleVisibilityChange);
      window.removeEventListener("blur", handleVisibilityChange);
      pauseTimer();
      clearTimer();
      if (exitTimerRef.current !== null) {
        window.clearTimeout(exitTimerRef.current);
      }
    };
  }, [clearTimer, duration, pauseTimer, syncTimer]);

  const handleInteractionStart = () => {
    interactionRef.current = true;
    pauseTimer();
  };

  const handleInteractionEnd = (event) => {
    if (event?.currentTarget?.contains(event.relatedTarget)) return;
    interactionRef.current = false;
    syncTimer();
  };

  const handleAction = () => {
    action?.onClick?.();
    if (action?.dismiss !== false) dismiss();
  };

  const Icon = TOAST_ICONS[type] || TOAST_ICONS.info;
  const body = description || message;

  return (
    <div
      className={`app-toast app-toast--${type}${isExiting ? " app-toast--exiting" : ""}`}
      role={type === "error" ? "alert" : "status"}
      aria-live={type === "error" ? "assertive" : "polite"}
      style={{ "--toast-index": index }}
      onMouseEnter={handleInteractionStart}
      onMouseLeave={handleInteractionEnd}
      onFocusCapture={handleInteractionStart}
      onBlurCapture={handleInteractionEnd}
    >
      <div className="app-toast__icon" aria-hidden="true">
        <Icon />
      </div>
      <div className="app-toast__content">
        {title && <div className="app-toast__title">{title}</div>}
        {body && <div className={title ? "app-toast__description" : "app-toast__message"}>{body}</div>}
      </div>
      {action?.label && (
        <button type="button" className="app-toast__action" onClick={handleAction}>
          {action.label}
        </button>
      )}
      <button
        type="button"
        className="app-toast__close"
        onClick={dismiss}
        aria-label="Dismiss notification"
      >
        <X aria-hidden="true" />
      </button>
    </div>
  );
}

export function ToastContainer({ toasts, onDismiss }) {
  return (
    <div className="app-toast-container">
      <div className="app-toast-stack">
        {toasts.map((toast, index) => (
          <Toast key={toast.id} toast={toast} index={index} onDismiss={onDismiss} />
        ))}
      </div>
    </div>
  );
}
