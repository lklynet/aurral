import { useEffect, useId, useState, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { useQuery } from "@tanstack/react-query";
import { parseResponse } from "hono/client";
import { ArrowRight, X } from "../../../components/icons";
import { ConfirmModal } from "../../../components/ConfirmModal";
import { DotLoader } from "../../../components/DotLoader";
import TooltipButton from "../../../components/TooltipButton";
import { useModalDialog } from "../../../hooks/useModalDialog.ts";
import { getApiErrorText } from "../../../utils/api/errors.ts";
import { asApiError } from "../../../utils/api/core.ts";
import { libraryFilesClient } from "../../../utils/api/clients/libraryFiles.ts";
import {
  ACTIVE_LIBRARY_FILE_STATUSES,
  libraryFilesQueryKey,
} from "../../../hooks/useLibraryFileOperation.ts";
import { SettingsActions, SettingsRow } from "../SettingsLayout";
import "./LibraryFileOperation.css";

const PAGE_SIZE = 50;
const TAG_IT_YOURSELF = "https://docs.aurral.org/using/library/#tag-a-file-yourself";

type Group = {
  id: string;
  label: string;
  statuses: string[];
  about?: ReactNode;
};

const SKIPPED: Group = { id: "skipped", label: "Skipped", statuses: ["skipped", "conflict"] };
const FAILED: Group = { id: "failed", label: "Failed", statuses: ["failed"] };

const GROUPS = {
  ingest: [
    { id: "duplicate", label: "Already in the Library", statuses: ["duplicate"] },
    SKIPPED,
    FAILED,
  ],
  cleanup: [
    { id: "duplicate", label: "Duplicate copies", statuses: ["duplicate"] },
    {
      id: "unmatched",
      label: "No MusicBrainz match",
      statuses: ["unmatched"],
      about: (
        <>
          Tags stay as they are. Tag these files with MusicBrainz Picard, then run a full scan.{" "}
          <a href={TAG_IT_YOURSELF} target="_blank" rel="noopener noreferrer">
            How to tag a file
          </a>
        </>
      ),
    },
    SKIPPED,
    FAILED,
  ],
} satisfies Record<string, Group[]>;

const RUNNING = { move: "Moving files", copy: "Copying files", hardlink: "Linking files" };

type FileOperationBase = {
  id: number;
  status: string;
  summary: {
    unchanged?: number;
    removingSources?: number | null;
    monitor?: string;
    doubles?: string;
  };
  counts: Record<string, number>;
  progress: { done: number; total: number };
  sources?: { removable: number; removed: number } | null;
  error?: string | null;
  updatedAt: number;
  finishedAt?: number | null;
};

type FileOperation =
  | (FileOperationBase & {
      kind: "ingest";
      options: { mode: "move" | "copy" | "hardlink" } | null;
    })
  | (FileOperationBase & {
      kind: "cleanup";
      options: { mode?: undefined } | null;
    });

type LibraryFileOperationItem = {
  position: number;
  status: string;
  reason?: string | null;
  source: string;
  target: string | null;
};

const count = (value: number) => value.toLocaleString();
const plural = (value: number, word: string) => `${count(value)} ${word}${value === 1 ? "" : "s"}`;
const duplicateCopies = (value: number) =>
  `${count(value)} duplicate ${value === 1 ? "copy" : "copies"}`;

const REMOVAL = {
  ingest: {
    question: (value: number) => `Remove ${plural(value, "source file")} already in the Library?`,
    notes: "Deletes source files after checking them against the Library copy.",
    action: "Remove source files",
    failed: "Aurral could not remove the source files. Nothing was removed.",
    removed: (value: number) => `Removed ${plural(value, "source file")}.`,
  },
  cleanup: {
    question: (value: number) => `Remove ${duplicateCopies(value)}?`,
    notes: "Keeps the better copy. Playlists and favorites move to it.",
    action: "Remove duplicates",
    failed: "Aurral could not remove the duplicates. Nothing was removed.",
    removed: (value: number) => `Removed ${duplicateCopies(value)}.`,
  },
};

const countOf = (counts: Record<string, number> | undefined, statuses: string[]) =>
  statuses.reduce((sum, status) => sum + Number(counts?.[status] || 0), 0);

const errorText = (error: unknown, fallback: string) =>
  getApiErrorText(error, "message") || asApiError(error)?.message || fallback;

function describeRunning(operation: FileOperation) {
  if (operation.summary?.removingSources)
    return operation.kind === "ingest" ? "Removing source files" : "Removing duplicates";
  if (operation.status === "planning") return "Checking files";
  if (operation.kind !== "ingest") return "Cleaning up";
  return (operation.options && RUNNING[operation.options.mode]) || "Filing files";
}

function describeResult(operation: FileOperation) {
  const done = Number(operation.counts?.done || 0);
  const parts =
    operation.kind === "ingest"
      ? [done && `Filed ${plural(done, "file")}`]
      : [
          done && `Updated ${plural(done, "file")}`,
          operation.summary?.unchanged && `${count(operation.summary.unchanged)} already in order`,
        ];
  const result = parts.filter(Boolean).join(" · ");
  if (result) return result;
  return operation.kind === "ingest" ? "Nothing new to file." : "Nothing needed to change.";
}

const DAY = new Intl.DateTimeFormat(undefined, { month: "short", day: "numeric" });

function describeFinished(operation: FileOperation) {
  const day = DAY.format(operation.finishedAt || operation.updatedAt);
  if (operation.status === "failed") return `Stopped on ${day}`;
  if (operation.status === "cancelled") return `Stopped ${day}`;
  return `${operation.kind === "ingest" ? "Last import" : "Last run"} ${day}`;
}

function afterScanNote(operation: FileOperation) {
  if (operation.summary?.monitor === "pending")
    return "After scanning, Aurral checks for duplicates and monitors new tracks.";
  if (operation.summary?.doubles === "pending")
    return "After scanning, Aurral checks for duplicates.";
  return null;
}

// A reason can link to the docs as [text](https://docs.aurral.org/...). Only
// docs links render, so a file name that looks like a link stays text.
const DOCS_LINK = /\[([^\]]+)\]\((https:\/\/docs\.aurral\.org\/[^)\s]*)\)/;

