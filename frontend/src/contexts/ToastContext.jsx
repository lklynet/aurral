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
  const nextToastIdRef = useRef(0);

  const addToast = useCallback((message, type = "info", duration = 3000) => {
    const id = `${Date.now()}-${nextToastIdRef.current++}`;
    const content =
      message &&
      typeof message === "object" &&
      ("message" in message || "title" in message || "description" in message || "action" in message)
        ? message
        : { message };
    setToasts((prev) => [
      { ...content, id, type, duration: content.duration ?? duration },
      ...prev,
    ].slice(0, MAX_TOASTS));
    return id;
  }, []);

  const removeToast = useCallback((id) => {
    setToasts((prev) => prev.filter((toast) => toast.id !== id));
  }, []);

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
