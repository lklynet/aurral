import { useEffect, useMemo, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { parseResponse } from "hono/client";
import { ArrowRight } from "./icons";
import { DotLoader } from "./DotLoader";
import { getApiErrorText } from "../pages/onboardingUtils.tsx";
import { asApiError } from "../utils/api/core.ts";
import { libraryFilesClient } from "../utils/api/clients/libraryFiles.ts";
import {
  ACTIVE_LIBRARY_FILE_STATUSES,
  libraryFilesQueryKey,
} from "../hooks/useLibraryFileOperation.ts";
import "./LibraryFileOperation.css";

const PAGE_SIZE = 50;

const GROUPS = [
  { id: "skipped", label: "Skipped", statuses: ["skipped", "conflict"] },
  { id: "failed", label: "Failed", statuses: ["failed"] },
  {
    id: "duplicate",
    label: "Already in the Library",
    cleanupLabel: "Duplicates",
    statuses: ["duplicate"],
  },
];

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

const plural = (count: number, word: string) => `${count} ${word}${count === 1 ? "" : "s"}`;
const duplicateCopies = (count: number) => `${count} duplicate ${count === 1 ? "copy" : "copies"}`;

const REMOVAL = {
  ingest: {
    question: (count: number) => `Remove ${plural(count, "source file")} already in the Library?`,
    notes: "Deletes source files after checking them against the Library copy.",
    action: "Remove source files",
    failed: "Aurral could not remove the source files. Nothing was removed.",
    removed: (count: number) => `Removed ${plural(count, "source file")} already in the Library.`,
  },
  cleanup: {
    question: (count: number) => `Remove ${duplicateCopies(count)}?`,
    notes:
      "Rechecks each pair and deletes the lower-quality copy. Playlists and favorites keep the better copy.",
    action: "Remove duplicates",
    failed: "Aurral could not remove the duplicates. Nothing was removed.",
    removed: (count: number) => `Removed ${duplicateCopies(count)}.`,
  },
};
const countOf = (counts: Record<string, number> | undefined, statuses: string[]) =>
  statuses.reduce((sum, status) => sum + Number(counts?.[status] || 0), 0);

function describeSkipped(present: number, others: number) {
  if (present && others)
    return `Skipped ${plural(present, "file")} already in the Library and ${plural(others, "other")}`;
  if (present) return `Skipped ${plural(present, "file")} already in the Library`;
  return others ? `Skipped ${plural(others, "file")}` : null;
}

function describeResult(operation: FileOperation) {
  const counts = operation.counts || {};
  const skipped = countOf(counts, ["skipped", "conflict"]);
  const parts =
    operation.kind === "ingest"
      ? [
          counts.done && `Filed ${plural(counts.done, "file")}`,
          describeSkipped(Number(counts.duplicate || 0), skipped),
        ]
      : [
          counts.done && `Updated ${plural(counts.done, "file")}`,
          operation.summary?.unchanged && `${operation.summary.unchanged} already in order`,
          counts.duplicate && duplicateCopies(counts.duplicate),
          skipped && `${skipped} skipped`,
        ];
  parts.push(counts.failed && `${counts.failed} failed`);
  return parts.filter(Boolean).join(" · ");
}

function describeRunning(operation: FileOperation) {
  if (operation.summary?.removingSources)
    return operation.kind === "ingest" ? "Removing source files" : "Removing duplicates";
  if (operation.kind !== "ingest") return "Cleaning up";
  return (operation.options && RUNNING[operation.options.mode]) || "Filing files";
}

function describeStatus(operation: FileOperation) {
  const { done = 0, total = 0 } = operation.progress || {};
  const progress = total ? `: ${done} of ${total}` : "";
  const result = describeResult(operation);
  switch (operation.status) {
    case "planning":
      return `Checking files${progress}`;
    case "running":
      return `${describeRunning(operation)}${progress}`;
    case "complete":
      return result ? `Finished. ${result}.` : "Finished. Nothing needed to change.";
    case "cancelled":
      return result ? `Stopped. ${result}.` : "Stopped.";
    case "failed":
      return `Stopped: ${operation.error || "something went wrong"}. Files already done stay done.`;
    default:
      return "";
  }
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

function OperationItem({ item }: { item: LibraryFileOperationItem }) {
  return (
    <li className={`library-file-op__item is-${item.status}`}>
      <div className="library-file-op__paths">
        <code>{item.source}</code>
        {item.target && item.target !== item.source ? (
          <>
            <ArrowRight className="artist-icon-xs" aria-label="to" />
            <code>{item.target}</code>
          </>
        ) : null}
      </div>
      {item.reason ? <Reason text={item.reason} /> : null}
    </li>
  );
}

function StopButton({
  operation,
  onChanged,
  showError,
}: {
  operation: FileOperation;
  onChanged?: () => unknown;
  showError?: (message: string) => void;
}) {
  const [stopping, setStopping] = useState(false);
  const stop = async () => {
    setStopping(true);
    try {
      await parseResponse(
        libraryFilesClient.files.operations[":id"].cancel.$post({
          param: { id: encodeURIComponent(operation.id) },
        }),
      );
      await onChanged?.();
    } catch (error) {
      showError?.(
        getApiErrorText(error, "message") ||
          asApiError(error)?.message ||
          "Aurral could not stop it. Try again.",
      );
    } finally {
      setStopping(false);
    }
  };
  return (
    <button
      type="button"
      className="btn btn-secondary btn-sm library-file-op__stop"
      disabled={stopping}
      onClick={stop}
    >
      {stopping ? <DotLoader size="sm" label={null} /> : null}
      Stop
    </button>
  );
}

function RemoveSourcesOffer({
  operation,
  onChanged,
  showError,
}: {
  operation: FileOperation;
  onChanged?: () => unknown;
  showError?: (message: string) => void;
}) {
  const [removing, setRemoving] = useState(false);
  const count = Number(operation.sources?.removable || 0);
  const copy = REMOVAL[operation.kind];
  if (!count || !copy) return null;
  const remove = async () => {
    setRemoving(true);
    try {
      await parseResponse(
        libraryFilesClient.files.operations[":id"]["remove-sources"].$post({
          param: { id: encodeURIComponent(operation.id) },
        }),
      );
      await onChanged?.();
    } catch (error) {
      showError?.(getApiErrorText(error, "message") || asApiError(error)?.message || copy.failed);
    } finally {
      setRemoving(false);
    }
  };
  return (
    <div className="library-file-op__offer">
      <div>
        <p className="library-file-op__question">{copy.question(count)}</p>
        <p className="library-file-op__notes">{copy.notes}</p>
      </div>
      <button type="button" className="btn btn-danger" disabled={removing} onClick={remove}>
        {removing ? <DotLoader size="sm" label={null} /> : null}
        {copy.action}
      </button>
    </div>
  );
}

export default function LibraryFileOperation({
  operation,
  onChanged,
  showError,
}: {
  operation: FileOperation | null;
  onChanged?: () => unknown;
  showError?: (message: string) => void;
}) {
  const counts = operation?.counts;
  const cleanup = operation?.kind === "cleanup";
  const groups = useMemo(
    () =>
      GROUPS.map((group) => ({
        ...group,
        label: (cleanup && group.cleanupLabel) || group.label,
        count: countOf(counts, group.statuses),
      })).filter((group) => group.count > 0),
    [counts, cleanup],
  );
  const [groupId, setGroupId] = useState<string | null>(null);
  const [offset, setOffset] = useState(0);
  const group = groups.find((entry) => entry.id === groupId) || groups[0] || null;

  useEffect(() => {
    setOffset(0);
  }, [group?.id, operation?.id]);

  const items = useQuery({
    queryKey: [
      ...libraryFilesQueryKey,
      "items",
      operation?.id,
      group?.id,
      offset,
      operation?.updatedAt,
    ],
    queryFn: () =>
      parseResponse(
        libraryFilesClient.files.operations[":id"].items.$get({
          param: { id: encodeURIComponent(operation!.id) },
          query: {
            status: group!.statuses.join(",") || undefined,
            offset: String(offset),
            limit: String(PAGE_SIZE),
          },
        }),
      ),
    enabled: Boolean(operation && group),
    placeholderData: (previous) => previous,
  });

  if (!operation) return null;
  const busy = ACTIVE_LIBRARY_FILE_STATUSES.has(operation.status);
  const { done = 0, total = 0 } = operation.progress || {};
  const percent = total ? Math.min(100, Math.round((done / total) * 100)) : 0;
  const shown = items.data?.items || [];

  return (
    <div className="library-file-op">
      <div className="library-file-op__progress" role="status" aria-live="polite">
        <div className="library-file-op__line">
          {busy ? <DotLoader size="xs" label={null} /> : null}
          <span>{describeStatus(operation)}</span>
          {busy ? (
            <StopButton operation={operation} onChanged={onChanged} showError={showError} />
          ) : null}
        </div>
        {busy ? (
          <div className="library-file-op__bar" aria-hidden>
            <div className="library-file-op__fill" style={{ width: `${percent}%` }} />
          </div>
        ) : null}
      </div>
      {!busy ? (
        <RemoveSourcesOffer operation={operation} onChanged={onChanged} showError={showError} />
      ) : null}
      {operation.sources?.removed && REMOVAL[operation.kind] ? (
        <p className="library-file-op__notes">
          {REMOVAL[operation.kind].removed(operation.sources.removed)}
        </p>
      ) : null}
      {operation.summary?.monitor === "pending" || operation.summary?.doubles === "pending" ? (
        <p className="library-file-op__notes">
          {operation.summary?.monitor === "pending"
            ? "After scanning, Aurral checks for duplicates and monitors new tracks."
            : "After scanning, Aurral checks for duplicates."}
        </p>
      ) : null}
      {groups.length ? (
        <div className="library-file-op__groups" role="group" aria-label="Files Aurral left alone">
          {groups.map((entry) => (
            <button
              key={entry.id}
              type="button"
              className="library-file-op__group"
              aria-pressed={entry.id === group?.id}
              onClick={() => setGroupId(entry.id)}
            >
              {entry.label} <span className="library-file-op__count">{entry.count}</span>
            </button>
          ))}
        </div>
      ) : null}
      {group ? (
        <>
          {items.isError ? (
            <p className="library-file-op__notice">
              Could not load the file list. Try again in a moment.
            </p>
          ) : null}
          <ul className="library-file-op__items">
            {shown.map((item) => (
              <OperationItem key={item.position} item={item} />
            ))}
          </ul>
          {group.count > PAGE_SIZE ? (
            <div className="library-file-op__pages">
              <button
                type="button"
                className="library-file-op__page"
                onClick={() => setOffset((current) => Math.max(0, current - PAGE_SIZE))}
                disabled={offset === 0}
              >
                Previous
              </button>
              <span className="library-file-op__range">
                {offset + 1}–{Math.min(group.count, offset + PAGE_SIZE)} of {group.count}
              </span>
              <button
                type="button"
                className="library-file-op__page"
                onClick={() => setOffset((current) => current + PAGE_SIZE)}
                disabled={offset + PAGE_SIZE >= group.count}
              >
                Next
              </button>
            </div>
          ) : null}
        </>
      ) : null}
    </div>
  );
}