function Reason({ text }: { text: string }) {
  const parts = text.split(DOCS_LINK);
  return (
    <p className="library-file-op__notes">
      {parts.map((part, index) => {
        if (index % 3 === 0) return part;
        if (index % 3 === 2) return null;
        return (
          <a key={index} href={parts[index + 1]} target="_blank" rel="noopener noreferrer">
            {part}
          </a>
        );
      })}
    </p>
  );
}

function OperationItem({
  item,
  showReason,
}: {
  item: LibraryFileOperationItem;
  showReason: boolean;
}) {
  return (
    <li className="library-file-op__item">
      <div className="library-file-op__paths">
        <code>{item.source}</code>
        {item.target && item.target !== item.source ? (
          <>
            <ArrowRight className="artist-icon-xs" aria-label="to" />
            <code>{item.target}</code>
          </>
        ) : null}
      </div>
      {showReason && item.reason ? <Reason text={item.reason} /> : null}
    </li>
  );
}

function ReviewDialog({
  operation,
  group,
  total,
  onClose,
}: {
  operation: FileOperation;
  group: Group;
  total: number;
  onClose: () => void;
}) {
  const titleId = useId();
  const { dialogRef, handleBackdropClick } = useModalDialog({ open: true, onClose });
  const [offset, setOffset] = useState(0);
  const items = useQuery({
    queryKey: [
      ...libraryFilesQueryKey,
      "items",
      operation.id,
      group.id,
      offset,
      operation.updatedAt,
    ],
    queryFn: () =>
      parseResponse(
        libraryFilesClient.files.operations[":id"].items.$get({
          param: { id: encodeURIComponent(operation.id) },
          query: {
            status: group.statuses.join(","),
            offset: String(offset),
            limit: String(PAGE_SIZE),
          },
        }),
      ),
    placeholderData: (previous) => previous,
  });
  const shown = items.data?.items || [];

  return createPortal(
    <div className="artist-modal-backdrop" onClick={handleBackdropClick}>
      <div
        ref={dialogRef}
        className="artist-modal library-file-op__dialog"
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        tabIndex={-1}
      >
        <div className="artist-modal__header">
          <div>
            <h3 id={titleId} className="artist-modal__title">
              {group.label} · {count(total)}
            </h3>
            {group.about ? <p className="artist-modal__subcopy">{group.about}</p> : null}
          </div>
          <TooltipButton label="Close" className="btn btn-ghost btn-icon btn-sm" onClick={onClose}>
            <X aria-hidden="true" />
          </TooltipButton>
        </div>
        <div className="library-file-op__body">
          {items.isError ? (
            <p className="library-file-op__notice">
              Couldn&apos;t load the file list. Try again in a moment.
            </p>
          ) : items.isPending ? (
            <DotLoader size="sm" label="Loading files" />
          ) : (
            <ul className="library-file-op__items">
              {shown.map((item) => (
                <OperationItem key={item.position} item={item} showReason={!group.about} />
              ))}
            </ul>
          )}
        </div>
        {total > PAGE_SIZE ? (
          <div className="library-file-op__pages">
            <span className="library-file-op__range">
              {count(offset + 1)} to {count(Math.min(total, offset + PAGE_SIZE))} of {count(total)}
            </span>
            <button
              type="button"
              className="btn btn-secondary btn-sm"
              onClick={() => setOffset((current) => Math.max(0, current - PAGE_SIZE))}
              disabled={offset === 0}
            >
              Previous
            </button>
            <button
              type="button"
              className="btn btn-secondary btn-sm"
              onClick={() => setOffset((current) => current + PAGE_SIZE)}
              disabled={offset + PAGE_SIZE >= total}
            >
              Next
            </button>
          </div>
        ) : null}
      </div>
    </div>,
    document.body,
  );
}

