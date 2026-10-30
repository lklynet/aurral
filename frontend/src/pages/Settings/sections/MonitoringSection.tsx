import { useState } from "react";
import { useMutation, useQuery } from "@tanstack/react-query";
import { parseResponse, type InferResponseType } from "hono/client";
import { DotLoader } from "../../../components/DotLoader";
import { MonitoringRulesFields } from "../../../components/MonitoringRulesFields";
import PillToggle from "../../../components/PillToggle";
import { queryClient, queryKeys } from "../../../queryClient.ts";
import type { AppSettings } from "../../../../../backend/db/helpers/settings.ts";
import type { MonitoringExclusion } from "../../../../../backend/services/aurralMonitoringStore.ts";
import { libraryMonitoringClient } from "../../../utils/api/clients/libraryMonitoring.ts";
import { slowLibraryFetch } from "../../../utils/api/endpoints/library.ts";
import { describeAurralMonitoringError } from "../../../utils/aurralMonitoring.ts";
import { formatDate } from "../../../utils/dateTime";
import {
  describeDownloadCount,
  describeMonitoringRules,
  plural,
} from "../../../utils/monitoringRules.ts";
import { SettingsInput } from "../components/SettingsField";
import { useServerSettings } from "../SettingsProviders";
import {
  SettingsActions,
  SettingsGroup,
  SettingsNote,
  SettingsPage,
  SettingsRow,
  SettingsServiceRow,
  useSettingsItem,
} from "../SettingsLayout";

type MissingTrackSearch = Partial<NonNullable<AppSettings["missingTrackSearch"]>>;
type MonitoringDefaults = InferResponseType<
  typeof libraryMonitoringClient.monitoring.defaults.$get,
  200
>;
type MonitoringPreview = InferResponseType<
  typeof libraryMonitoringClient.monitoring.defaults.preview.$post,
  200
>;

const DEFAULTS_ITEM = "defaults";

const sameRules = (left: unknown, right: unknown) => JSON.stringify(left) === JSON.stringify(right);

const shortDate = (timestamp: number) => formatDate(new Date(timestamp), { dateStyle: "medium" });

function useMonitoringDefaults() {
  return useQuery({
    queryKey: queryKeys.monitoringDefaults,
    queryFn: ({ signal }) =>
      parseResponse(
        libraryMonitoringClient.monitoring.defaults.$get(undefined, { init: { signal } }),
      ),
  });
}

function QueryFallback({
  query,
  what,
}: {
  query: { isError: boolean; refetch: () => unknown };
  what: string;
}) {
  if (!query.isError) {
    return (
      <p className="settings-loading">
        <DotLoader size="sm" label={null} /> Loading…
      </p>
    );
  }
  return (
    <SettingsNote tone="warning">
      Couldn&apos;t load {what}.{" "}
      <button type="button" className="settings-link" onClick={() => query.refetch()}>
        Try again
      </button>
    </SettingsNote>
  );
}

