import {
  useEffect,
  useId,
  useLayoutEffect,
  useRef,
  useState,
  type CSSProperties,
  type KeyboardEvent,
} from "react";
import { createPortal } from "react-dom";
import { Check, ChevronDown } from "./icons";

export type SelectOption<T extends string | number> = {
  value: T;
  label: string;
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

export function Select<T extends string | number>({
  value,
  options,
  onChange,
  id,
  className = "input",
  disabled = false,
  "aria-label": ariaLabel,
}: SelectProps<T>) {
  const listId = useId();
  const triggerRef = useRef<HTMLButtonElement>(null);
  const listRef = useRef<HTMLDivElement>(null);
  const typeahead = useRef({ query: "", at: 0 });
  const [activeIndex, setActiveIndex] = useState<number | null>(null);
  const [position, setPosition] = useState<CSSProperties | null>(null);
  const open = activeIndex !== null;
  const selectedIndex = options.findIndex((option) => option.value === value);
  const selected = options[selectedIndex] ?? options[0];

  const close = () => {
    setActiveIndex(null);
    setPosition(null);
  };

  const openAt = (index: number) => {
    triggerRef.current?.focus({ preventScroll: true });
    setActiveIndex(index >= 0 && !options[index]?.disabled ? index : stepOption(options, -1, 1));
  };

  const commit = (index: number) => {
    const option = options[index];
    if (!option || option.disabled) return;
    close();
    if (option.value !== value) onChange(option.value);
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
    const moves: Record<string, number> = {
      ArrowDown: stepOption(options, activeIndex, 1),
      ArrowUp: stepOption(options, activeIndex, -1),
      Home: stepOption(options, -1, 1),
      End: stepOption(options, options.length, -1),
    };
    const moved = moves[event.key];
    if (moved !== undefined) {
      event.preventDefault();
      setActiveIndex(moved);
    } else if (event.key === "Enter" || event.key === " ") {
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
    const list = listRef.current;
    if (!trigger || !list) return;
    const below = window.innerHeight - trigger.bottom - MENU_GAP - VIEWPORT_EDGE;
    const above = trigger.top - MENU_GAP - VIEWPORT_EDGE;
    const placeAbove = list.scrollHeight > below && above > below;
    const width = Math.max(list.offsetWidth, trigger.width);
    const left = Math.max(
      VIEWPORT_EDGE,
      Math.min(trigger.left, window.innerWidth - width - VIEWPORT_EDGE),
    );
    setPosition({
      left,
      minWidth: trigger.width,
      maxHeight: Math.min(placeAbove ? above : below, MENU_MAX_HEIGHT),
      ...(placeAbove
        ? { bottom: window.innerHeight - trigger.top + MENU_GAP }
        : { top: trigger.bottom + MENU_GAP }),
    });
  }, [open]);

  useEffect(() => {
    const list = listRef.current;
    const item = activeIndex === null ? null : list?.children[activeIndex];
    if (!list || !(item instanceof HTMLElement)) return;
    if (item.offsetTop < list.scrollTop) {
      list.scrollTop = item.offsetTop;
    } else if (item.offsetTop + item.offsetHeight > list.scrollTop + list.clientHeight) {
      list.scrollTop = item.offsetTop + item.offsetHeight - list.clientHeight;
    }
  }, [activeIndex, position]);

  useEffect(() => {
    if (!open) return undefined;
    const dismiss = () => {
      setActiveIndex(null);
      setPosition(null);
    };
    const closeOnScroll = (event: Event) => {
      if (event.target instanceof Node && listRef.current?.contains(event.target)) return;
      dismiss();
    };
    window.addEventListener("resize", dismiss);
    window.addEventListener("scroll", closeOnScroll, true);
    return () => {
      window.removeEventListener("resize", dismiss);
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
          activeIndex !== null && activeIndex >= 0 ? `${listId}-${activeIndex}` : undefined
        }
        disabled={disabled}
        onClick={() => (open ? close() : openAt(selectedIndex))}
        onKeyDown={handleKeyDown}
        onBlur={close}
      >
        <span className="select__value">{selected?.label}</span>
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
                ref={listRef}
                id={listId}
                className="select-menu"
                role="listbox"
                aria-label={ariaLabel}
                style={position ?? { visibility: "hidden" }}
                onMouseDown={(event) => event.preventDefault()}
              >
                {options.map((option, index) => (
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
                    <span className="select__value">{option.label}</span>
                    {index === selectedIndex ? (
                      <Check className="select-menu__check" aria-hidden="true" />
                    ) : null}
                  </div>
                ))}
              </div>
            </>,
            document.body,
          )
        : null}
    </>
  );
}