function useOperationAction(
  operation: FileOperation,
  run: (id: string) => Promise<unknown>,
  failed: string,
  onChanged?: () => unknown,
  showError?: (message: string) => void,
) {
  const [busy, setBusy] = useState(false);
  const act = async () => {
    setBusy(true);
    try {
      await run(encodeURIComponent(operation.id));
      await onChanged?.();
      return true;
    } catch (error) {
      showError?.(errorText(error, failed));
      return false;
    } finally {
      setBusy(false);
    }
  };
  return [busy, act] as const;
}

function RemoveDuplicates({
  operation,
  onChanged,
  showError,
}: {
  operation: FileOperation;
  onChanged?: () => unknown;
  showError?: (message: string) => void;
}) {
  const copy = REMOVAL[operation.kind];
  const [confirming, setConfirming] = useState(false);
  const [removing, remove] = useOperationAction(
    operation,
    (id) =>
      parseResponse(
        libraryFilesClient.files.operations[":id"]["remove-sources"].$post({ param: { id } }),
      ),
    copy.failed,
    onChanged,
    showError,
  );
  const removable = Number(operation.sources?.removable || 0);
  return (
    <>
      <button type="button" className="btn btn-danger btn-sm" onClick={() => setConfirming(true)}>
        Remove
      </button>
      <ConfirmModal
        open={confirming}
        title={copy.question(removable)}
        body={copy.notes}
        confirmLabel={copy.action}
        busyLabel="Removing…"
        busy={removing}
        onCancel={() => setConfirming(false)}
        onConfirm={async () => {
          if (await remove()) setConfirming(false);
        }}
      />
    </>
  );
}

