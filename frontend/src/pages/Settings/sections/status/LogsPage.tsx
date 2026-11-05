import { useEffect, useState } from "react";
import { useInfiniteQuery, useMutation, useQuery } from "@tanstack/react-query";
import { parseResponse, type InferResponseType } from "hono/client";
import type { LogLevel } from "../../../../../../backend/services/logger.ts";
import { DotLoader } from "../../../../components/DotLoader";
import { AlertCircle, RefreshCw, TriangleAlert } from "../../../../components/icons";
import PillToggle from "../../../../components/PillToggle";
import RelativeTime from "../../../../components/RelativeTime";
import { Select, type SelectOption } from "../../../../components/Select";
import TooltipButton from "../../../../components/TooltipButton";
import { queryClient, queryKeys } from "../../../../queryClient.ts";
import { authClient } from "../../../../utils/api/clients/auth.ts";
import { logsClient } from "../../../../utils/api/clients/logs.ts";
import { API_BASE_URL } from "../../../../utils/api/core.ts";
import { getApiErrorMessage } from "../../../../utils/api/errors.ts";
import { formatDate, formatTime } from "../../../../utils/dateTime.ts";
import { useServerSettings } from "../../SettingsProviders";
import {
  SettingsGroup,
  SettingsNote,
  SettingsPage,
  SettingsRow,
  type ServiceStatus,
} from "../../SettingsLayout";
import { StatusLine } from "./StatusLine";

type Tab = "problems" | "all";
type Entry = InferResponseType<typeof logsClient.$get, 200>["entries"][number];
type Problems = InferResponseType<typeof logsClient.problems.$get, 200>;
type Problem = Problems["problems"][number];

const PAGE_SIZE = 200;
const TABS: { id: Tab; label: string }[] = [
  { id: "problems", label: "Problems" },
  { id: "all", label: "All" },
];
const LEVELS: SelectOption<LogLevel>[] = [
  { value: "error", label: "Errors" },
  { value: "warn", label: "Warnings and errors" },
  { value: "info", label: "Info and above" },
  { value: "debug", label: "Everything" },
];

function entryReason(entry: Entry) {
  if (entry.err) return entry.err.message;
  const { data } = entry;
  if (data && typeof data === "object" && "reason" in data && typeof data.reason === "string")
    return data.reason;
  return null;
}

function lineTime(ts: string) {
  const date = new Date(ts);
  const time = date.toTimeString().slice(0, 8);
  return date.toDateString() === new Date().toDateString()
    ? time
    : `${formatDate(date, { month: "short", day: "numeric" })} ${time}`;
}

function freshTime(ts: string) {
  const date = new Date(ts);
  const time = formatTime(date, { hour: "numeric", minute: "2-digit" });
  return date.toDateString() === new Date().toDateString()
    ? time
    : `${formatDate(date, { month: "short", day: "numeric" })} ${time}`;
}

function entryDetails(entry: Entry) {
  const where = [
    `process ${entry.proc}`,
    entry.req ? `request ${entry.req}` : null,
    entry.job ? `job ${entry.job}` : null,
  ].filter(Boolean);
  return [
    `${entry.ts}  ${where.join("  ")}`,
    entry.data === undefined ? null : JSON.stringify(entry.data, null, 2),
    entry.err ? `${entry.err.name}: ${entry.err.message}` : null,
    entry.err?.stack ?? null,
  ]
    .filter(Boolean)
    .join("\n");
}

async function exportText(level: LogLevel) {
  const response = await logsClient.export.$get({ query: { level } });
  return response.text();
}

