import {
  createContext,
  useContext,
  useState,
  useCallback,
  useRef,
  useMemo,
} from "react";
import { ToastContainer } from "../components/Toast";

const MAX_TOASTS = 4;

const ToastContext = createContext();

export function ToastProvider({ children }) {
  const [toasts, setToasts] = useState([]);
  const toastsRef = useRef([]);
  const nextToastIdRef = useRef(0);

  const replaceToasts = useCallback((next) => {
    toastsRef.current = next;
    setToasts(next);
  }, []);

  const addToast = useCallback((message, type = "info", duration = 3000) => {
    const id = `${Date.now()}-${nextToastIdRef.current++}`;
    const content =
      message &&
      typeof message === "object" &&
      ("message" in message || "title" in message || "description" in message || "action" in message)
        ? message
        : { message };
    const next = [
      { ...content, id, type, duration: content.duration ?? duration },
      ...toastsRef.current,
    ];
    replaceToasts(next.slice(0, MAX_TOASTS));
    next.slice(MAX_TOASTS).forEach((toast) => toast.onClose?.());
    return id;
  }, [replaceToasts]);

  const removeToast = useCallback((id) => {
    const toast = toastsRef.current.find((entry) => entry.id === id);
    if (!toast) return;
    replaceToasts(toastsRef.current.filter((entry) => entry.id !== id));
    toast.onClose?.();
  }, [replaceToasts]);

  const showSuccess = useCallback(
    (message, duration) => {
      return addToast(message, "success", duration);
    },
    [addToast],
  );

  const showError = useCallback(
    (message, duration) => {
      return addToast(message, "error", duration);
    },
    [addToast],
  );

  const showInfo = useCallback(
    (message, duration) => {
      return addToast(message, "info", duration);
    },
    [addToast],
  );

  const value = useMemo(() => ({
    addToast,
    removeToast,
    showSuccess,
    showError,
    showInfo,
  }), [addToast, removeToast, showSuccess, showError, showInfo]);

  return (
    <ToastContext.Provider value={value}>      {children}
      <ToastContainer toasts={toasts} onDismiss={removeToast} />
    </ToastContext.Provider>
  );
}

export function useToast() {
  const context = useContext(ToastContext);
  if (context === undefined) {
    throw new Error("useToast must be used within a ToastProvider");
  }
  return context;
}
