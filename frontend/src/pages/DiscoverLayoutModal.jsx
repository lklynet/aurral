import { useEffect, useMemo } from "react";
import { createPortal } from "react-dom";
import PropTypes from "prop-types";
import {
  DndContext,
  KeyboardSensor,
  PointerSensor,
  closestCenter,
  useSensor,
  useSensors,
} from "@dnd-kit/core";
import {
  SortableContext,
  arrayMove,
  sortableKeyboardCoordinates,
  useSortable,
  verticalListSortingStrategy,
} from "@dnd-kit/sortable";
import { CSS } from "@dnd-kit/utilities";
import {
  restrictToParentElement,
  restrictToVerticalAxis,
} from "@dnd-kit/modifiers";
import { GripVertical, X } from "lucide-react";

const FALLBACK_GENRE_SECTION_PREFIX = "fallbackGenre:";

const getFallbackGenreFromSectionId = (id) =>
  String(id || "").startsWith(FALLBACK_GENRE_SECTION_PREFIX)
    ? String(id).slice(FALLBACK_GENRE_SECTION_PREFIX.length)
    : null;

function SortableSectionRow({ item, onToggle, showUnavailable }) {
  const {
    attributes,
    listeners,
    setNodeRef,
    setActivatorNodeRef,
    transform,
    transition,
    isDragging,
  } = useSortable({ id: item.id });

  const style = {
    transform: CSS.Transform.toString(transform),
    transition,
  };

  return (
    <div
      ref={setNodeRef}
      style={style}
      className={`artist-customize-section-row ${
        item.enabled ? "artist-customize-section-row--enabled" : "artist-customize-section-row--disabled"
      } ${
        isDragging
          ? "artist-customize-section-row--dragging"
          : ""
      } ${!item.available ? "artist-customize-section-row--unavailable" : ""}`}
    >
      <button
        type="button"
        ref={setActivatorNodeRef}
        className="artist-customize-drag-handle"
        aria-label={`Reorder ${item.label}`}
        {...attributes}
        {...listeners}
      >
        <GripVertical className="artist-icon-sm" />
      </button>
      <div className="artist-customize-section-content">
        <span
          className="artist-customize-section-title"
        >
          {item.label}
        </span>
        {showUnavailable && (
          <span className="artist-customize-section-subtitle">
            Not enough data yet
          </span>
        )}
      </div>
      <button
        type="button"
        onClick={() => onToggle(item.id)}
        className={`btn btn-xs${item.enabled ? " btn-primary" : " btn-secondary"}`}
        aria-pressed={item.enabled}
        aria-label={`${item.enabled ? "Hide" : "Show"} ${item.label}`}
      >
        {item.enabled ? "Active" : "Hidden"}
      </button>
    </div>
  );
}

SortableSectionRow.propTypes = {
  item: PropTypes.shape({
    id: PropTypes.string.isRequired,
    label: PropTypes.string.isRequired,
    enabled: PropTypes.bool.isRequired,
  }).isRequired,
  onToggle: PropTypes.func.isRequired,
  showUnavailable: PropTypes.bool.isRequired,
};

export function DiscoverLayoutModal({
  open,
  sections,
  onSectionsChange,
  sectionAvailability,
  isSaving,
  onClose,
  onSave,
  onReset,
}) {
  const sectionIds = useMemo(() => sections.map((item) => item.id), [sections]);

  const sensors = useSensors(
    useSensor(PointerSensor, {
      activationConstraint: { distance: 6 },
    }),
    useSensor(KeyboardSensor, {
      coordinateGetter: sortableKeyboardCoordinates,
    }),
  );

  useEffect(() => {
    if (!open) return;
    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => {
      document.body.style.overflow = previousOverflow;
    };
  }, [open]);

  useEffect(() => {
    if (!open) return;
    const handleKeyDown = (event) => {
      if (event.key === "Escape" && !isSaving) {
        onClose();
      }
    };
    document.addEventListener("keydown", handleKeyDown);
    return () => document.removeEventListener("keydown", handleKeyDown);
  }, [open, isSaving, onClose]);

  const handleDragEnd = (event) => {
    const { active, over } = event;
    if (!over || active.id === over.id) return;
    onSectionsChange((prev) => {
      const oldIndex = prev.findIndex((item) => item.id === active.id);
      const newIndex = prev.findIndex((item) => item.id === over.id);
      if (oldIndex === -1 || newIndex === -1) return prev;
      return arrayMove(prev, oldIndex, newIndex);
    });
  };

  if (!open) return null;

  return createPortal(
    <div
      className="artist-modal-backdrop"
      onClick={isSaving ? undefined : onClose}
      role="presentation"
    >
      <div
        className="artist-customize-modal"
        role="dialog"
        aria-modal="true"
        aria-labelledby="discover-layout-modal-title"
        onClick={(event) => event.stopPropagation()}
      >
        <div className="artist-customize-modal__header">
          <div>
            <h3
              id="discover-layout-modal-title"
              className="artist-customize-modal__title"
            >
              Customize Discover
            </h3>
            <p className="artist-customize-modal__subtitle">
              Drag to reorder. Use Active/Hidden to choose what appears.
            </p>
          </div>
          <button
            type="button"
            className="btn btn-ghost btn-icon-square"
            onClick={onClose}
            disabled={isSaving}
            aria-label="Close"
          >
            <X className="artist-icon-md" />
          </button>
        </div>

        <DndContext
          sensors={sensors}
          collisionDetection={closestCenter}
          modifiers={[restrictToVerticalAxis, restrictToParentElement]}
          onDragEnd={handleDragEnd}
        >
          <div className="artist-customize-modal__body">
            <SortableContext
              items={sectionIds}
              strategy={verticalListSortingStrategy}
            >
              <div className="artist-customize-sections-list">
                {sections.map((item) => (
                  <SortableSectionRow
                    key={item.id}
                    item={item}
                    onToggle={(id) =>
                      onSectionsChange((prev) =>
                        prev.map((section) =>
                          section.id === id
                            ? { ...section, enabled: !section.enabled }
                            : section,
                        ),
                      )
                    }
                    showUnavailable={
                      !getFallbackGenreFromSectionId(item.id) &&
                      !sectionAvailability[item.id]
                    }
                  />
                ))}
              </div>
            </SortableContext>
          </div>
        </DndContext>

        <div className="artist-customize-modal__footer">
          <button
            type="button"
            onClick={onReset}
            className="btn btn-ghost btn-sm"
            disabled={isSaving}
          >
            Reset to Default
          </button>
          <div className="artist-customize-modal__actions">
            <button
              type="button"
              onClick={onClose}
              className="btn btn-secondary btn-sm"
              disabled={isSaving}
            >
              Cancel
            </button>
            <button
              type="button"
              onClick={onSave}
              className="btn btn-primary btn-sm"
              disabled={isSaving}
            >
              {isSaving ? "Saving..." : "Save Layout"}
            </button>
          </div>
        </div>
      </div>
    </div>,
    document.body,
  );
}

DiscoverLayoutModal.propTypes = {
  open: PropTypes.bool.isRequired,
  sections: PropTypes.arrayOf(
    PropTypes.shape({
      id: PropTypes.string.isRequired,
      label: PropTypes.string.isRequired,
      enabled: PropTypes.bool.isRequired,
    }),
  ).isRequired,
  onSectionsChange: PropTypes.func.isRequired,
  sectionAvailability: PropTypes.object.isRequired,
  isSaving: PropTypes.bool.isRequired,
  onClose: PropTypes.func.isRequired,
  onSave: PropTypes.func.isRequired,
  onReset: PropTypes.func.isRequired,
};