function triagePrompt(apiKey: string) {
  const link = (path: string, query: Record<string, string>) =>
    `${new URL(`${API_BASE_URL}/logs/${path}`, window.location.origin)}?${new URLSearchParams({ ...query, api_key: apiKey })}`;
  return [
    "Diagnose problems in my Aurral server by following https://raw.githubusercontent.com/lklynet/aurral/main/.github/triage/PLAYBOOK.md",
    "These links are live and carry my admin API key. Fetch them again after changes, and never post them anywhere.",
    `Problems from the last day, grouped: ${link("problems", {})}`,
    `Full log with version and integrations: ${link("export", { level: "warn" })}`,
    `Start fresh, by POST, only after I say yes: ${link("fresh", {})}`,
    "What went wrong: ",
  ].join("\n");
}

export function useLogProblems() {
  return useQuery({
    queryKey: queryKeys.logProblems,
    queryFn: ({ signal }) =>
      parseResponse(logsClient.problems.$get({ query: {} }, { init: { signal } })),
    staleTime: 0,
  });
}

export function logsServiceStatus(data: Problems | undefined): ServiceStatus | null {
  if (!data) return null;
  const { problems, freshSince } = data;
  if (!problems.length) return { label: "No problems" };
  const label = `${problems.length} problem${problems.length === 1 ? "" : "s"} ${freshSince ? `since ${freshTime(freshSince)}` : "in the last day"}`;
  return problems.some((problem) => problem.level === "error")
    ? { label, tone: "error" }
    : { label };
}

function ProblemRow({ problem, onOpen }: { problem: Problem; onOpen: () => void }) {
  const Icon = problem.level === "error" ? AlertCircle : TriangleAlert;
  const tone = problem.level === "error" ? "danger" : "warning";
  const reason = entryReason(problem.latest);
  return (
    <button type="button" className="logs-row" onClick={onOpen}>
      <StatusLine
        name={
          <span className="status-badge">
            <Icon className={`status-tone--${tone}`} aria-hidden="true" />
            {problem.msg}
          </span>
        }
        sub={[problem.cat, reason !== problem.msg ? reason : null].filter(Boolean).join(" · ")}
        meta={problem.count === 1 ? "Once" : `${problem.count} times`}
        metaSub={<RelativeTime value={problem.lastAt} />}
      />
    </button>
  );
}

function ProblemsView({ onOpen }: { onOpen: (fp: string) => void }) {
  const { showError } = useServerSettings();
  const problems = useLogProblems();
  const fresh = useMutation({
    mutationFn: (start: boolean) =>
      parseResponse(start ? logsClient.fresh.$post() : logsClient.fresh.$delete()),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: queryKeys.logsRoot }),
    onError: (error) => showError(getApiErrorMessage(error, "Couldn't change the log view.")),
  });
  if (problems.isPending) {
    return (
      <p className="settings-loading">
        <DotLoader size="sm" label={null} /> Loading problems…
      </p>
    );
  }
  if (problems.isError) {
    return (
      <SettingsGroup>
        <SettingsNote tone="error">
          {getApiErrorMessage(problems.error, "Couldn't read the log.")}
        </SettingsNote>
      </SettingsGroup>
    );
  }
  const { problems: list, freshSince } = problems.data;
  return (
    <SettingsGroup>
      {list.length ? (
        list.map((problem) => (
          <ProblemRow key={problem.fp} problem={problem} onOpen={() => onOpen(problem.fp)} />
        ))
      ) : (
        <p className="settings-group__note">
          {freshSince
            ? `No new problems since ${freshTime(freshSince)}.`
            : "No warnings or errors in the last 24 hours."}
        </p>
      )}
      {list.length || freshSince ? (
        <SettingsRow
          help={
            freshSince
              ? `Started fresh at ${freshTime(freshSince)}.`
              : "Fixed these? Hide them so only new problems show."
          }
        >
          {freshSince ? (
            <button
              type="button"
              className="btn btn-secondary btn-sm"
              onClick={() => fresh.mutate(false)}
              disabled={fresh.isPending}
            >
              Show earlier
            </button>
          ) : null}
          {list.length ? (
            <button
              type="button"
              className="btn btn-secondary btn-sm"
              onClick={() => fresh.mutate(true)}
              disabled={fresh.isPending}
            >
              Start fresh
            </button>
          ) : null}
        </SettingsRow>
      ) : null}
    </SettingsGroup>
  );
}

