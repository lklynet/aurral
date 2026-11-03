import type { ReactNode } from "react";

export default function StatePanel({
  icon,
  heading: Heading = "h2",
  title,
  message,
  role,
  onRetry,
  retrying = false,
  children,
}: {
  icon?: ReactNode;
  heading?: "h1" | "h2";
  title: ReactNode;
  message?: ReactNode;
  role?: "alert" | "status";
  onRetry?: () => unknown;
  retrying?: boolean;
  children?: ReactNode;
}) {
  return (
    <div className="search-empty-panel" role={role}>
      {icon ? (
        <div className="search-empty-panel__icon" aria-hidden="true">
          {icon}
        </div>
      ) : null}
      <Heading className="search-empty-panel__title">{title}</Heading>
      {message ? <p className="search-empty-panel__message">{message}</p> : null}
      {onRetry ? (
        <button type="button" className="btn btn-secondary" disabled={retrying} onClick={onRetry}>
          Try again
        </button>
      ) : null}
      {children}
    </div>
  );
}
