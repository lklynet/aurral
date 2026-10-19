import { useState } from "react";
import { useMutation, useQuery } from "@tanstack/react-query";
import { DotLoader } from "../../../components/DotLoader";
import { MonitoringRulesFields } from "../../../components/MonitoringRulesFields";
import PillToggle from "../../../components/PillToggle";
import { queryClient, queryKeys } from "../../../queryClient.js";
import {
  getMonitoringDefaults,
  getMonitoringExclusions,
  previewMonitoringDefaults,
  removeMonitoringExclusion,
  saveMonitoringDefaults,
} from "../../../utils/api/endpoints/library.js";
import { describeAurralMonitoringError } from "../../../utils/aurralMonitoring.js";
import { describeDownloadCount, describeMonitoringRules, plural } from "../../../utils/monitoringRules.js";
import { SettingsArrFieldSet, SettingsArrFormGroup } from "./arr/SettingsArrLayout";
import { SettingsInput } from "./SettingsField";
import { IntegrationCard, SettingsIntegrationModal } from "./SettingsIntegrationCards";
import { SettingsModalCallout, SettingsModalIntro, SettingsModalSection } from "./SettingsModalLayout";

const sameRules = (left, right) => JSON.stringify(left) === JSON.stringify(right);

const formatDate = (timestamp) =>
  timestamp ? new Date(timestamp).toLocaleDateString(undefined, { dateStyle: "medium" }) : "";

function DefaultRulesModal({ defaults, onClose, onSaved, showError }) {
  const [rules, setRules] = useState(defaults.rules);
  const [review, setReview] = useState(null);
  const [busy, setBusy] = useState(false);

  const save = async () => {
    setBusy(true);
    try {
      await saveMonitoringDefaults(rules);
      await onSaved(review?.artistCount ?? defaults.artistCount);
    } catch (error) {
      showError(`Could not save the default rules. Nothing changed. ${describeAurralMonitoringError(error, "Try again.")}`);
      setBusy(false);
    }
  };

  const reviewChanges = async () => {
    if (sameRules(rules, defaults.rules)) {
      onClose();
      return;
    }
    if (!defaults.artistCount) {
      await save();
      return;
    }
    setBusy(true);
    try {
      setReview(await previewMonitoringDefaults(rules));
    } catch (error) {
      showError(`Could not check the new rules. Nothing changed. ${describeAurralMonitoringError(error, "Try again.")}`);
    } finally {
      setBusy(false);
    }
  };

  const downloads = review
    ? describeDownloadCount({ releases: review.releaseCount, tracks: review.trackCount })
    : "";

  return (
    <SettingsIntegrationModal
      title="Default rules"
      onClose={busy ? () => {} : onClose}
      footerActions={
        <>
          <button
            type="button"
            className="arr-btn"
            disabled={busy}
            onClick={review ? () => setReview(null) : onClose}
          >
            {review ? "Back" : "Cancel"}
          </button>
          <button type="button" className="arr-btn arr-btn--primary" disabled={busy} onClick={review ? save : reviewChanges}>
            {busy ? <DotLoader size="sm" label={null} /> : null}
            {review ? `Apply to ${plural(review.artistCount, "artist")}` : "Save"}
          </button>
        </>
      }
    >
      {review ? (
        <SettingsModalCallout>
          <p>
            {plural(review.artistCount, "artist uses", "artists use")} the default rules.
            {downloads ? ` Aurral will download ${downloads} for them.` : " Nothing new downloads for them now."}
            {review.failedArtistCount
              ? ` ${plural(review.failedArtistCount, "artist")} could not be checked and will be checked again tomorrow.`
              : ""}
          </p>
          <p>Releases and tracks already in your library stay.</p>
        </SettingsModalCallout>
      ) : (
        <>
          <SettingsModalIntro>
            Changes apply to all artists using defaults when you save.
          </SettingsModalIntro>
          <SettingsModalSection>
            <MonitoringRulesFields rules={rules} onChange={setRules} disabled={busy} />
          </SettingsModalSection>
        </>
      )}
    </SettingsIntegrationModal>
  );
}

