import { useMemo } from "react";
import { createPortal } from "react-dom";
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
import { restrictToParentElement, restrictToVerticalAxis } from "@dnd-kit/modifiers";
import { GripVertical, X } from "../components/icons";
import type { DragEndEvent } from "@dnd-kit/core";
import { DotLoader } from "../components/DotLoader";
import { useModalDialog } from "../hooks/useModalDialog.ts";
import TooltipButton from "../components/TooltipButton";
import type { DiscoverSection } from "./discoverUtils";

function SortableSectionRow({
  item,
  onToggle,
  showUnavailable,
}: {
  item: DiscoverSection;
  onToggle: (id: string) => void;
  showUnavailable: boolean;
}) {
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
        item.enabled
          ? "artist-customize-section-row--enabled"
          : "artist-customize-section-row--disabled"
      } ${
        isDragging ? "artist-customize-section-row--dragging" : ""
      } ${showUnavailable ? "artist-customize-section-row--unavailable" : ""}`}
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
        <span className="artist-customize-section-title">{item.label}</span>
        {showUnavailable && (
          <span className="artist-customize-section-subtitle">Not enough data yet</span>
        )}
      </div>
      <button
        type="button"
        onClick={() => onToggle(item.id)}
        className={`btn btn-xs artist-customize-section-toggle${item.enabled ? " is-active" : ""}`}
        aria-pressed={item.enabled}
        aria-label={`${item.enabled ? "Hide" : "Show"} ${item.label}`}
      >
        {item.enabled ? "Active" : "Hidden"}
      </button>
    </div>
  );
}

export function DiscoverLayoutModal({
  open,
  sections,
  onSectionsChange,
  sectionAvailability,
  isSaving,
  onClose,
  onSave,
  onReset,
}: {
  open: boolean;
  sections: DiscoverSection[];
  onSectionsChange: (update: (prev: DiscoverSection[]) => DiscoverSection[]) => void;
  sectionAvailability: Record<string, boolean | undefined>;
  isSaving: boolean;
  onClose: () => void;
  onSave: () => void;
  onReset: () => void;
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
  const { dialogRef, handleBackdropClick } = useModalDialog({
    open,
    onClose,
    closeDisabled: isSaving,
  });

  const handleDragEnd = (event: DragEndEvent) => {
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
    <div className="artist-modal-backdrop" onClick={handleBackdropClick} role="presentation">
      <div
        ref={dialogRef}
        className="artist-customize-modal"
        role="dialog"
        aria-modal="true"
        aria-labelledby="discover-layout-modal-title"
        tabIndex={-1}
      >
        <div className="artist-customize-modal__header">
          <div>
            <h3 id="discover-layout-modal-title" className="artist-customize-modal__title">
              Customize Discover
            </h3>
            <p className="artist-customize-modal__subtitle">Drag to reorder.</p>
          </div>
          <TooltipButton
            type="button"
            className="btn btn-ghost btn-icon-square"
            onClick={onClose}
            disabled={isSaving}
            aria-label="Close"
            title="Close"
          >
            <X className="artist-icon-md" />
          </TooltipButton>
        </div>

        <DndContext
          sensors={sensors}
          collisionDetection={closestCenter}
          modifiers={[restrictToVerticalAxis, restrictToParentElement]}
          onDragEnd={handleDragEnd}
        >
          <div className="artist-customize-modal__body">
            <SortableContext items={sectionIds} strategy={verticalListSortingStrategy}>
              <div className="artist-customize-sections-list">
                {sections.map((item) => (
                  <SortableSectionRow
                    key={item.id}
                    item={item}
                    onToggle={(id) =>
                      onSectionsChange((prev) =>
                        prev.map((section) =>
                          section.id === id ? { ...section, enabled: !section.enabled } : section,
                        ),
                      )
                    }
                    showUnavailable={!sectionAvailability[item.id]}
                  />
                ))}
              </div>
            </SortableContext>
          </div>
        </DndContext>

        <div className="artist-customize-modal__footer">
          <button type="button" onClick={onReset} className="btn btn-ghost" disabled={isSaving}>
            Reset to default
          </button>
          <div className="artist-customize-modal__actions">
            <button
              type="button"
              onClick={onClose}
              className="btn btn-secondary"
              disabled={isSaving}
            >
              Cancel
            </button>
            <button type="button" onClick={onSave} className="btn btn-primary" disabled={isSaving}>
              {isSaving ? <DotLoader size="sm" label={null} /> : null}
              {isSaving ? "Saving..." : "Save layout"}
            </button>
          </div>
        </div>
      </div>
    </div>,
    document.body,
  );
}