function DefaultRulesForm({ defaults }: { defaults: MonitoringDefaults }) {
  const { showSuccess, showError } = useServerSettings();
  const [rules, setRules] = useState(defaults.rules);
  const [review, setReview] = useState<MonitoringPreview | null>(null);
  const [busy, setBusy] = useState(false);
  const changed = !sameRules(rules, defaults.rules);

  const save = async () => {
    setBusy(true);
    try {
      await parseResponse(libraryMonitoringClient.monitoring.defaults.$put({ json: { rules } }));
      const artistCount = review?.artistCount ?? defaults.artistCount;
      showSuccess(
        artistCount
          ? `Default rules saved. Aurral is applying them to ${plural(artistCount, "artist")}.`
          : "Default rules saved",
      );
      setReview(null);
      await queryClient.invalidateQueries({ queryKey: queryKeys.monitoringDefaults });
    } catch (error) {
      showError(
        `Could not save the default rules. Nothing changed. ${describeAurralMonitoringError(error, "Try again.")}`,
      );
    } finally {
      setBusy(false);
    }
  };

  const reviewChanges = async () => {
    if (!defaults.artistCount) {
      await save();
      return;
    }
    setBusy(true);
    try {
      setReview(
        await parseResponse(
          libraryMonitoringClient.monitoring.defaults.preview.$post(
            { json: { rules } },
            { fetch: slowLibraryFetch },
          ),
        ),
      );
    } catch (error) {
      showError(
        `Could not check the new rules. Nothing changed. ${describeAurralMonitoringError(error, "Try again.")}`,
      );
    } finally {
      setBusy(false);
    }
  };

  const downloads = review
    ? describeDownloadCount({ releases: review.releaseCount, tracks: review.trackCount })
    : "";

  return (
    <SettingsGroup
      note={`Used by ${plural(defaults.artistCount, "artist")}.${defaults.updatedAt ? ` Changed ${shortDate(defaults.updatedAt)}.` : ""}`}
    >
      <MonitoringRulesFields
        rules={rules}
        disabled={busy}
        onChange={(next) => {
          setRules(next);
          setReview(null);
        }}
      />
      {review ? (
        <SettingsNote>
          {plural(review.artistCount, "artist uses", "artists use")} the default rules.
          {downloads
            ? ` Aurral will download ${downloads} for them.`
            : " Nothing new downloads for them now."}
          {review.failedArtistCount
            ? ` ${plural(review.failedArtistCount, "artist")} could not be checked and will be checked again tomorrow.`
            : ""}{" "}
          Releases and tracks already in your library stay.
        </SettingsNote>
      ) : null}
      <SettingsActions>
        <button
          type="button"
          className="btn btn-primary btn-sm"
          disabled={!changed || busy}
          onClick={review ? save : reviewChanges}
        >
          {busy ? <DotLoader size="xs" label={null} /> : null}
          {review ? `Apply to ${plural(review.artistCount, "artist")}` : "Save"}
        </button>
      </SettingsActions>
    </SettingsGroup>
  );
}

function DefaultRulesPage() {
  const query = useMonitoringDefaults();
  const defaults = query.data;
  return (
    <SettingsPage title="Default rules" back="Monitoring">
      {defaults ? (
        <DefaultRulesForm key={defaults.updatedAt ?? 0} defaults={defaults} />
      ) : (
        <QueryFallback query={query} what="the default rules" />
      )}
    </SettingsPage>
  );
}

function DefaultRulesGroup() {
  const query = useMonitoringDefaults();
  const defaults = query.data;
  return (
    <SettingsGroup
      title="Default rules"
      note="For monitored artists without their own rules. Lidarr artists use Lidarr rules."
    >
      {defaults ? (
        <SettingsServiceRow
          to={`monitoring/${DEFAULTS_ITEM}`}
          name={describeMonitoringRules(defaults.rules) || "Default rules"}
          status={{
            label: plural(defaults.artistCount, "artist"),
            tone: defaults.artistCount ? "default" : "muted",
          }}
        />
      ) : (
        <QueryFallback query={query} what="the default rules" />
      )}
    </SettingsGroup>
  );
}

