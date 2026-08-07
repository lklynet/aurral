import { useEffect, useState } from "react";
import { ChevronDown } from "lucide-react";

const STATUS_LABELS = {
  pass: "PASS",
  fail: "FAIL",
  warn: "WARN",
  skip: "SKIP",
};

function formatCheckedAt(value) {
  if (!value) return null;
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return null;
  return date.toLocaleString();
}

function defaultExpandedBySection(sections) {
  const next = {};
  for (const section of sections) {
    next[section.id] = section.status === "fail";
  }
  return next;
}

function getSummary(result) {
  const activeSections = result.sections.filter((section) => section.status !== "skip");
  const status = result.ok ? (result.partial ? "warn" : "pass") : "fail";
  const label = result.ok ? (result.partial ? "Review recommended" : "Healthy") : "Needs attention";
  return { activeSections, status, label, checkedAt: formatCheckedAt(result.checkedAt) };
}

export function StorageHealthSummary({ result, loading = false }) {
  if (!result?.sections?.length) {
    return (
      <div className="arr-health__summary is-warn">
        <div className="arr-health__summary-main">
          <span className="arr-health__badge arr-health__badge--warn">
            {loading ? "Checking" : "Pending"}
          </span>
          <span className="arr-health__summary-text">
            {loading ? "Checking storage access…" : "Run checks to review storage access."}
          </span>
        </div>
      </div>
    );
  }

  const { activeSections, status, label, checkedAt } = getSummary(result);
  return (
    <div className={`arr-health__summary is-${status}`}>
      <div className="arr-health__summary-main">
        <span className={`arr-health__badge arr-health__badge--${status}`}>{label}</span>
        <span className="arr-health__summary-text">
          {activeSections.length} checks reviewed
          {result.failedCount > 0 ? ` · ${result.failedCount} failed` : ""}
          {result.warningCount > 0
            ? ` · ${result.warningCount} warning${result.warningCount === 1 ? "" : "s"}`
            : ""}
        </span>
      </div>
      {checkedAt ? (
        <span className="arr-health__summary-time">Last checked {checkedAt}</span>
      ) : null}
    </div>
  );
}

function summarizeDetail(detail) {
  const text = String(detail || "").trim();
  if (text.length <= 180) return null;
  if (/ENOENT|no such file/i.test(text)) return "Some configured paths could not be found.";
  if (/EACCES|permission denied/i.test(text)) return "A configured path could not be accessed.";
  return "Show technical details";
}

function HealthDetail({ detail }) {
  const text = String(detail || "").trim();
  const summary = summarizeDetail(text);
  if (!summary) return <code className="arr-health__path">{text}</code>;

  return (
    <details className="arr-health__technical">
      <summary>{summary}</summary>
      <code className="arr-health__path">{text}</code>
    </details>
  );
}

export function StorageHealthDashboard({ result, loading = false, showSummary = true }) {
  const [expanded, setExpanded] = useState({});
  const sections = result?.sections;

  useEffect(() => {
    if (!sections?.length) return;
    setExpanded(defaultExpandedBySection(sections));
  }, [result?.checkedAt, sections]);

  if (!result?.sections?.length) {
    if (loading) {
      return (
        <div className="arr-health" role="status">
          <p className="arr-health__loading">Running storage checks…</p>
        </div>
      );
    }
    return null;
  }

  const toggleSection = (sectionId) => {
    setExpanded((current) => ({
      ...current,
      [sectionId]: !current[sectionId],
    }));
  };

  return (
    <div className="arr-health" role="status">
      {showSummary ? <StorageHealthSummary result={result} /> : null}

      <div className="arr-health__table-wrap">
        <table className="arr-health__table">
          <thead>
            <tr>
              <th scope="col">Status</th>
              <th scope="col">Check</th>
              <th scope="col">Detail</th>
              <th scope="col">Fix</th>
            </tr>
          </thead>
          <tbody>
            {result.sections.map((section) => {
              const isExpanded = expanded[section.id] === true;
              const isCollapsible = section.status !== "skip" && (section.steps?.length ?? 0) > 0;

              return (
                <SectionGroup
                  key={section.id}
                  section={section}
                  isExpanded={isExpanded}
                  isCollapsible={isCollapsible}
                  onToggle={() => toggleSection(section.id)}
                />
              );
            })}
          </tbody>
        </table>
      </div>
    </div>
  );
}

function SectionGroup({ section, isExpanded, isCollapsible, onToggle }) {
  return (
    <>
      <tr
        className={`arr-health__section-row is-${section.status}${
          isCollapsible ? " is-collapsible" : ""
        }`}
      >
        <td colSpan={4}>
          {isCollapsible ? (
            <button
              type="button"
              className="arr-health__section-toggle"
              onClick={onToggle}
              aria-expanded={isExpanded}
            >
              <ChevronDown
                className={`arr-health__section-chevron${isExpanded ? "" : " is-collapsed"}`}
                aria-hidden
              />
              <span className={`arr-health__badge arr-health__badge--${section.status}`}>
                {STATUS_LABELS[section.status] || section.status}
              </span>
              <span className="arr-health__section-title">{section.title}</span>
            </button>
          ) : (
            <div className="arr-health__section-cell">
              <span className={`arr-health__badge arr-health__badge--${section.status}`}>
                {STATUS_LABELS[section.status] || section.status}
              </span>
              <span className="arr-health__section-title">{section.title}</span>
              {section.skipReason ? (
                <span className="arr-health__section-skip">{section.skipReason}</span>
              ) : null}
            </div>
          )}
        </td>
      </tr>
      {isExpanded
        ? (section.steps || []).map((step) => (
            <tr
              key={`${section.id}-${step.id}`}
              className={`arr-health__step-row is-${step.status}`}
            >
              <td>
                <span className={`arr-health__badge arr-health__badge--${step.status}`}>
                  {STATUS_LABELS[step.status] || step.status}
                </span>
              </td>
              <td className="arr-health__check">{step.label}</td>
              <td className="arr-health__detail">
                {step.detail ? (
                  <HealthDetail detail={step.detail} />
                ) : (
                  <span className="arr-health__muted">—</span>
                )}
              </td>
              <td className="arr-health__fix">
                {step.fix ? step.fix : <span className="arr-health__muted">—</span>}
              </td>
            </tr>
          ))
        : null}
    </>
  );
}
