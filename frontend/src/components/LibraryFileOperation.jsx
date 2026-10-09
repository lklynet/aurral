import { useEffect, useMemo, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { ArrowRight } from "lucide-react";
import { DotLoader } from "./DotLoader";
import {
  cancelLibraryFileOperation,
  getLibraryFileOperationItems,
  startLibraryFileOperation,
} from "../utils/api/endpoints/library.js";
import {
  ACTIVE_LIBRARY_FILE_STATUSES,
  libraryFilesQueryKey,
} from "../hooks/useLibraryFileOperation.js";
import "./LibraryFileOperation.css";

const PAGE_SIZE = 50;

const GROUPS = [
  { id: "changes", label: "Changes", statuses: ["pending", "done"] },
  { id: "conflict", label: "Needs review", statuses: ["conflict"] },
  { id: "duplicate", label: "Already in the Library", statuses: ["duplicate"] },
  { id: "skipped", label: "Skipped", statuses: ["skipped"] },
  { id: "failed", label: "Failed", statuses: ["failed"] },
];

const ACTION_LABELS = {
  move: "Move",
  copy: "Copy",
  hardlink: "Hardlink",
  "remove-duplicate": "Remove source copy",
  rename: "Rename",
};

const plural = (count, word) => `${count} ${word}${count === 1 ? "" : "s"}`;
const countOf = (counts, statuses) => statuses.reduce((sum, status) => sum + Number(counts?.[status] || 0), 0);

export function describeOperationStatus(operation) {
  if (!operation) return "";
  const { done = 0, total = 0, unit = "files" } = operation.progress || {};
  switch (operation.status) {
    case "planning":
      return total ? `Checking ${unit}: ${done} of ${total}` : "Checking files";
    case "ready":
      return "Preview ready. Nothing changes until you apply it.";
    case "running":
      return `Applying changes: ${done} of ${total}`;
    case "complete":
      return operation.counts?.done || operation.counts?.duplicate ? "Finished." : "Finished. Nothing needed to change.";
    case "cancelled":
      return "Cancelled. Changes already made stay.";
    case "failed":
      return `Stopped: ${operation.error || "the operation failed"}. Changes already made stay.`;
    default:
      return "";
  }
}

function itemActionLabel(item, operation) {
  const actions = item.actions.map((action) =>
    action === "file" ? ACTION_LABELS[operation.options?.mode] : ACTION_LABELS[action]);
  return actions.filter(Boolean).join(", ");
}

function itemStatusLabel(item, operation) {
  if (item.status === "pending") {
    return ["ready", "planning"].includes(operation.status) ? "Planned" : "Not applied";
  }
  return {
    new: "Waiting",
    done: "Done",
    duplicate: "Already in the Library",
    conflict: "Needs review",
    skipped: "Skipped",
    failed: "Failed",
  }[item.status] || item.status;
}

function OperationItem({ item, operation }) {
  const action = itemActionLabel(item, operation);
  return (
    <li className={`library-file-op__item is-${item.status}`}>
      <div className="library-file-op__item-head">
        <span className="library-file-op__status">{itemStatusLabel(item, operation)}</span>
        {action ? <span className="library-file-op__action">{action}</span> : null}
      </div>
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

export function LibraryFileOperationActions({ operation, onChanged, showError }) {
  const [pending, setPending] = useState("");
  if (!operation || !ACTIVE_LIBRARY_FILE_STATUSES.has(operation.status)) return null;
  const run = async (kind, request) => {
    setPending(kind);
    try {
      await request(operation.id);
      await onChanged?.();
    } catch (error) {
      showError?.(
        error?.response?.data?.message || error?.message || "The operation could not be changed. Nothing new was applied.",
      );
    } finally {
      setPending("");
    }
  };
  const changes = Number(operation.counts?.pending || 0);
  return (
    <>
      <button type="button" className="arr-btn" disabled={Boolean(pending)} onClick={() => run("cancel", cancelLibraryFileOperation)}>
        {pending === "cancel" ? <DotLoader size="sm" label={null} /> : null}
        {operation.status === "running" ? "Stop" : "Cancel"}
      </button>
      {operation.status === "ready" ? (
        <button
          type="button"
          className="arr-btn arr-btn--primary"
          disabled={Boolean(pending) || changes === 0}
          onClick={() => run("start", startLibraryFileOperation)}
        >
          {pending === "start" ? <DotLoader size="sm" label={null} /> : null}
          {changes ? `Apply ${changes} change${changes === 1 ? "" : "s"}` : "Nothing to apply"}
        </button>
      ) : null}
    </>
  );
}

export default function LibraryFileOperation({ operation }) {
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

  const groupCount = group?.count || 0;
  useEffect(() => {
    setOffset((current) => (current >= groupCount ? Math.max(0, Math.floor((groupCount - 1) / PAGE_SIZE) * PAGE_SIZE) : current));
  }, [groupCount]);

  const items = useQuery({
    queryKey: [...libraryFilesQueryKey, "items", operation?.id, group?.id, offset, operation?.updatedAt],
    queryFn: () => getLibraryFileOperationItems(operation.id, { status: group.statuses, offset, limit: PAGE_SIZE }),
    enabled: Boolean(operation && group),
    placeholderData: (previous) => previous,
  });

  if (!operation) return null;
  const busy = ["planning", "running"].includes(operation.status);
  const { done = 0, total = 0 } = operation.progress || {};
  const percent = total ? Math.min(100, Math.round((done / total) * 100)) : 0;
  const unchanged = Number(operation.summary?.unchanged || 0);
  const shown = items.data?.items || [];

  return (
    <div className="library-file-op">
      <div className="library-file-op__progress" role="status" aria-live="polite">
        <p className="library-file-op__line">
          {busy ? <DotLoader size="xs" label={null} /> : null}
          <span>{describeOperationStatus(operation)}</span>
          {busy && total ? <span className="library-file-op__pct">{percent}%</span> : null}
        </p>
        {busy ? (
          <div className="library-file-op__bar" aria-hidden>
            <div className="library-file-op__fill" style={{ width: `${percent}%` }} />
          </div>
        ) : null}
      </div>
      {operation.summary?.monitor === "pending" ? (
        <p className="library-file-op__notice">Aurral monitors this music once the Library scan has found it.</p>
      ) : null}
      {groups.length || unchanged ? (
        <div className="library-file-op__groups" role="group" aria-label="Show files">
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
          {unchanged ? <span className="library-file-op__unchanged">{plural(unchanged, "file")} already in order</span> : null}
        </div>
      ) : !busy ? (
        <p className="library-file-op__empty">No files to change.</p>
      ) : null}
      {group ? (
        <>
          {items.isError ? (
            <p className="library-file-op__notice">Could not load the file list. Try again in a moment.</p>
          ) : null}
          <ul className="library-file-op__items">
            {shown.map((item) => (
              <OperationItem key={item.position} item={item} operation={operation} />
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