function MissingTracksGroup() {
  const { settings, updateSettings } = useServerSettings();
  const [intervalDraft, setIntervalDraft] = useState<string | null>(null);
  const missingTrackSearch: MissingTrackSearch = settings.missingTrackSearch || {};
  const enabled = missingTrackSearch.enabled === true;
  const update = (patch: MissingTrackSearch) =>
    updateSettings({ ...settings, missingTrackSearch: { ...missingTrackSearch, ...patch } });

  return (
    <SettingsGroup title="Missing tracks">
      <SettingsRow
        label="Search again for missing tracks"
        htmlFor="missing-track-search"
        help="Retries missing tracks from monitored albums."
      >
        <PillToggle
          id="missing-track-search"
          checked={enabled}
          aria-label="Search again for missing tracks"
          onChange={(event) => update({ enabled: event.target.checked })}
        />
      </SettingsRow>
      <SettingsRow
        label="Search interval"
        htmlFor="missing-track-search-interval"
        help="Days after the last search or download, checked daily. Cancelled albums need Retry."
      >
        <SettingsInput
          id="missing-track-search-interval"
          type="number"
          min="1"
          max="365"
          value={intervalDraft ?? missingTrackSearch.intervalDays ?? 1}
          disabled={!enabled}
          onChange={(event) => {
            setIntervalDraft(event.target.value);
            if (event.target.value !== "" && event.target.validity.valid) {
              update({ intervalDays: Number(event.target.value) });
            }
          }}
          onBlur={(event) => {
            const days = Math.round(Number(event.target.value));
            if (
              event.target.value !== "" &&
              Number.isFinite(days) &&
              !event.target.validity.valid
            ) {
              const { min, max } = event.target;
              update({ intervalDays: Math.min(Number(max), Math.max(Number(min), days)) });
            }
            setIntervalDraft(null);
          }}
        />
      </SettingsRow>
    </SettingsGroup>
  );
}

function RemovedGroup() {
  const { showError } = useServerSettings();
  const query = useQuery({
    queryKey: queryKeys.monitoringExclusions(null),
    queryFn: ({ signal }) =>
      parseResponse(
        libraryMonitoringClient.monitoring.exclusions.$get({ query: {} }, { init: { signal } }),
      ),
  });
  const allow = useMutation({
    mutationFn: (exclusion: MonitoringExclusion) =>
      parseResponse(
        libraryMonitoringClient.monitoring.exclusions[":id"].$delete({
          param: { id: encodeURIComponent(exclusion.id) },
        }),
      ),
    onSuccess: () =>
      queryClient.invalidateQueries({ queryKey: queryKeys.monitoringExclusionsPrefix }),
    onError: (error, exclusion) =>
      showError(
        `Could not allow ${exclusion.title} again. Nothing changed. ${describeAurralMonitoringError(error, "Try again.")}`,
      ),
  });
  const exclusions = query.data ?? [];

  return (
    <SettingsGroup
      title="Removed from monitoring"
      note="Deleted releases and tracks stay excluded until you request them or allow them again."
    >
      {query.isPending || query.isError ? (
        <QueryFallback query={query} what="removed releases" />
      ) : exclusions.length === 0 ? (
        <p className="settings-group__note">No deleted releases or tracks.</p>
      ) : (
        <div className="settings-table-wrap">
          <table className="settings-table">
            <thead>
              <tr>
                <th scope="col">Title</th>
                <th scope="col">Artist</th>
                <th scope="col">Type</th>
                <th scope="col">Removed</th>
                <th scope="col" className="settings-table__actions">
                  <span className="sr-only">Actions</span>
                </th>
              </tr>
            </thead>
            <tbody>
              {exclusions.map((exclusion) => (
                <tr key={exclusion.id}>
                  <td>{exclusion.title}</td>
                  <td className="settings-row__value">
                    {exclusion.artistName || "Unknown artist"}
                  </td>
                  <td className="settings-row__value">
                    {exclusion.kind === "album" ? "Release" : "Track"}
                  </td>
                  <td className="settings-row__value">
                    {exclusion.createdAt ? shortDate(exclusion.createdAt) : ""}
                  </td>
                  <td className="settings-table__actions">
                    <button
                      type="button"
                      className="btn btn-secondary btn-sm"
                      disabled={allow.isPending}
                      onClick={() => allow.mutate(exclusion)}
                    >
                      {allow.isPending && allow.variables?.id === exclusion.id ? (
                        <DotLoader size="xs" label={null} />
                      ) : null}
                      Allow again
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </SettingsGroup>
  );
}

export function MonitoringSection() {
  const item = useSettingsItem();
  if (item === DEFAULTS_ITEM) return <DefaultRulesPage />;
  return (
    <SettingsPage title="Monitoring">
      <DefaultRulesGroup />
      <MissingTracksGroup />
      <RemovedGroup />
    </SettingsPage>
  );
}
