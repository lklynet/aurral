import { useEffect, useRef, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { parseResponse } from "hono/client";
import { Download, ExternalLink } from "./icons";
import TooltipButton from "./TooltipButton";
import { updatesClient } from "../utils/api/clients/updates.ts";

const UpdateIndicator = ({ visible = true }: { visible?: boolean }) => {
  const [menuOpen, setMenuOpen] = useState(false);
  const indicatorRef = useRef<HTMLDivElement | null>(null);
  const triggerRef = useRef<HTMLButtonElement | null>(null);
  const { data } = useQuery({
    queryKey: ["updates"],
    queryFn: ({ signal }) => parseResponse(updatesClient.$get({}, { init: { signal } })),
    enabled: visible,
    refetchInterval: 15 * 60 * 1000,
    staleTime: 5 * 60 * 1000,
  });
  const updateInfo = visible ? (data?.update ?? null) : null;

  useEffect(() => {
    if (!menuOpen) return undefined;
    const handlePointerDown = (event: MouseEvent) => {
      if (!indicatorRef.current?.contains(event.target as Node | null)) {
        setMenuOpen(false);
      }
    };
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        setMenuOpen(false);
        triggerRef.current?.focus();
      }
    };
    document.addEventListener("mousedown", handlePointerDown);
    document.addEventListener("keydown", handleKeyDown);
    return () => {
      document.removeEventListener("mousedown", handlePointerDown);
      document.removeEventListener("keydown", handleKeyDown);
    };
  }, [menuOpen]);

  if (!updateInfo) return null;

  const updateLabel = `Update available: ${updateInfo.latest}`;
  const notesTitle = "What's changed";

  return (
    <div ref={indicatorRef} className="app-update-indicator">
      <TooltipButton
        ref={triggerRef}
        label={updateLabel}
        className={`app-header-link app-update-indicator__trigger is-available${menuOpen ? " is-open" : ""}`}
        onClick={() => setMenuOpen((open) => !open)}
        aria-haspopup="dialog"
        aria-expanded={menuOpen}
      >
        <Download aria-hidden="true" />
      </TooltipButton>

      {menuOpen && (
        <div className="app-update-indicator__popover" role="dialog" aria-label="Update preview">
          <div>
            <p className="app-update-indicator__title">Update available</p>
            <p className="app-update-indicator__version">
              {updateInfo.current} <span aria-hidden="true">→</span> {updateInfo.latest}
            </p>
          </div>

          <div className="app-update-indicator__preview">
            <p className="app-update-indicator__preview-title">{notesTitle}</p>
            {updateInfo.notes.length > 0 ? (
              <ul className="app-update-indicator__notes">
                {updateInfo.notes.map((note, index) => (
                  <li key={`${note}-${index}`}>{note}</li>
                ))}
              </ul>
            ) : (
              <p className="app-update-indicator__empty">Release notes are available on GitHub.</p>
            )}
          </div>

          <div className="app-update-indicator__actions">
            <a
              href={updateInfo.url}
              target="_blank"
              rel="noreferrer"
              className="btn btn-primary btn-sm"
            >
              View {updateInfo.channel === "nightly" ? "changes" : "release"}
              <ExternalLink aria-hidden="true" />
            </a>
          </div>
        </div>
      )}
    </div>
  );
};

export default UpdateIndicator;