function LogLine({ entry }: { entry: Entry }) {
  const [open, setOpen] = useState(false);
  return (
    <li className="log-line">
      <button
        type="button"
        className="log-line__head"
        aria-expanded={open}
        onClick={() => setOpen((value) => !value)}
      >
        <span className="log-line__time">{lineTime(entry.ts)}</span>
        <span className={`log-line__level log-line__level--${entry.level}`}>{entry.level}</span>
        <span className="log-line__cat">{entry.cat}</span>
        <span className="log-line__msg">{entry.msg}</span>
      </button>
      {open ? <pre className="log-line__details">{entryDetails(entry)}</pre> : null}
    </li>
  );
}

function StreamView({ fp, onClearFp }: { fp: string | null; onClearFp: () => void }) {
  const [level, setLevel] = useState<LogLevel>("info");
  const [search, setSearch] = useState("");
  const [q, setQ] = useState("");

  useEffect(() => {
    const timer = window.setTimeout(() => setQ(search.trim()), 300);
    return () => window.clearTimeout(timer);
  }, [search]);

  const filters = { level: fp ? "debug" : level, ...(q ? { q } : {}), ...(fp ? { fp } : {}) };
  const logs = useInfiniteQuery({
    queryKey: queryKeys.logs(filters),
    initialPageParam: "",
    queryFn: ({ pageParam, signal }) =>
      parseResponse(
        logsClient.$get(
          {
            query: {
              ...filters,
              limit: String(PAGE_SIZE),
              ...(pageParam ? { before: pageParam } : {}),
            },
          },
          { init: { signal } },
        ),
      ),
    getNextPageParam: (page) =>
      page.entries.length === PAGE_SIZE ? String(page.entries.at(-1)?.id) : undefined,
    staleTime: 0,
  });
  const entries = logs.data?.pages.flatMap((page) => page.entries) ?? [];

  return (
    <>
      <div className="logs-filters">
        {fp ? (
          <button type="button" className="btn btn-secondary btn-sm" onClick={onClearFp}>
            Show all lines
          </button>
        ) : (
          <Select
            value={level}
            options={LEVELS}
            onChange={setLevel}
            className="input logs-filters__level"
            aria-label="Level"
          />
        )}
        <input
          type="search"
          className="input logs-filters__search"
          placeholder="Search"
          aria-label="Search the log"
          value={search}
          onChange={(event) => setSearch(event.target.value)}
        />
      </div>
      {logs.isError ? (
        <SettingsGroup>
          <SettingsNote tone="error">
            {getApiErrorMessage(logs.error, "Couldn't read the log.")}
          </SettingsNote>
        </SettingsGroup>
      ) : logs.isPending ? (
        <p className="settings-loading">
          <DotLoader size="sm" label={null} /> Loading the log…
        </p>
      ) : (
        <SettingsGroup>
          {entries.length ? (
            <ol className="log-lines">
              {entries.map((entry) => (
                <LogLine key={entry.id} entry={entry} />
              ))}
            </ol>
          ) : (
            <p className="settings-group__note">No matching lines.</p>
          )}
        </SettingsGroup>
      )}
      {logs.hasNextPage ? (
        <button
          type="button"
          className="btn btn-secondary btn-sm logs-more"
          onClick={() => void logs.fetchNextPage()}
          disabled={logs.isFetchingNextPage}
        >
          {logs.isFetchingNextPage ? <DotLoader size="xs" label={null} /> : null}
          Load older
        </button>
      ) : null}
    </>
  );
}

