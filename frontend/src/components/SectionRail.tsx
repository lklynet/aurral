import { useEffect, useRef, useState, type CSSProperties, type RefObject } from "react";
import "./SectionRail.css";

const RAIL_ROOM_PX = 80;

function findScrollParent(element: Element) {
  for (let node = element?.parentElement; node; node = node.parentElement) {
    if (/(auto|scroll)/.test(getComputedStyle(node).overflowY)) return node;
  }
  return document.documentElement;
}

interface SectionEntry {
  element: Element;
  title: string;
  description: string;
}

const sameSections = (current: SectionEntry[], next: SectionEntry[]) =>
  current.length === next.length &&
  current.every(
    (section, index) =>
      section.element === next[index].element &&
      section.title === next[index].title &&
      section.description === next[index].description,
  );

interface SectionRailProps {
  containerRef: RefObject<HTMLElement | null>;
  sectionSelector: string;
  titleSelector: string;
  descriptionSelector?: string;
  label: string;
}

export default function SectionRail({
  containerRef,
  sectionSelector,
  titleSelector,
  descriptionSelector,
  label,
}: SectionRailProps) {
  const [sections, setSections] = useState<SectionEntry[]>([]);
  const [activeIndex, setActiveIndex] = useState(0);
  const [hoveredIndex, setHoveredIndex] = useState<number | null>(null);
  const [hasRoom, setHasRoom] = useState(false);
  const pinnedElementRef = useRef<Element | null>(null);

  useEffect(() => {
    const container = containerRef.current;
    if (!container) return undefined;
    const scrollParent = findScrollParent(container);
    const measure = () => {
      const gutter =
        container.getBoundingClientRect().left - scrollParent.getBoundingClientRect().left;
      setHasRoom(gutter >= RAIL_ROOM_PX);
    };
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(container);
    observer.observe(scrollParent);
    return () => observer.disconnect();
  }, [containerRef]);

  useEffect(() => {
    const container = containerRef.current;
    if (!container) return undefined;
    const read = () => {
      const found = [...container.querySelectorAll(sectionSelector)]
        .map((element) => ({
          element,
          title: element.querySelector(titleSelector)?.textContent!.trim() || "",
          description: descriptionSelector
            ? element.querySelector(descriptionSelector)?.textContent!.trim() || ""
            : "",
        }))
        .filter((section) => section.title);
      setSections((current) => (sameSections(current, found) ? current : found));
    };
    read();
    const observer = new MutationObserver(read);
    observer.observe(container, { childList: true, subtree: true, characterData: true });
    return () => observer.disconnect();
  }, [containerRef, descriptionSelector, sectionSelector, titleSelector]);

  useEffect(() => {
    if (!sections.length) return undefined;
    const scrollParent = findScrollParent(sections[0].element);
    const scrollTarget = scrollParent === document.documentElement ? window : scrollParent;
    let frame: number | null = null;
    const update = () => {
      frame = null;
      if (pinnedElementRef.current) {
        const pinnedIndex = sections.findIndex(
          (section) => section.element === pinnedElementRef.current,
        );
        if (pinnedIndex >= 0) {
          setActiveIndex(pinnedIndex);
          return;
        }
        pinnedElementRef.current = null;
      }
      const bounds = scrollParent.getBoundingClientRect();
      const atBottom =
        scrollParent.scrollTop + scrollParent.clientHeight >= scrollParent.scrollHeight - 2;
      if (atBottom) {
        setActiveIndex(sections.length - 1);
        return;
      }
      const line = bounds.top + scrollParent.clientHeight * 0.35;
      let index = 0;
      sections.forEach((section, sectionIndex) => {
        if (section.element.getBoundingClientRect().top <= line) index = sectionIndex;
      });
      setActiveIndex(index);
    };
    const schedule = () => {
      if (frame === null) frame = requestAnimationFrame(update);
    };
    const release = () => {
      pinnedElementRef.current = null;
    };
    const userScrollEvents = ["wheel", "touchstart", "keydown", "pointerdown"];
    update();
    scrollTarget.addEventListener("scroll", schedule, { passive: true });
    for (const type of userScrollEvents)
      window.addEventListener(type, release, { passive: true, capture: true });
    return () => {
      scrollTarget.removeEventListener("scroll", schedule);
      for (const type of userScrollEvents)
        window.removeEventListener(type, release, { capture: true });
      if (frame !== null) cancelAnimationFrame(frame);
    };
  }, [sections]);

  if (sections.length < 2 || !hasRoom) return null;

  const jumpTo = (index: number) => {
    pinnedElementRef.current = sections[index].element;
    setActiveIndex(index);
    const reduceMotion = window.matchMedia?.("(prefers-reduced-motion: reduce)").matches;
    sections[index].element.scrollIntoView({
      behavior: reduceMotion ? "auto" : "smooth",
      block: "start",
    });
  };

  const hovered = hoveredIndex === null ? null : sections[hoveredIndex];

  return (
    <nav className="section-rail" aria-label={label}>
      <div
        className={`section-rail__track${hovered ? " is-hovered" : ""}`}
        style={hovered ? ({ "--section-rail-hovered": hoveredIndex } as CSSProperties) : undefined}
        onMouseLeave={() => setHoveredIndex(null)}
      >
        <ol className="section-rail__list">
          {sections.map((section, index) => {
            const distance =
              hoveredIndex === null ? null : Math.min(Math.abs(index - hoveredIndex), 3);
            return (
              <li key={`${index}-${section.title}`}>
                <button
                  type="button"
                  className={`section-rail__tick${index === activeIndex ? " is-active" : ""}`}
                  data-distance={distance ?? undefined}
                  aria-label={section.title}
                  aria-current={index === activeIndex ? "location" : undefined}
                  onMouseEnter={() => setHoveredIndex(index)}
                  onFocus={() => setHoveredIndex(index)}
                  onBlur={() => setHoveredIndex(null)}
                  onClick={() => jumpTo(index)}
                >
                  <span aria-hidden="true" />
                </button>
              </li>
            );
          })}
        </ol>
        {hovered ? (
          <div className="section-rail__card" aria-hidden="true">
            <span className="section-rail__card-title">{hovered.title}</span>
            {hovered.description ? (
              <span className="section-rail__card-description">{hovered.description}</span>
            ) : null}
          </div>
        ) : null}
      </div>
    </nav>
  );
}
