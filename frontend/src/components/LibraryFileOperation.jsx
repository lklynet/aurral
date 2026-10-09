import { useEffect, useMemo, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { ArrowRight } from "lucide-react";
import { DotLoader } from "./DotLoader";
import {
  cancelLibraryFileOperation,
  getLibraryFileOperationItems,
  removeLibraryFileOperationSources,
} from "../utils/api/endpoints/library.js";
import { ACTIVE_LIBRARY_FILE_STATUSES, libraryFilesQueryKey } from "../hooks/useLibraryFileOperation.js";
import "./LibraryFileOperation.css";

const PAGE_SIZE = 50;

const GROUPS = [
  { id: "skipped", label: "Skipped", statuses: ["skipped", "conflict"] },
  { id: "failed", label: "Failed", statuses: ["failed"] },
  { id: "duplicate", label: "Already in the Library", statuses: ["duplicate"] },
];

const RUNNING = { move: "Moving files", copy: "Copying files", hardlink: "Linking files" };

const plural = (count, word) => `${count} ${word}${count === 1 ? "" : "s"}`;
const countOf = (counts, statuses) => statuses.reduce((sum, status) => sum + Number(counts?.[status] || 0), 0);

function describeSkipped(present, others) {
  if (present && others) return `Skipped ${plural(present, "file")} already in the Library and ${plural(others, "other")}`;
  if (present) return `Skipped ${plural(present, "file")} already in the Library`;
  return others ? `Skipped ${plural(others, "file")}` : null;
}

function describeResult(operation) {
  const counts = operation.counts || {};
  const skipped = countOf(counts, ["skipped", "conflict"]);
  const parts = operation.kind === "ingest"
    ? [
        counts.done && `Filed ${plural(counts.done, "file")}`,
        describeSkipped(Number(counts.duplicate || 0), skipped),
      ]
    : [
        counts.done && `Updated ${plural(counts.done, "file")}`,
        operation.summary?.unchanged && `${operation.summary.unchanged} already in order`,
        skipped && `${skipped} skipped`,
      ];
  parts.push(counts.failed && `${counts.failed} failed`);
  return parts.filter(Boolean).join(" · ");
}

function describeRunning(operation) {
  if (operation.kind !== "ingest") return "Cleaning up";
  if (operation.summary?.removingSources) return "Removing source files";
  return RUNNING[operation.options?.mode] || "Filing files";
}

function describeStatus(operation) {
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

function OperationItem({ item }) {
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
      {item.reason ? <p className="library-file-op__notes">{item.reason}</p> : null}
    </li>
  );
}

function StopButton({ operation, onChanged, showError }) {
  const [stopping, setStopping] = useState(false);
  const stop = async () => {
    setStopping(true);
    try {
      await cancelLibraryFileOperation(operation.id);
      await onChanged?.();
    } catch (error) {
      showError?.(error?.response?.data?.message || error?.message || "Aurral could not stop it. Try again.");
    } finally {
      setStopping(false);
    }
  };
  return (
    <button type="button" className="arr-btn" disabled={stopping} onClick={stop}>
      {stopping ? <DotLoader size="sm" label={null} /> : null}
      Stop
    </button>
  );
}

function RemoveSourcesOffer({ operation, onChanged, showError }) {
  const [removing, setRemoving] = useState(false);
  const count = Number(operation.sources?.removable || 0);
  if (!count) return null;
  const remove = async () => {
    setRemoving(true);
    try {
      await removeLibraryFileOperationSources(operation.id);
      await onChanged?.();
    } catch (error) {
      showError?.(error?.response?.data?.message || error?.message || "Aurral could not remove the source files. Nothing was removed.");
    } finally {
      setRemoving(false);
    }
  };
  return (
    <div className="library-file-op__offer">
      <div>
        <p className="library-file-op__question">
          Remove {plural(count, "source file")} already in the Library?
        </p>
        <p className="library-file-op__notes">
          Aurral checks each one against the Library&apos;s copy again, then deletes it from the source folder.
        </p>
      </div>
      <button type="button" className="btn btn-danger" disabled={removing} onClick={remove}>
        {removing ? <DotLoader size="sm" label={null} /> : null}
        Remove source files
      </button>
    </div>
  );
}

export default function LibraryFileOperation({ operation, onChanged, showError }) {
  const counts = operation?.counts;
  const groups = useMemo(
    () => GROUPS.map((group) => ({ ...group, count: countOf(counts, group.statuses) })).filter((group) => group.count > 0),
    [counts],
  );
  const [groupId, setGroupId] = useState(null);
  const [offset, setOffset] = useState(0);
  const group = groups.find((entry) => entry.id === groupId) || groups[0] || null;

  useEffect(() => {
    setOffset(0);
  }, [group?.id, operation?.id]);

  const items = useQuery({
    queryKey: [...libraryFilesQueryKey, "items", operation?.id, group?.id, offset, operation?.updatedAt],
    queryFn: () => getLibraryFileOperationItems(operation.id, { status: group.statuses, offset, limit: PAGE_SIZE }),
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
          {busy ? <StopButton operation={operation} onChanged={onChanged} showError={showError} /> : null}
        </div>
        {busy ? (
          <div className="library-file-op__bar" aria-hidden>
            <div className="library-file-op__fill" style={{ width: `${percent}%` }} />
          </div>
        ) : null}
      </div>
      {!busy ? <RemoveSourcesOffer operation={operation} onChanged={onChanged} showError={showError} /> : null}
      {operation.sources?.removed ? (
        <p className="library-file-op__notes">
          Removed {plural(operation.sources.removed, "source file")} already in the Library.
        </p>
      ) : null}
      {operation.summary?.monitor === "pending" ? (
        <p className="library-file-op__notes">Aurral monitors this music once the Library scan has found it.</p>
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
            <p className="library-file-op__notice">Could not load the file list. Try again in a moment.</p>
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
