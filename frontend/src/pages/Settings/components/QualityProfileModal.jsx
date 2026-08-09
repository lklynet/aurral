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
import { GripVertical } from "lucide-react";
import { SettingsInput } from "./SettingsField";
import { SettingsIntegrationModal } from "./SettingsIntegrationCards";
import {
  SettingsModalField,
  SettingsModalIntro,
  SettingsModalSection,
  SettingsModalToggle,
} from "./SettingsModalLayout";

export const QUALITY_TIER_LABELS = {
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

function SortableQuality({ id, enabled, cutoff, aboveCutoff, onToggle, onCutoff }) {
  const { attributes, listeners, setNodeRef, setActivatorNodeRef, transform, transition, isDragging } =
    useSortable({ id });

  return (
    <div
      ref={setNodeRef}
      style={{ transform: CSS.Transform.toString(transform), transition }}
      className={`quality-profile-row${enabled ? " is-enabled" : ""}${cutoff ? " is-cutoff" : ""}${aboveCutoff ? " is-above-cutoff" : ""}${isDragging ? " is-dragging" : ""}`}
    >
      <button
        type="button"
        ref={setActivatorNodeRef}
        className="quality-profile-row__drag"
        aria-label={`Reorder ${QUALITY_TIER_LABELS[id] || id}`}
        {...attributes}
        {...listeners}
      >
        <GripVertical className="artist-icon-sm" aria-hidden />
      </button>
      <span className="quality-profile-row__name">{QUALITY_TIER_LABELS[id] || id}</span>
      <button
        type="button"
        className={`quality-profile-row__state${enabled ? " is-active" : ""}`}
        aria-pressed={enabled}
        disabled={cutoff}
        title={cutoff ? "The cutoff quality must be allowed" : undefined}
        onClick={() => onToggle(id)}
      >
        {enabled ? "Allowed" : "Not allowed"}
      </button>
      <button
        type="button"
        className={`quality-profile-row__cutoff${cutoff ? " is-active" : ""}`}
        disabled={!enabled}
        aria-pressed={cutoff}
        onClick={() => onCutoff(id)}
      >
        {cutoff ? "Cutoff" : "Set cutoff"}
      </button>
    </div>
  );
}

export function QualityProfileModal({ profile, onChange, onClose }) {
  const order = Array.isArray(profile.order) ? profile.order : Object.keys(QUALITY_TIER_LABELS);
  const enabled = new Set(Array.isArray(profile.enabled) ? profile.enabled : order);
  const cutoffIndex = order.indexOf(profile.cutoff);
  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 6 } }),
    useSensor(KeyboardSensor, { coordinateGetter: sortableKeyboardCoordinates }),
  );

  const toggle = (id) => {
    const nextEnabled = enabled.has(id)
      ? [...enabled].filter((tierId) => tierId !== id)
      : [...enabled, id];
    if (!nextEnabled.length) return;
    onChange({
      enabled: nextEnabled,
      cutoff: nextEnabled.includes(profile.cutoff)
        ? profile.cutoff
        : order.find((tierId) => nextEnabled.includes(tierId)),
    });
  };

  const handleDragEnd = ({ active, over }) => {
    if (!over || active.id === over.id) return;
    onChange({ order: arrayMove(order, order.indexOf(active.id), order.indexOf(over.id)) });
  };

  return (
    <SettingsIntegrationModal title="Quality Profile" onClose={onClose} wide>
      <SettingsModalIntro>
        Rank qualities from best to worst. Aurral accepts allowed qualities and upgrades tracks until they reach the cutoff.
      </SettingsModalIntro>
      <SettingsModalSection title="Qualities">
        <DndContext
          sensors={sensors}
          collisionDetection={closestCenter}
          modifiers={[restrictToVerticalAxis, restrictToParentElement]}
          onDragEnd={handleDragEnd}
        >
          <SortableContext items={order} strategy={verticalListSortingStrategy}>
            <div className="quality-profile-list">
              {order.map((id, index) => (
                <SortableQuality
                  key={id}
                  id={id}
                  enabled={enabled.has(id)}
                  cutoff={profile.cutoff === id}
                  aboveCutoff={cutoffIndex >= 0 && index < cutoffIndex}
                  onToggle={toggle}
                  onCutoff={(cutoff) => onChange({ cutoff })}
                />
              ))}
            </div>
          </SortableContext>
        </DndContext>
      </SettingsModalSection>
      <SettingsModalSection title="Upgrades">
        <SettingsModalToggle
          label="Automatic upgrades"
          checked={profile.automaticUpgrades === true}
          onChange={(event) => onChange({ automaticUpgrades: event.target.checked })}
        />
        <SettingsModalField label="Upgrade interval" htmlFor="quality-upgrade-interval" hint="Days between checks for each track.">
          <SettingsInput
            id="quality-upgrade-interval"
            type="number"
            min="1"
            max="365"
            value={profile.intervalDays ?? 2}
            disabled={profile.automaticUpgrades !== true}
            onChange={(event) => onChange({ intervalDays: Number.parseInt(event.target.value, 10) || 2 })}
          />
        </SettingsModalField>
      </SettingsModalSection>
    </SettingsIntegrationModal>
  );
}
