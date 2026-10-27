import { useEffect, useId, useMemo, useState } from "react";
import { keepPreviousData, useMutation, useQuery } from "@tanstack/react-query";
import { parseResponse } from "hono/client";
import PillToggle from "./PillToggle";
import { DotLoader } from "./DotLoader";
import { MonitoringRulesFields, type MonitoringRules } from "./MonitoringRulesFields";
import { useModalDialog } from "../hooks/useModalDialog.ts";
import { queryClient, queryKeys } from "../queryClient.ts";
import { libraryMonitoringClient } from "../utils/api/clients/libraryMonitoring.ts";
import { slowLibraryFetch } from "../utils/api/endpoints/library.ts";
import { describeAurralMonitoringError } from "../utils/aurralMonitoring.ts";
import {
  RELEASE_SKIP_REASONS,
  TRACK_SKIP_REASONS,
  describeDownloadCount,
  plural,
} from "../utils/monitoringRules.ts";
import "./MonitoringRules.css";

const PREVIEW_DELAY_MS = 400;

type ReleaseSkipReason = keyof typeof RELEASE_SKIP_REASONS;
type TrackSkipReason = keyof typeof TRACK_SKIP_REASONS;

interface ArtistMonitoringState {
  monitored: boolean;
  useDefault: boolean;
  rules: MonitoringRules | null;
  defaultRules: MonitoringRules;
}

interface ArtistMonitoringRequest {
  monitored: boolean;
  useDefault: boolean;
  rules?: MonitoringRules | null;
}

interface PlannedRelease {
  id: string;
  title: string;
  type: string | null;
  secondaryTypes: string[];
  releaseDate: string | null;
  existing: boolean;
}

interface MonitoringPlan {
  releases: PlannedRelease[];
  topTracks: { title: string; albumName: string | null }[];
  skipped: { title: string; reason: ReleaseSkipReason }[];
  skippedTracks: { title: string; reason: TrackSkipReason }[];
  topTracksError: string | null;
}

interface ArtistMonitoringPreview extends ArtistMonitoringState {
  monitoring: MonitoringPlan;
}

interface MonitoringExclusion {
  id: number;
  kind: string;
  title: string;
}

const releaseKind = (release: PlannedRelease) =>
  [...(release.secondaryTypes || []), release.type].filter(Boolean).join(" ") || "Release";

const releaseMeta = (release: PlannedRelease) =>
  [
    releaseKind(release),
    String(release.releaseDate || "").slice(0, 4),
    release.existing ? "Missing tracks" : null,
  ]
    .filter(Boolean)
    .join(" · ");

function useDebounced<T>(value: T) {
  const [debounced, setDebounced] = useState(value);
  useEffect(() => {
    const timer = window.setTimeout(() => setDebounced(value), PREVIEW_DELAY_MS);
    return () => window.clearTimeout(timer);
  }, [value]);
  return debounced;
}

interface MonitoringPreviewProps {
  mbid: string;
  artistName: string;
  request: ArtistMonitoringRequest;
}

