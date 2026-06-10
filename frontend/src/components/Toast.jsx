import { useEffect } from "react";
import PropTypes from "prop-types";
import { CheckCircle, AlertCircle, X, Info } from "lucide-react";

const TOAST_ICONS = {
  success: CheckCircle,
  error: AlertCircle,
  info: Info,
};

export function Toast({ toast, onDismiss }) {
  const { id, type, message, duration = 3000 } = toast;

  useEffect(() => {
    const timer = setTimeout(() => {
      onDismiss(id);
    }, duration);

    return () => clearTimeout(timer);
  }, [id, duration, onDismiss]);

  const Icon = TOAST_ICONS[type] || TOAST_ICONS.info;

  return (
    <div className={`app-toast app-toast--${type}`} role="alert">
      <div className="app-toast__icon" aria-hidden="true">
        <Icon />
      </div>
      <div className="app-toast__message">{message}</div>
      <button
        type="button"
        className="app-toast__close"
        onClick={() => onDismiss(id)}
        aria-label="Close"
      >
        <X aria-hidden="true" />
      </button>
    </div>
  );
}

Toast.propTypes = {
  toast: PropTypes.shape({
    id: PropTypes.string.isRequired,
    type: PropTypes.oneOf(["success", "error", "info"]).isRequired,
    message: PropTypes.string.isRequired,
    duration: PropTypes.number,
  }).isRequired,
  onDismiss: PropTypes.func.isRequired,
};

export function ToastContainer({ toasts, onDismiss }) {
  return (
    <div className="app-toast-container">
      <div className="app-toast-stack">
        {toasts.map((toast) => (
          <Toast key={toast.id} toast={toast} onDismiss={onDismiss} />
        ))}
      </div>
    </div>
  );
}

ToastContainer.propTypes = {
  toasts: PropTypes.arrayOf(
    PropTypes.shape({
      id: PropTypes.string.isRequired,
      type: PropTypes.oneOf(["success", "error", "info"]).isRequired,
      message: PropTypes.string.isRequired,
      duration: PropTypes.number,
    }),
  ).isRequired,
  onDismiss: PropTypes.func.isRequired,
};
