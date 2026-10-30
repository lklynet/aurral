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
import PillToggle from "../../../../components/PillToggle";
import TooltipButton from "../../../../components/TooltipButton";
import { SettingsInput } from "../../components/SettingsField";
import { Select } from "../../../../components/Select";
import { useServerSettings } from "../../SettingsProviders";
import { SettingsGroup, SettingsPage, SettingsRow, type ServiceStatus } from "../../SettingsLayout";
import type { QualityProfile } from "../../../../../../backend/db/helpers/settings.ts";

type ServerSettings = ReturnType<typeof useServerSettings>;

const QUALITY_TIER_LABELS: Partial<Record<string, string>> = {
  "flac-hires": "FLAC hi-res",
  "flac-standard": "FLAC standard",
  "mp3-320": "MP3 320",
  "m4a-320": "M4A 320",
  "mp3-256": "MP3 256",
  "m4a-256": "M4A 256",
  "mp3-192": "MP3 192",
  "m4a-192": "M4A 192",
  "mp3-128": "MP3 128",
  "m4a-128": "M4A 128",
};

const tierLabel = (id: string) => QUALITY_TIER_LABELS[id] || id;

function readQualityProfile(settings: ServerSettings["settings"]) {
  const profile: Partial<QualityProfile> = settings.qualityProfile || {};
  const order = Array.isArray(profile.order) ? profile.order : Object.keys(QUALITY_TIER_LABELS);
  const enabled = new Set(Array.isArray(profile.enabled) ? profile.enabled : order);
  return { profile, order, enabled };
}

export function qualityServiceStatus(settings: ServerSettings["settings"]): ServiceStatus {
  const { profile, enabled } = readQualityProfile(settings);
  const cutoff = profile.cutoff === undefined ? "not set" : tierLabel(profile.cutoff);
  return { label: `${enabled.size} allowed, cutoff ${cutoff}` };
}

function QualityTier({
  id,
  allowed,
  cutoff,
  onAllowed,
}: {
  id: string;
  allowed: boolean;
  cutoff: boolean;
  onAllowed: (allowed: boolean) => void;
}) {
  const {
    attributes,
    listeners,
    setNodeRef,
    setActivatorNodeRef,
    transform,
    transition,
    isDragging,
  } = useSortable({ id });
  const label = tierLabel(id);

  return (
    <div
      ref={setNodeRef}
      style={{ transform: CSS.Transform.toString(transform), transition }}
      className={`downloads-quality__tier${allowed ? "" : " is-off"}${isDragging ? " is-dragging" : ""}`}
    >
      <TooltipButton
        ref={setActivatorNodeRef}
        label="Drag to reorder"
        aria-label={`Reorder ${label}`}
        className="btn btn-ghost btn-icon btn-sm downloads-quality__grip"
        {...attributes}
        {...listeners}
      >
        <GripVertical aria-hidden="true" />
      </TooltipButton>
      <span className="downloads-quality__name">{label}</span>
      {cutoff ? <span className="downloads-muted">Cutoff</span> : null}
      <PillToggle
        checked={allowed}
        disabled={cutoff}
        aria-label={`Allow ${label}`}
        onChange={(event) => onAllowed(event.target.checked)}
      />
    </div>
  );
}

export function QualityProfileDetail() {
  const { settings, updateSettings } = useServerSettings();
  const { profile, order, enabled } = readQualityProfile(settings);
  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 6 } }),
    useSensor(KeyboardSensor, { coordinateGetter: sortableKeyboardCoordinates }),
  );

  const update = (patch: Partial<QualityProfile>) =>
    updateSettings({ ...settings, qualityProfile: { ...profile, ...patch } });

  const setAllowed = (id: string, allowed: boolean) => {
    const nextEnabled = allowed ? [...enabled, id] : [...enabled].filter((tierId) => tierId !== id);
    if (!nextEnabled.length) return;
    update({
      enabled: nextEnabled,
      cutoff:
        profile.cutoff !== undefined && nextEnabled.includes(profile.cutoff)
          ? profile.cutoff
          : order.find((tierId) => nextEnabled.includes(tierId)),
    });
  };

  const handleDragEnd = ({ active, over }: DragEndEvent) => {
    if (!over || active.id === over.id) return;
    update({
      order: arrayMove(order, order.indexOf(String(active.id)), order.indexOf(String(over.id))),
    });
  };

  return (
    <SettingsPage title="Quality profile" back="Downloads">
      <SettingsGroup
        title="Qualities"
        note="Rank best first. Downloads use allowed qualities, and upgrades stop at the cutoff."
      >
        <DndContext
          sensors={sensors}
          collisionDetection={closestCenter}
          modifiers={[restrictToVerticalAxis, restrictToParentElement]}
          onDragEnd={handleDragEnd}
        >
          <SortableContext items={order} strategy={verticalListSortingStrategy}>
            <div className="downloads-quality">
              {order.map((id) => (
                <QualityTier
                  key={id}
                  id={id}
                  allowed={enabled.has(id)}
                  cutoff={profile.cutoff === id}
                  onAllowed={(allowed) => setAllowed(id, allowed)}
                />
              ))}
            </div>
          </SortableContext>
        </DndContext>
        <SettingsRow label="Cutoff" htmlFor="quality-cutoff">
          <Select
            id="quality-cutoff"
            value={profile.cutoff ?? ""}
            onChange={(cutoff) => update({ cutoff })}
            options={[
              ...(profile.cutoff === undefined ? [{ value: "", label: "Not set" }] : []),
              ...order
                .filter((id) => enabled.has(id))
                .map((id) => ({ value: id, label: tierLabel(id) })),
            ]}
          />
        </SettingsRow>
      </SettingsGroup>
      <SettingsGroup title="Upgrades">
        <SettingsRow label="Automatic upgrades" htmlFor="quality-automatic-upgrades">
          <PillToggle
            id="quality-automatic-upgrades"
            checked={profile.automaticUpgrades === true}
            aria-label="Automatic upgrades"
            onChange={(event) => update({ automaticUpgrades: event.target.checked })}
          />
        </SettingsRow>
        {profile.automaticUpgrades === true ? (
          <SettingsRow
            label="Upgrade interval"
            htmlFor="quality-upgrade-interval"
            help="Days between checks for each track."
          >
            <SettingsInput
              id="quality-upgrade-interval"
              type="number"
              min="1"
              max="365"
              value={profile.intervalDays ?? 2}
              onChange={(event) =>
                update({ intervalDays: Number.parseInt(event.target.value, 10) || 2 })
              }
            />
          </SettingsRow>
        ) : null}
      </SettingsGroup>
    </SettingsPage>
  );
}
