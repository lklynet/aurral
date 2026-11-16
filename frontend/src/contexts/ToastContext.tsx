import { createContext, useContext, useState, useCallback, useRef, useMemo } from "react";
import type { ReactNode } from "react";
import { ToastContainer } from "../components/Toast.tsx";
import type { ToastContent, ToastItem, ToastType } from "../components/Toast.tsx";
import { stackToast } from "../utils/toastStack.ts";

const MAX_TOASTS = 4;

const DURATIONS: Record<ToastType, number> = {
  success: 3000,
  info: 3000,
  warning: 6000,
  error: 6000,
};

type ToastInput = string | ToastContent;
type ToastApi = {
  addToast: (input: ToastInput, type?: ToastType) => string;
  removeToast: (id: string) => void;
  showSuccess: (input: ToastInput) => string;
  showError: (input: ToastInput) => string;
  showInfo: (input: ToastInput) => string;
};

const ToastContext = createContext<ToastApi | undefined>(undefined);

export function ToastProvider({ children }: { children: ReactNode }) {
  const [toasts, setToasts] = useState<ToastItem[]>([]);
  const toastsRef = useRef<ToastItem[]>([]);
  const nextIdRef = useRef(0);

  const replaceToasts = useCallback((next: ToastItem[]) => {
    toastsRef.current = next;
    setToasts(next);
  }, []);

  const addToast = useCallback(
    (input: ToastInput, type: ToastType = "info") => {
      const content = typeof input === "string" ? { message: input } : input;
      const id = String(nextIdRef.current++);
      const { kept, evicted } = stackToast(
        toastsRef.current,
        { ...content, id, type, duration: content.duration ?? DURATIONS[type] },
        MAX_TOASTS,
      );
      replaceToasts(kept);
      evicted.forEach((toast) => toast.onClose?.());
      return id;
    },
    [replaceToasts],
  );

  const removeToast = useCallback(
    (id: string) => {
      const toast = toastsRef.current.find((entry) => entry.id === id);
      if (!toast) return;
      replaceToasts(toastsRef.current.filter((entry) => entry.id !== id));
      toast.onClose?.();
    },
    [replaceToasts],
  );

  const value = useMemo(
    () => ({
      addToast,
      removeToast,
      showSuccess: (input: ToastInput) => addToast(input, "success"),
      showError: (input: ToastInput) => addToast(input, "error"),
      showInfo: (input: ToastInput) => addToast(input, "info"),
    }),
    [addToast, removeToast],
  );

  return (
    <ToastContext.Provider value={value}>
      {children}
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