export function LogsPage() {
  const { showSuccess, showError } = useServerSettings();
  const [tab, setTab] = useState<Tab>("problems");
  const [fp, setFp] = useState<string | null>(null);
  const problems = useLogProblems();
  const debug = problems.data?.debug ?? false;

  const refresh = () => void queryClient.invalidateQueries({ queryKey: queryKeys.logsRoot });
  const toggleDebug = useMutation({
    mutationFn: (enabled: boolean) => parseResponse(logsClient.debug.$put({ json: { enabled } })),
    onSuccess: refresh,
    onError: (error) => showError(getApiErrorMessage(error, "Couldn't change debug logging.")),
  });
  const copy = useMutation({
    mutationFn: async () => navigator.clipboard.writeText(await exportText("warn")),
    onSuccess: () => showSuccess("Copied the last day of warnings and errors."),
    onError: (error) => showError(getApiErrorMessage(error, "Couldn't copy the log.")),
  });
  const apiKey = useQuery({
    queryKey: queryKeys.apiKey,
    queryFn: ({ signal }) => parseResponse(authClient["api-key"].$get({}, { init: { signal } })),
  });
  const copyTriage = async (key: string) => {
    try {
      await navigator.clipboard.writeText(triagePrompt(key));
      showSuccess("Copied a prompt with your admin API key.");
    } catch {
      showError("Couldn't copy the prompt.");
    }
  };
  const download = useMutation({
    mutationFn: async () => {
      const url = URL.createObjectURL(new Blob([await exportText("info")]));
      Object.assign(document.createElement("a"), {
        href: url,
        download: `aurral-logs-${new Date().toLocaleDateString("en-CA")}.txt`,
      }).click();
      URL.revokeObjectURL(url);
    },
    onError: (error) => showError(getApiErrorMessage(error, "Couldn't download the log.")),
  });

  return (
    <SettingsPage title="Logs" back="Status">
      <div className="logs-view">
        <div className="logs-toolbar">
          <div className="artist-segmented" role="tablist" aria-label="Log views">
            {TABS.map((entry) => (
              <button
                key={entry.id}
                type="button"
                role="tab"
                aria-selected={tab === entry.id}
                className={`artist-segmented-button${tab === entry.id ? " is-active" : ""}`}
                onClick={() => {
                  setTab(entry.id);
                  setFp(null);
                }}
              >
                {entry.label}
              </button>
            ))}
          </div>
          <div className="logs-toolbar__actions">
            <TooltipButton label="Refresh" className="btn btn-ghost btn-icon" onClick={refresh}>
              <RefreshCw aria-hidden="true" />
            </TooltipButton>
            <button
              type="button"
              className="btn btn-secondary btn-sm"
              onClick={() => copy.mutate()}
              disabled={copy.isPending}
            >
              {copy.isPending ? <DotLoader size="xs" label={null} /> : null}
              Copy problems
            </button>
            <button
              type="button"
              className="btn btn-primary btn-sm"
              onClick={() => download.mutate()}
              disabled={download.isPending}
            >
              {download.isPending ? <DotLoader size="xs" label={null} /> : null}
              Download
            </button>
          </div>
        </div>
        {tab === "problems" ? (
          <ProblemsView
            onOpen={(next) => {
              setFp(next);
              setTab("all");
            }}
          />
        ) : (
          <StreamView fp={fp} onClearFp={() => setFp(null)} />
        )}
      </div>
      <SettingsGroup>
        <SettingsRow
          label="Debug logging"
          help="Saves detailed lines while you reproduce a problem. Turn it off when you're done."
        >
          <PillToggle
            checked={debug}
            disabled={!problems.data || toggleDebug.isPending}
            onChange={({ target }) => toggleDebug.mutate(target.checked)}
            aria-label="Debug logging"
          />
        </SettingsRow>
        <SettingsRow
          label="Agent triage"
          help="Copies a prompt with live links to these logs. It carries your admin API key."
        >
          <button
            type="button"
            className="btn btn-secondary btn-sm"
            onClick={() => apiKey.data && void copyTriage(apiKey.data.apiKey)}
            disabled={!apiKey.data}
          >
            Copy prompt
          </button>
        </SettingsRow>
      </SettingsGroup>
    </SettingsPage>
  );
}