function MonitoringPreview({ mbid, artistName, request }: MonitoringPreviewProps) {
  const debounced = useDebounced(request);
  const pending = debounced !== request;
  const preview = useQuery<ArtistMonitoringPreview>({
    queryKey: [...queryKeys.artistMonitoring(mbid), "preview", debounced],
    queryFn: ({ signal }) =>
      parseResponse(
        libraryMonitoringClient.artists[":mbid"].monitoring.preview.$post(
          {
            param: { mbid: encodeURIComponent(mbid) },
            json: { monitoring: debounced, artistName },
          },
          { fetch: slowLibraryFetch, init: { signal } },
        ),
      ),
    placeholderData: keepPreviousData,
    retry: false,
    staleTime: 30_000,
  });
  const plan = preview.data?.monitoring;
  const rules = preview.data?.rules;
  const releases = plan?.releases || [];
  const topTracks = plan?.topTracks || [];
  const skipped = [
    ...(plan?.skipped || []).map((entry) => ({
      title: entry.title,
      reason: RELEASE_SKIP_REASONS[entry.reason],
    })),
    ...(plan?.skippedTracks || []).map((entry) => ({
      title: entry.title,
      reason: TRACK_SKIP_REASONS[entry.reason],
    })),
  ];
  const downloads = describeDownloadCount({ releases: releases.length, tracks: topTracks.length });
  const later = rules?.newReleases ? " New releases download when they come out." : "";

  return (
    <section
      className="monitoring-preview"
      aria-live="polite"
      aria-busy={pending || preview.isFetching}
    >
      <h4 className="monitoring-preview__title">What Aurral downloads</h4>
      {preview.isError && !pending ? (
        <p className="monitoring-preview__status monitoring-preview__status--error" role="alert">
          {describeAurralMonitoringError(
            preview.error,
            "Could not check this artist's releases. Try again.",
          )}
        </p>
      ) : !plan ? (
        <p className="monitoring-preview__status">
          <DotLoader size="sm" label={null} />
          Checking releases
        </p>
      ) : (
        <>
          <p className="monitoring-preview__summary">
            {downloads ? `Downloads ${downloads}.${later}` : `Nothing to download now.${later}`}
            {pending || preview.isFetching ? " Updating…" : ""}
          </p>
          {plan.topTracksError ? (
            <p className="monitoring-preview__summary">{plan.topTracksError}</p>
          ) : null}
          {releases.length ? (
            <ul className="monitoring-preview__list">
              {releases.map((release) => (
                <li key={release.id} className="monitoring-preview__item">
                  <span className="monitoring-preview__item-title">{release.title}</span>
                  <span className="monitoring-preview__item-meta">{releaseMeta(release)}</span>
                </li>
              ))}
            </ul>
          ) : null}
          {topTracks.length ? (
            <>
              <h5 className="monitoring-preview__group-title">Top tracks</h5>
              <ul className="monitoring-preview__list">
                {topTracks.map((track) => (
                  <li key={track.title} className="monitoring-preview__item">
                    <span className="monitoring-preview__item-title">{track.title}</span>
                    {track.albumName ? (
                      <span className="monitoring-preview__item-meta">{track.albumName}</span>
                    ) : null}
                  </li>
                ))}
              </ul>
            </>
          ) : null}
          {skipped.length ? (
            <details>
              <summary>{plural(skipped.length, "item")} skipped</summary>
              <ul className="monitoring-preview__list">
                {skipped.map((entry, index) => (
                  <li key={`${entry.title}:${index}`} className="monitoring-preview__item">
                    <span className="monitoring-preview__item-title">{entry.title}</span>
                    <span className="monitoring-preview__item-meta">
                      {entry.reason || "Skipped"}
                    </span>
                  </li>
                ))}
              </ul>
            </details>
          ) : null}
        </>
      )}
    </section>
  );
}

interface MonitoringExclusionsProps {
  mbid: string;
  onError: (message: string) => void;
}

