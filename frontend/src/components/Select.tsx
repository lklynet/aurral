import {
  useEffect,
  useId,
  useLayoutEffect,
  useRef,
  useState,
  type CSSProperties,
  type KeyboardEvent,
  type ReactNode,
} from "react";
import { createPortal } from "react-dom";
import { Check, ChevronDown } from "./icons";

export type SelectOption<T extends string | number> = {
  value: T;
  label: string;
  detail?: ReactNode;
  disabled?: boolean;
};

type SelectProps<T extends string | number> = {
  value: T;
  options: readonly SelectOption<T>[];
  onChange: (value: T) => void;
  id?: string;
  className?: string;
  disabled?: boolean;
  "aria-label"?: string;
  triggerLabel?: string;
  searchable?: boolean;
};

const TYPEAHEAD_RESET_MS = 500;
const VIEWPORT_EDGE = 8;
const MENU_GAP = 4;
const MENU_MAX_HEIGHT = 320;

export function stepOption(
  options: readonly { disabled?: boolean }[],
  from: number,
  direction: 1 | -1,
) {
  for (let index = from + direction; index >= 0 && index < options.length; index += direction) {
    if (!options[index]?.disabled) return index;
  }
  return from;
}

export function matchOption(
  options: readonly { label: string; disabled?: boolean }[],
  query: string,
  from: number,
) {
  const lower = query.toLocaleLowerCase();
  const needle = [...lower].every((char) => char === lower[0]) ? lower.slice(0, 1) : lower;
  const start = needle.length === 1 ? from + 1 : Math.max(from, 0);
  for (let offset = 0; offset < options.length; offset += 1) {
    const index = (start + offset) % options.length;
    const option = options[index];
    if (option && !option.disabled && option.label.toLocaleLowerCase().startsWith(needle)) {
      return index;
    }
  }
  return -1;
}

function filterOptions<Option extends { label: string }>(
  options: readonly Option[],
  query: string,
) {
  const needle = query.trim().toLocaleLowerCase();
  return needle
    ? options.filter((option) => option.label.toLocaleLowerCase().includes(needle))
    : options;
}

