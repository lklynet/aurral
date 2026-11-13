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
import {
  SettingsAdvancedGroup,
  SettingsGroup,
  SettingsPage,
  SettingsRow,
  type ServiceStatus,
} from "../../SettingsLayout";
import type { QualityProfile } from "../../../../../../backend/db/helpers/settings.ts";
import {
  QUALITY_PRESETS,
  QUALITY_TIERS,
  qualityPresetOf,
  type QualityPreset,
} from "../../../../../../lib/qualityTiers.ts";

type ServerSettings = ReturnType<typeof useServerSettings>;

const PRESET_OPTIONS = [
  {
    value: "lossless",
    label: "Lossless",
    help: "FLAC first. Falls back to MP3 or AAC when FLAC isn't found.",
  },
  {
    value: "smaller",
    label: "Smaller files",
    help: "MP3 and AAC first, best bitrate first. FLAC only when nothing else is found.",
  },
] satisfies { value: QualityPreset; label: string; help: string }[];

const CUSTOM_OPTION = {
  value: "custom",
  label: "Custom",
  help: "Your own tiers from Advanced. Pick a choice to replace them.",
};

const tierLabel = (id: string) => QUALITY_TIERS.find((tier) => tier.id === id)?.label ?? id;

function readQualityProfile(settings: ServerSettings["settings"]) {
  const profile: Partial<QualityProfile> = settings.qualityProfile || {};
  const order = Array.isArray(profile.order) ? profile.order : QUALITY_TIERS.map((tier) => tier.id);
  const enabled = new Set(Array.isArray(profile.enabled) ? profile.enabled : order);
  const preset = qualityPresetOf({ order, enabled: [...enabled], cutoff: profile.cutoff ?? "" });
  const choice = PRESET_OPTIONS.find((option) => option.value === preset) ?? CUSTOM_OPTION;
  return { profile, order, enabled, choice };
}

export function qualityServiceStatus(settings: ServerSettings["settings"]): ServiceStatus {
  return { label: readQualityProfile(settings).choice.label };
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
  const { profile, order, enabled, choice } = readQualityProfile(settings);
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

  const choose = (value: string) => {
    const preset = PRESET_OPTIONS.find((option) => option.value === value)?.value;
    if (!preset) return;
    const tiers = QUALITY_PRESETS[preset];
    update({ order: [...tiers.order], enabled: [...tiers.enabled], cutoff: tiers.cutoff });
  };

  const handleDragEnd = ({ active, over }: DragEndEvent) => {
    if (!over || active.id === over.id) return;
    update({
      order: arrayMove(order, order.indexOf(String(active.id)), order.indexOf(String(over.id))),
    });
  };

  return (
    <SettingsPage title="Quality" back="Downloads">
      <SettingsGroup>
        <SettingsRow label="Prefer" htmlFor="quality-preset" help={choice.help}>
          <Select
            id="quality-preset"
            value={choice.value}
            onChange={choose}
            options={[...PRESET_OPTIONS, ...(choice === CUSTOM_OPTION ? [CUSTOM_OPTION] : [])].map(
              ({ value, label }) => ({ value, label }),
            )}
          />
        </SettingsRow>
      </SettingsGroup>
      <SettingsAdvancedGroup>
        <p className="settings-group__note">
          Rank best first. Downloads use allowed qualities, and upgrades stop at the cutoff.
        </p>
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
      </SettingsAdvancedGroup>
    </SettingsPage>
  );
}
