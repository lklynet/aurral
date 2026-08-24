import { useState, useEffect, useRef, useCallback } from "react";
import { MoreHorizontal } from "lucide-react";

export function MoreMenu({ children, activeButtonClass = "btn-primary" }) {
  const [isOpen, setIsOpen] = useState(false);
  const menuRef = useRef(null);
  const buttonRef = useRef(null);

  const close = useCallback(() => {
    setIsOpen(false);
    buttonRef.current?.focus();
  }, []);

  useEffect(() => {
    const handleClickOutside = (event) => {
      if (menuRef.current && !menuRef.current.contains(event.target)) {
        setIsOpen(false);
      }
    };
    if (isOpen) {
      document.addEventListener("mousedown", handleClickOutside);
    }
    return () => document.removeEventListener("mousedown", handleClickOutside);
  }, [isOpen]);

  useEffect(() => {
    if (!isOpen) return undefined;
    const handleKeyDown = (event) => {
      if (event.key === "Escape") close();
    };
    document.addEventListener("keydown", handleKeyDown);
    return () => document.removeEventListener("keydown", handleKeyDown);
  }, [close, isOpen]);

  return (
    <div className={`flow-page__menu-wrap${isOpen ? " is-open" : ""}`} ref={menuRef}>
      <button
        ref={buttonRef}
        type="button"
        onClick={(e) => { e.stopPropagation(); setIsOpen(!isOpen); }}
        className={`btn btn-sm btn--toolbar ${isOpen ? activeButtonClass : "btn-secondary"}`}
        aria-label="More options"
        aria-expanded={isOpen}
      >
        <MoreHorizontal className="artist-icon-sm" />
        <span className="flow-page__btn-label--wide">More</span>
      </button>
      {isOpen && (
        <>
          <button
            type="button"
            className="artist-backdrop-button"
            onClick={close}
            aria-label="Close menu"
          />
          <div
            className="artist-dropdown artist-dropdown--right"
            onClick={close}
          >
            {children}
          </div>
        </>
      )}
    </div>
  );
}