export function Select<T extends string | number>({
  value,
  options,
  onChange,
  id,
  className = "input",
  disabled = false,
  "aria-label": ariaLabel,
  triggerLabel,
  searchable = false,
}: SelectProps<T>) {
  const listId = useId();
  const triggerRef = useRef<HTMLButtonElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);
  const listRef = useRef<HTMLDivElement>(null);
  const searchRef = useRef<HTMLInputElement>(null);
  const typeahead = useRef({ query: "", at: 0 });
  const [activeIndex, setActiveIndex] = useState<number | null>(null);
  const [position, setPosition] = useState<CSSProperties | null>(null);
  const [query, setQuery] = useState("");
  const open = activeIndex !== null;
  const visible = filterOptions(options, query);
  const selectedIndex = visible.findIndex((option) => option.value === value);
  const selected = options.find((option) => option.value === value) ?? options[0];

  const close = () => {
    setActiveIndex(null);
    setPosition(null);
    setQuery("");
  };

  const openAt = (index: number) => {
    if (!searchable) triggerRef.current?.focus({ preventScroll: true });
    setActiveIndex(index >= 0 && !options[index]?.disabled ? index : stepOption(options, -1, 1));
  };

  const search = (next: string) => {
    setQuery(next);
    setActiveIndex(stepOption(filterOptions(options, next), -1, 1));
  };

  const commit = (index: number) => {
    const option = visible[index];
    if (!option || option.disabled) return;
    if (searchable) triggerRef.current?.focus({ preventScroll: true });
    close();
    if (option.value !== value) onChange(option.value);
  };

  const navigate = (event: KeyboardEvent<HTMLElement>, current: number) => {
    const moves: Record<string, number> = {
      ArrowDown: stepOption(visible, current, 1),
      ArrowUp: stepOption(visible, current, -1),
      ...(!searchable && {
        Home: stepOption(visible, -1, 1),
        End: stepOption(visible, visible.length, -1),
      }),
    };
    const moved = moves[event.key];
    if (moved === undefined) return false;
    event.preventDefault();
    setActiveIndex(moved);
    return true;
  };

  const findTyped = (key: string, from: number) => {
    const now = Date.now();
    const state = typeahead.current;
    state.query = now - state.at > TYPEAHEAD_RESET_MS ? key : state.query + key;
    state.at = now;
    return matchOption(options, state.query, from);
  };

  const handleKeyDown = (event: KeyboardEvent<HTMLButtonElement>) => {
    const typed = event.key.length === 1 && !event.metaKey && !event.ctrlKey && !event.altKey;
    if (activeIndex === null) {
      if (["ArrowDown", "ArrowUp", "Enter", " "].includes(event.key)) {
        event.preventDefault();
        openAt(selectedIndex);
      } else if (typed && searchable) {
        event.preventDefault();
        openAt(selectedIndex);
        search(event.key);
      } else if (typed) {
        event.preventDefault();
        openAt(findTyped(event.key, selectedIndex));
      }
      return;
    }
    if (event.key === "Tab") {
      close();
      return;
    }
    if (event.key === "Escape") {
      event.preventDefault();
      event.stopPropagation();
      close();
      return;
    }
    if (navigate(event, activeIndex)) return;
    if (event.key === "Enter" || event.key === " ") {
      event.preventDefault();
      commit(activeIndex);
    } else if (typed) {
      event.preventDefault();
      const index = findTyped(event.key, activeIndex);
      if (index >= 0) setActiveIndex(index);
    }
  };

  useLayoutEffect(() => {
    if (!open) return;
    const trigger = triggerRef.current?.getBoundingClientRect();
    const menu = menuRef.current;
    if (!trigger || !menu) return;
    const below = window.innerHeight - trigger.bottom - MENU_GAP - VIEWPORT_EDGE;
    const above = trigger.top - MENU_GAP - VIEWPORT_EDGE;
    const placeAbove = menu.scrollHeight > below && above > below;
    const width = Math.max(menu.offsetWidth, trigger.width);
    const left = Math.max(
      VIEWPORT_EDGE,
      Math.min(trigger.left, window.innerWidth - width - VIEWPORT_EDGE),
    );
    setPosition({
      left,
      minWidth: width,
      maxHeight: Math.min(placeAbove ? above : below, MENU_MAX_HEIGHT),
      ...(placeAbove
        ? { bottom: window.innerHeight - trigger.top + MENU_GAP }
        : { top: trigger.bottom + MENU_GAP }),
    });
  }, [open]);

  useEffect(() => {
    if (position) searchRef.current?.focus({ preventScroll: true });
  }, [position]);

  useEffect(() => {
    const menu = menuRef.current;
    const item = activeIndex === null ? null : listRef.current?.children[activeIndex];
    if (!menu || !(item instanceof HTMLElement)) return;
    const top = item.offsetTop - (searchRef.current?.parentElement?.offsetHeight ?? 0);
    if (top < menu.scrollTop) {
      menu.scrollTop = top;
    } else if (item.offsetTop + item.offsetHeight > menu.scrollTop + menu.clientHeight) {
      menu.scrollTop = item.offsetTop + item.offsetHeight - menu.clientHeight;
    }
  }, [activeIndex, position]);

  useEffect(() => {
    if (!open) return undefined;
    const openWidth = window.innerWidth;
    const dismiss = () => {
      setActiveIndex(null);
      setPosition(null);
      setQuery("");
    };
    const dismissOnResize = () => {
      if (window.innerWidth !== openWidth) dismiss();
    };
    const closeOnScroll = (event: Event) => {
      if (event.target instanceof Node && menuRef.current?.contains(event.target)) return;
      dismiss();
    };
    window.addEventListener("resize", dismissOnResize);
    window.addEventListener("scroll", closeOnScroll, true);
    return () => {
      window.removeEventListener("resize", dismissOnResize);
      window.removeEventListener("scroll", closeOnScroll, true);
    };
  }, [open]);

  return (
    <>
      <button
        ref={triggerRef}
        type="button"
        id={id}
        className={`select ${className}`}
        role="combobox"
        aria-label={ariaLabel}
        aria-haspopup="listbox"
        aria-expanded={open}
        aria-controls={open ? listId : undefined}
        aria-activedescendant={
          !searchable && activeIndex !== null && activeIndex >= 0
            ? `${listId}-${activeIndex}`
            : undefined
        }
        disabled={disabled}
        onClick={() => (open ? close() : openAt(selectedIndex))}
        onKeyDown={handleKeyDown}
        onBlur={searchable ? undefined : close}
      >
        <span className="select__value">{triggerLabel ?? selected?.label}</span>
        <ChevronDown className="select__chevron" aria-hidden="true" />
      </button>
      {open
        ? createPortal(
            <>
              <div
                className="select-menu__backdrop"
                onMouseDown={(event) => event.preventDefault()}
                onClick={close}
              />
              <div
                ref={menuRef}
                className="select-menu"
                style={position ?? { visibility: "hidden" }}
                onMouseDown={(event) => {
                  if (event.target !== searchRef.current) event.preventDefault();
                }}
              >
                {searchable ? (
                  <div className="select-menu__search">
                    <input
                      ref={searchRef}
                      className="input"
                      type="search"
                      role="combobox"
                      aria-label={ariaLabel ? `Search ${ariaLabel}` : "Search"}
                      aria-expanded
                      aria-controls={listId}
                      aria-autocomplete="list"
                      aria-activedescendant={
                        activeIndex !== null && activeIndex >= 0
                          ? `${listId}-${activeIndex}`
                          : undefined
                      }
                      placeholder="Search"
                      value={query}
                      onChange={(event) => search(event.target.value)}
                      onBlur={(event) => {
                        if (event.relatedTarget !== triggerRef.current) close();
                      }}
                      onKeyDown={(event) => {
                        if (event.key === "Escape") {
                          event.preventDefault();
                          event.stopPropagation();
                          triggerRef.current?.focus({ preventScroll: true });
                          close();
                        } else if (event.key === "Enter") {
                          event.preventDefault();
                          if (activeIndex !== null) commit(activeIndex);
                        } else if (activeIndex !== null) {
                          navigate(event, activeIndex);
                        }
                      }}
                    />
                  </div>
                ) : null}
                <div ref={listRef} id={listId} role="listbox" aria-label={ariaLabel}>
                  {visible.map((option, index) => (
                    <div
                      key={option.value}
                      id={`${listId}-${index}`}
                      role="option"
                      aria-selected={index === selectedIndex}
                      aria-disabled={option.disabled || undefined}
                      className={`select-menu__option${index === activeIndex ? " is-active" : ""}`}
                      onPointerMove={() => {
                        if (!option.disabled && index !== activeIndex) setActiveIndex(index);
                      }}
                      onClick={() => commit(index)}
                    >
                      {option.detail ? (
                        <span className="select-menu__text">
                          <span className="select__value">{option.label}</span>
                          <span className="select-menu__detail">{option.detail}</span>
                        </span>
                      ) : (
                        <span className="select__value">{option.label}</span>
                      )}
                      {index === selectedIndex ? (
                        <Check className="select-menu__check" aria-hidden="true" />
                      ) : null}
                    </div>
                  ))}
                </div>
              </div>
            </>,
            document.body,
          )
        : null}
    </>
  );
}