function MonitoringExclusions({ mbid, onError }: MonitoringExclusionsProps) {
  const exclusionsQuery = useQuery<MonitoringExclusion[]>({
    queryKey: queryKeys.monitoringExclusions(mbid),
    queryFn: ({ signal }) =>
      parseResponse(
        libraryMonitoringClient.monitoring.exclusions.$get(
          { query: { artistMbid: mbid } },
          { init: { signal } },
        ),
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
      Promise.all([
        queryClient.invalidateQueries({ queryKey: queryKeys.monitoringExclusionsPrefix }),
        queryClient.invalidateQueries({
          queryKey: [...queryKeys.artistMonitoring(mbid), "preview"],
        }),
      ]),
    onError: (error, exclusion) =>
      onError(
        `Could not allow ${exclusion.title} again. Nothing changed. ${describeAurralMonitoringError(error, "Try again.")}`,
      ),
  });
  const exclusions = Array.isArray(exclusionsQuery.data) ? exclusionsQuery.data : [];
  if (exclusionsQuery.isError) {
    return (
      <section className="monitoring-preview">
        <h4 className="monitoring-preview__title">Removed from monitoring</h4>
        <p className="monitoring-preview__status monitoring-preview__status--error" role="alert">
          Could not load what you removed from monitoring.
        </p>
        <button
          type="button"
          className="btn btn-secondary btn-sm monitoring-preview__retry"
          disabled={exclusionsQuery.isFetching}
          onClick={() => exclusionsQuery.refetch()}
        >
          {exclusionsQuery.isFetching ? <DotLoader size="sm" label={null} /> : null}
          Try again
        </button>
      </section>
    );
  }
  if (!exclusions.length) return null;

  return (
    <section className="monitoring-preview">
      <h4 className="monitoring-preview__title">Removed from monitoring</h4>
      <p className="monitoring-preview__summary">Deleted items stay out of monitoring.</p>
      <ul className="monitoring-preview__list">
        {exclusions.map((exclusion) => (
          <li key={exclusion.id} className="monitoring-preview__item monitoring-exclusions__item">
            <span className="monitoring-preview__item-title">
              {exclusion.title}
              <span className="monitoring-preview__item-meta">
                {" "}
                · {exclusion.kind === "album" ? "Release" : "Track"}
              </span>
            </span>
            <button
              type="button"
              className="btn btn-secondary btn-sm"
              disabled={allow.isPending}
              onClick={() => allow.mutate(exclusion)}
            >
              {allow.isPending && allow.variables?.id === exclusion.id ? (
                <DotLoader size="sm" label={null} />
              ) : null}
              Allow again
            </button>
          </li>
        ))}
      </ul>
    </section>
  );
}

interface RulesDialogProps {
  mbid: string;
  artistName: string;
  state?: ArtistMonitoringState | null;
  saving: boolean;
  onClose: () => void;
  onSave: (request: ArtistMonitoringRequest) => void;
  onError: (message: string) => void;
}

function RulesDialog({
  mbid,
  artistName,
  state,
  saving,
  onClose,
  onSave,
  onError,
}: RulesDialogProps) {
  const titleId = useId();
  const { dialogRef, handleBackdropClick } = useModalDialog({
    open: true,
    onClose,
    closeDisabled: saving,
  });
  const monitored = state?.monitored === true;
  const [useDefault, setUseDefault] = useState(!monitored || state?.useDefault !== false);
  const [customRules, setCustomRules] = useState(
    () => (monitored && state?.useDefault === false && state.rules) || state?.defaultRules,
  );
  const request = useMemo(
    () =>
      useDefault
        ? { monitored: true, useDefault: true }
        : { monitored: true, useDefault: false, rules: customRules },
    [customRules, useDefault],
  );
  const shownRules = useDefault ? state?.defaultRules : customRules;

  return (
    <div className="artist-modal-backdrop" onClick={handleBackdropClick}>
      <div
        ref={dialogRef}
        className="artist-modal monitoring-rules-dialog"
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        tabIndex={-1}
      >
        <div className="artist-modal__header">
          <div>
            <h3 id={titleId} className="artist-modal__title">
              Monitoring rules
            </h3>
            <p className="artist-modal__subcopy">{artistName}</p>
          </div>
        </div>
        <div className="monitoring-rules-dialog__body">
          <div className="monitoring-rules__toggle">
            <div>
              <span className="artist-field-label">Use the default rules</span>
              <p className="monitoring-rules__hint">
                Uses Settings defaults, including future changes.
              </p>
            </div>
            <PillToggle
              checked={useDefault}
              disabled={saving}
              aria-label="Use the default rules"
              onChange={(event: { target: { checked: boolean } }) =>
                setUseDefault(event.target.checked)
              }
            />
          </div>
          {shownRules ? (
            <MonitoringRulesFields
              rules={shownRules}
              onChange={setCustomRules}
              disabled={useDefault || saving}
            />
          ) : null}
          <MonitoringPreview mbid={mbid} artistName={artistName} request={request} />
          <MonitoringExclusions mbid={mbid} onError={onError} />
        </div>
        <div className="artist-modal__actions">
          <button type="button" className="btn btn-secondary" onClick={onClose} disabled={saving}>
            Cancel
          </button>
          <button
            type="button"
            className="btn btn-primary"
            onClick={() => onSave(request)}
            disabled={saving}
          >
            {saving ? <DotLoader size="sm" label={null} /> : null}
            {monitored ? "Save rules" : "Monitor artist"}
          </button>
        </div>
      </div>
    </div>
  );
}

interface ArtistMonitoringRulesDialogProps extends RulesDialogProps {
  open: boolean;
}

export function ArtistMonitoringRulesDialog({ open, ...props }: ArtistMonitoringRulesDialogProps) {
  return open ? <RulesDialog {...props} /> : null;
}
