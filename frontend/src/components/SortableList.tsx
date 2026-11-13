import type { ReactNode } from "react";
import {
  DndContext,
  KeyboardCode,
  KeyboardSensor,
  PointerSensor,
  closestCenter,
  useSensor,
  useSensors,
  type Announcements,
  type DragEndEvent,
  type DragStartEvent,
  type UniqueIdentifier,
} from "@dnd-kit/core";
import {
  SortableContext,
  arrayMove,
  sortableKeyboardCoordinates,
  verticalListSortingStrategy,
} from "@dnd-kit/sortable";
import { restrictToVerticalAxis } from "@dnd-kit/modifiers";

const keyboardCodes = {
  start: [KeyboardCode.Space],
  cancel: [KeyboardCode.Esc],
  end: [KeyboardCode.Space, KeyboardCode.Enter, KeyboardCode.Tab],
};

// dnd-kit stops the click that ends a pointer drag from propagating but leaves its default, so a dragged link would still navigate.
const swallowClickAfterPointerDrag = ({ activatorEvent }: DragStartEvent) => {
  if (!(activatorEvent instanceof PointerEvent)) return;
  const release = () => {
    window.removeEventListener("click", swallow, true);
    window.removeEventListener("pointerdown", release, true);
  };
  const swallow = (event: MouseEvent) => {
    event.preventDefault();
    release();
  };
  window.addEventListener("click", swallow, true);
  window.addEventListener("pointerdown", release, true);
};

export function SortableList<Id extends UniqueIdentifier>({
  ids,
  titleOf,
  onReorder,
  children,
}: {
  ids: Id[];
  titleOf: (id: UniqueIdentifier) => string;
  onReorder: (ids: Id[]) => void;
  children: ReactNode;
}) {
  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 4 } }),
    useSensor(KeyboardSensor, { coordinateGetter: sortableKeyboardCoordinates, keyboardCodes }),
  );
  const indexOf = (id: UniqueIdentifier) => ids.findIndex((entry) => entry === id);
  const positionOf = (id: UniqueIdentifier) => `position ${indexOf(id) + 1} of ${ids.length}`;
  const announcements: Announcements = {
    onDragStart: ({ active }) => `Picked up ${titleOf(active.id)} at ${positionOf(active.id)}.`,
    onDragOver: ({ active, over }) =>
      over ? `${titleOf(active.id)} moved to ${positionOf(over.id)}.` : undefined,
    onDragEnd: ({ active, over }) =>
      over ? `${titleOf(active.id)} dropped at ${positionOf(over.id)}.` : undefined,
    onDragCancel: ({ active }) =>
      `Reordering cancelled. ${titleOf(active.id)} stays at ${positionOf(active.id)}.`,
  };

  const handleDragEnd = ({ active, over }: DragEndEvent) => {
    if (!over || active.id === over.id) return;
    const from = indexOf(active.id);
    const to = indexOf(over.id);
    if (from < 0 || to < 0) return;
    onReorder(arrayMove(ids, from, to));
  };

  return (
    <DndContext
      sensors={sensors}
      collisionDetection={closestCenter}
      modifiers={[restrictToVerticalAxis]}
      accessibility={{ announcements }}
      onDragStart={swallowClickAfterPointerDrag}
      onDragEnd={handleDragEnd}
    >
      <SortableContext items={ids} strategy={verticalListSortingStrategy}>
        {children}
      </SortableContext>
    </DndContext>
  );
}
