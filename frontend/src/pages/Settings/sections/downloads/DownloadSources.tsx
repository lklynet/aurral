import { useMutation, useQueryClient } from "@tanstack/react-query";
import { parseResponse, type InferResponseType } from "hono/client";
import {
  DndContext,
  KeyboardSensor,
  PointerSensor,
  closestCenter,
  useSensor,
  useSensors,
  type DragEndEvent,
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
import { GripVertical } from "../../../../components/icons";
import TooltipButton from "../../../../components/TooltipButton";
import { useToast } from "../../../../contexts/ToastContext";
import { queryKeys } from "../../../../queryClient.ts";
import { pluginsClient } from "../../../../utils/api/clients/plugins.ts";
import { readApiError } from "../../../../utils/api/errors.ts";
import { useServerSettings } from "../../SettingsProviders";
import { SettingsServiceRow, type ServiceStatus } from "../../SettingsLayout";
import { clientConfig, type DownloadClientDefinition } from "./DownloadClients";

type PluginList = InferResponseType<typeof pluginsClient.$get, 200>;

export type DownloadSourceRow = {
  id: string;
  name: string;
  to: string;
  status: ServiceStatus;
  priority: number;
} & ({ client: DownloadClientDefinition } | { plugin: string });

const PRIORITY_STEP = 10;

function DownloadSource({ row }: { row: DownloadSourceRow }) {
  const {
    attributes,
    listeners,
    setNodeRef,
    setActivatorNodeRef,
    transform,
    transition,
    isDragging,
  } = useSortable({ id: row.id });

  return (
    <div
      ref={setNodeRef}
      style={{ transform: CSS.Transform.toString(transform), transition }}
      className={`downloads-source${isDragging ? " is-dragging" : ""}`}
    >
      <TooltipButton
        ref={setActivatorNodeRef}
        label="Drag to reorder"
        aria-label={`Reorder ${row.name}`}
        className="btn btn-ghost btn-icon btn-sm downloads-quality__grip"
        {...attributes}
        {...listeners}
      >
        <GripVertical aria-hidden="true" />
      </TooltipButton>
      <SettingsServiceRow to={row.to} name={row.name} status={row.status} />
    </div>
  );
}

export function DownloadSourceList({ rows }: { rows: DownloadSourceRow[] }) {
  const { settings, updateSettings } = useServerSettings();
  const queryClient = useQueryClient();
  const { showError } = useToast();
  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 6 } }),
    useSensor(KeyboardSensor, { coordinateGetter: sortableKeyboardCoordinates }),
  );
  const savePlugins = useMutation({
    mutationFn: (priorities: Map<string, number>) =>
      Promise.all(
        [...priorities].map(([id, priority]) =>
          parseResponse(pluginsClient[":id"].$put({ param: { id }, json: { priority } })),
        ),
      ),
    onMutate: (priorities) =>
      queryClient.setQueryData<PluginList>(queryKeys.plugins, (list) =>
        list
          ? {
              ...list,
              plugins: list.plugins.map((plugin) => ({
                ...plugin,
                priority: priorities.get(plugin.id) ?? plugin.priority,
              })),
            }
          : list,
      ),
    onError: (error) => showError(readApiError(error).error || "Couldn't save the order"),
    onSettled: () => queryClient.invalidateQueries({ queryKey: queryKeys.plugins }),
  });

  const handleDragEnd = ({ active, over }: DragEndEvent) => {
    if (!over || active.id === over.id) return;
    const ids = rows.map((row) => row.id);
    const ranked = arrayMove(rows, ids.indexOf(String(active.id)), ids.indexOf(String(over.id)))
      .map((row, index) => ({ row, priority: (index + 1) * PRIORITY_STEP }))
      .filter(({ row, priority }) => row.priority !== priority);
    const clients = ranked.flatMap(({ row, priority }) =>
      "client" in row
        ? [[row.client.key, { ...clientConfig(settings, row.client), priority }] as const]
        : [],
    );
    const plugins = new Map(
      ranked.flatMap(({ row, priority }) =>
        "plugin" in row ? [[row.plugin, priority] as const] : [],
      ),
    );
    if (clients.length) {
      updateSettings({
        ...settings,
        integrations: { ...settings.integrations, ...Object.fromEntries(clients) },
      });
    }
    if (plugins.size) savePlugins.mutate(plugins);
  };

  return (
    <DndContext
      sensors={sensors}
      collisionDetection={closestCenter}
      modifiers={[restrictToVerticalAxis, restrictToParentElement]}
      onDragEnd={handleDragEnd}
    >
      <SortableContext items={rows.map((row) => row.id)} strategy={verticalListSortingStrategy}>
        {rows.map((row) => (
          <DownloadSource key={row.id} row={row} />
        ))}
      </SortableContext>
    </DndContext>
  );
}