export default function LibraryFileOperation({
  operation,
  action,
  onChanged,
  showError,
}: {
  operation: FileOperation | null;
  action: ReactNode;
  onChanged?: () => unknown;
  showError?: (message: string) => void;
}) {
  const [reviewing, setReviewing] = useState<string | null>(null);
  useEffect(() => setReviewing(null), [operation?.id]);

  if (!operation) return <SettingsActions>{action}</SettingsActions>;
  const busy = ACTIVE_LIBRARY_FILE_STATUSES.has(operation.status);
  return (
    <>
      {busy ? (
        <RunningRow operation={operation} onChanged={onChanged} showError={showError} />
      ) : (
        <FinishedRow
          operation={operation}
          action={action}
          onChanged={onChanged}
          showError={showError}
        />
      )}
      {busy
        ? null
        : GROUPS[operation.kind].map((group) => {
            const total = countOf(operation.counts, group.statuses);
            if (!total) return null;
            const removable = group.id === "duplicate" && Number(operation.sources?.removable) > 0;
            const removed = group.id === "duplicate" ? Number(operation.sources?.removed || 0) : 0;
            const copy = REMOVAL[operation.kind];
            return (
              <SettingsRow
                key={group.id}
                label={group.label}
                help={removable ? copy.notes : removed ? copy.removed(removed) : undefined}
              >
                <span className="library-file-op__count">{count(total)}</span>
                <button
                  type="button"
                  className="btn btn-secondary btn-sm"
                  onClick={() => setReviewing(group.id)}
                >
                  Review
                </button>
                {removable ? (
                  <RemoveDuplicates
                    operation={operation}
                    onChanged={onChanged}
                    showError={showError}
                  />
                ) : null}
                {reviewing === group.id ? (
                  <ReviewDialog
                    operation={operation}
                    group={group}
                    total={total}
                    onClose={() => setReviewing(null)}
                  />
                ) : null}
              </SettingsRow>
            );
          })}
    </>
  );
}

function RunningRow({
  operation,
  onChanged,
  showError,
}: {
  operation: FileOperation;
  onChanged?: () => unknown;
  showError?: (message: string) => void;
}) {
  const [stopping, stop] = useOperationAction(
    operation,
    (id) =>
      parseResponse(libraryFilesClient.files.operations[":id"].cancel.$post({ param: { id } })),
    "Aurral could not stop it. Try again.",
    onChanged,
    showError,
  );
  const { done = 0, total = 0 } = operation.progress || {};
  const percent = total ? Math.min(100, Math.round((done / total) * 100)) : 0;
  return (
    <SettingsRow
      label={
        <span className="library-file-op__line" role="status" aria-live="polite">
          <DotLoader size="xs" label={null} />
          {describeRunning(operation)}
          {total ? `: ${count(done)} of ${count(total)}` : ""}
        </span>
      }
      help={
        <span className="library-file-op__bar" aria-hidden>
          <span className="library-file-op__fill" style={{ width: `${percent}%` }} />
        </span>
      }
    >
      <button type="button" className="btn btn-secondary btn-sm" disabled={stopping} onClick={stop}>
        {stopping ? <DotLoader size="sm" label={null} /> : null}
        Stop
      </button>
    </SettingsRow>
  );
}

function FinishedRow({
  operation,
  action,
  onChanged,
  showError,
}: {
  operation: FileOperation;
  action: ReactNode;
  onChanged?: () => unknown;
  showError?: (message: string) => void;
}) {
  const [clearing, clear] = useOperationAction(
    operation,
    (id) =>
      parseResponse(libraryFilesClient.files.operations[":id"].dismiss.$post({ param: { id } })),
    "Aurral could not clear this. Try again.",
    onChanged,
    showError,
  );
  const failed = operation.status === "failed";
  const note = afterScanNote(operation);
  return (
    <SettingsRow
      label={describeFinished(operation)}
      help={
        failed
          ? `${operation.error || "Something went wrong"}. Files already done stay done.`
          : [describeResult(operation), note].filter(Boolean).join(" ")
      }
      tone={failed ? "warning" : "default"}
    >
      <TooltipButton
        label="Clear"
        className="btn btn-ghost btn-icon btn-sm"
        disabled={clearing}
        onClick={clear}
      >
        <X aria-hidden="true" />
      </TooltipButton>
      {action}
    </SettingsRow>
  );
}
