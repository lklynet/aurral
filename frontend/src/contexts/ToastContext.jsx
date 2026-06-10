import {
  createContext,
  useContext,
  useState,
  useCallback,
  useRef,
} from "react";
import { ToastContainer } from "../components/Toast";

const ToastContext = createContext();

export function ToastProvider({ children }) {
  const [toasts, setToasts] = useState([]);
  const nextToastIdRef = useRef(0);

  const addToast = useCallback((message, type = "info", duration = 3000) => {
    const id = `${Date.now()}-${nextToastIdRef.current++}`;
    setToasts((prev) => [...prev, { id, message, type, duration }]);
    return id;
  }, []);

  const removeToast = useCallback((id) => {
    setToasts((prev) => prev.filter((toast) => toast.id !== id));
  }, []);

  const showSuccess = useCallback((message, duration) => {
    return addToast(message, "success", duration);
  }, [addToast]);

  const showError = useCallback((message, duration) => {
    return addToast(message, "error", duration);
  }, [addToast]);

  const showInfo = useCallback((message, duration) => {
    return addToast(message, "info", duration);
  }, [addToast]);

  return (
    <ToastContext.Provider
      value={{ addToast, removeToast, showSuccess, showError, showInfo }}
    >
      {children}
      <ToastContainer toasts={toasts} onDismiss={removeToast} />
    </ToastContext.Provider>
  );
}

/* eslint-disable-next-line react-refresh/only-export-components */
export function useToast() {
  const context = useContext(ToastContext);
  if (context === undefined) {
    throw new Error("useToast must be used within a ToastProvider");
  }
  return context;
}