function ExclusionsTable({ showError }) {
  const exclusionsQuery = useQuery({
    queryKey: queryKeys.monitoringExclusions(null),
    queryFn: ({ signal }) => getMonitoringExclusions({ signal }),
  });
  const allow = useMutation({
    mutationFn: (exclusion) => removeMonitoringExclusion(exclusion.id),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: queryKeys.monitoringExclusionsPrefix }),
    onError: (error, exclusion) =>
      showError(`Could not allow ${exclusion.title} again. Nothing changed. ${describeAurralMonitoringError(error, "Try again.")}`),
  });
  const exclusions = Array.isArray(exclusionsQuery.data) ? exclusionsQuery.data : [];

  return (
    <div className="arr-table-wrap">
      <table className="arr-table">
        <thead>
          <tr>
            <th scope="col">Title</th>
            <th scope="col">Artist</th>
            <th scope="col">Type</th>
            <th scope="col">Removed</th>
            <th scope="col" className="arr-table__actions-head">
              <span className="sr-only">Actions</span>
            </th>
          </tr>
        </thead>
        <tbody>
          {exclusionsQuery.isPending ? (
            <tr className="arr-table__empty-row">
              <td colSpan={5}>
                <DotLoader size="sm" label={null} /> Loading…
              </td>
            </tr>
          ) : exclusionsQuery.isError ? (
            <tr className="arr-table__empty-row">
              <td colSpan={5}>Could not load removed releases. Reload the page to try again.</td>
            </tr>
          ) : exclusions.length === 0 ? (
            <tr className="arr-table__empty-row">
              <td colSpan={5}>No deleted releases or tracks.</td>
            </tr>
          ) : (
            exclusions.map((exclusion) => (
              <tr key={exclusion.id}>
                <td>{exclusion.title}</td>
                <td><span className="arr-table__path">{exclusion.artistName || "Unknown artist"}</span></td>
                <td><span className="arr-table__path">{exclusion.kind === "album" ? "Release" : "Track"}</span></td>
                <td><span className="arr-table__path">{formatDate(exclusion.createdAt)}</span></td>
                <td className="arr-table__actions">
                  <div className="arr-table__actions-inner">
                    <button
                      type="button"
                      className="arr-btn"
                      disabled={allow.isPending}
                      onClick={() => allow.mutate(exclusion)}
                    >
                      {allow.isPending && allow.variables?.id === exclusion.id ? <DotLoader size="sm" label={null} /> : null}
                      Allow again
                    </button>
                  </div>
                </td>
              </tr>
            ))
          )}
        </tbody>
      </table>
    </div>
  );
}

export function SettingsMonitoringTab({ settings, updateSettings, showSuccess, showError }) {
  const [editing, setEditing] = useState(false);
  const [intervalDraft, setIntervalDraft] = useState(null);
  const defaultsQuery = useQuery({
    queryKey: queryKeys.monitoringDefaults,
    queryFn: ({ signal }) => getMonitoringDefaults({ signal }),
  });
  const defaults = defaultsQuery.data;
  const missingTrackSearch = settings.missingTrackSearch || {};
  const updateMissingTrackSearch = (patch) =>
    updateSettings({ ...settings, missingTrackSearch: { ...missingTrackSearch, ...patch } });

  return (
    <div className="arr-page">
      <div className="arr-form">
        <SettingsArrFieldSet legend="Default rules">
          <div className="arr-info">
            Default download rules for monitored artists. Artist-specific rules override them. Lidarr artists use Lidarr rules.
          </div>
          {defaults ? (
            <IntegrationCard
              title="Default rules"
              subtitle={describeMonitoringRules(defaults.rules)}
              status={{
                label: plural(defaults.artistCount, "artist"),
                className: defaults.artistCount ? "is-enabled" : "",
              }}
              meta={defaults.updatedAt ? `Changed ${formatDate(defaults.updatedAt)}` : null}
              onClick={() => setEditing(true)}
            />
          ) : defaultsQuery.isError ? (
            <p className="arr-form-help arr-form-help--warning">
              Could not load the default rules. Reload the page to try again.
            </p>
          ) : (
            <DotLoader size="sm" label="Loading default rules" />
          )}
        </SettingsArrFieldSet>

        <SettingsArrFieldSet legend="Missing tracks">
          <SettingsArrFormGroup
            label="Search again for missing tracks"
            help="Retries missing tracks from monitored albums."
          >
            <PillToggle
              className="settings-toggle"
              checked={missingTrackSearch.enabled === true}
              onChange={(event) => updateMissingTrackSearch({ enabled: event.target.checked })}
              aria-label="Search again for missing tracks"
            />
          </SettingsArrFormGroup>
          <SettingsArrFormGroup
            label="Search interval"
            labelFor="missing-track-search-interval"
            help="Days after the last search or download, checked daily. Cancelled albums require Retry."
          >
            <SettingsInput
              id="missing-track-search-interval"
              type="number"
              min="1"
              max="365"
              value={intervalDraft ?? missingTrackSearch.intervalDays ?? 1}
              disabled={missingTrackSearch.enabled !== true}
              onChange={(event) => {
                setIntervalDraft(event.target.value);
                if (event.target.value !== "" && event.target.validity.valid) {
                  updateMissingTrackSearch({ intervalDays: Number(event.target.value) });
                }
              }}
              onBlur={(event) => {
                const days = Math.round(Number(event.target.value));
                if (event.target.value !== "" && Number.isFinite(days) && !event.target.validity.valid) {
                  const { min, max } = event.target;
                  updateMissingTrackSearch({ intervalDays: Math.min(Number(max), Math.max(Number(min), days)) });
                }
                setIntervalDraft(null);
              }}
            />
          </SettingsArrFormGroup>
        </SettingsArrFieldSet>

        <SettingsArrFieldSet legend="Removed from monitoring">
          <div className="arr-info">
            Deleted releases and tracks stay excluded until you request them or choose Allow again.
          </div>
          <ExclusionsTable showError={showError} />
        </SettingsArrFieldSet>
      </div>

      {editing && defaults ? (
        <DefaultRulesModal
          defaults={defaults}
          showError={showError}
          onClose={() => setEditing(false)}
          onSaved={async (artistCount) => {
            setEditing(false);
            showSuccess(
              artistCount
                ? `Default rules saved. Aurral is applying them to ${plural(artistCount, "artist")}.`
                : "Default rules saved",
            );
            await queryClient.invalidateQueries({ queryKey: queryKeys.monitoringDefaults });
          }}
        />
      ) : null}
    </div>
  );
}
