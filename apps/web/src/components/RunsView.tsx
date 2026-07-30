import { Fragment, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { useTranslation } from "react-i18next";
import { Activity, AlertTriangle, ChevronDown, ChevronRight, Download, LoaderCircle } from "lucide-react";
import { api } from "../api/client";
import type { RemoteRunRecord, RunRecord } from "../types";
import { safeCsvCell } from "../utils/revisionDiff";

const duration = (run: RemoteRunRecord) =>
  run.duration_ms ??
  run.metrics?.duration_ms ??
  (run.completed_at
    ? Math.max(
        0,
        new Date(run.completed_at).getTime() -
          new Date(run.created_at).getTime(),
      )
    : undefined);
const outputText = (value: unknown) =>
  value == null
    ? ""
    : typeof value === "string"
      ? value
      : JSON.stringify(value);

export function RunsView({
  projectId,
  localRuns,
}: {
  projectId: string;
  localRuns: RunRecord[];
}) {
  const { t, i18n } = useTranslation();
  const remote = projectId !== "proj-local";
  const [expandedId, setExpandedId] = useState<string | null>(null);
  const {
    data = [],
    isLoading,
    error,
  } = useQuery({
    queryKey: ["runs", projectId],
    queryFn: () => api.listRuns(projectId),
    enabled: remote,
  });
  const rows: RemoteRunRecord[] = remote
    ? data
    : localRuns.map((run) => ({
        id: run.id,
        project_id: run.projectId,
        revision_id: run.revisionId ?? "local",
        revision_sequence: run.revisionSequence,
        status: run.status,
        input: run.input,
        output: run.output,
        error: run.error,
        created_at: run.startedAt,
        completed_at: run.completedAt,
        duration_ms: run.durationMs,
      }));
  const exportCsv = () => {
    const header = [
      "run_id",
      "revision_id",
      "status",
      "created_at",
      "duration_ms",
      "input",
      "output",
      "error",
    ];
    const lines = [
      header.map(safeCsvCell).join(","),
      ...rows.map((run) =>
        [
          run.id,
          run.revision_id,
          run.status,
          run.created_at,
          duration(run) ?? "",
          run.input,
          run.output,
          run.error ?? "",
        ]
          .map(safeCsvCell)
          .join(","),
      ),
    ];
    const a = document.createElement("a");
    a.href = URL.createObjectURL(
      new Blob([lines.join("\r\n")], { type: "text/csv;charset=utf-8" }),
    );
    a.download = "agentlab-runs.csv";
    a.click();
    URL.revokeObjectURL(a.href);
  };
  return (
    <div className="table-view">
      <div className="view-heading">
        <div>
          <div className="eyebrow">{t("OBSERVE")}</div>
          <h1>{t("Run history")}</h1>
          <p>{t("Runs are pinned to immutable server revision IDs.")}</p>
        </div>
        <button
          className="tool-button with-label"
          disabled={!rows.length}
          onClick={exportCsv}
        >
          <Download size={14} /> {t("Export CSV")}
        </button>
      </div>
      <div className="run-table">
        <div className="table-row table-head">
          <span>{t("Run")}</span>
          <span>{t("Revision")}</span>
          <span>{t("Status")}</span>
          <span>{t("Started")}</span>
          <span>{t("Duration")}</span>
          <span>{t("Output")}</span>
        </div>
        {isLoading ? (
          <Empty
            title={t("Loading runs")}
            copy={t("Reading persisted run records from the runner.")}
          />
        ) : error ? (
          <Empty
            title={t("Runs unavailable")}
            copy={t(
              "The runner does not expose the project runs endpoint yet.",
            )}
          />
        ) : rows.length ? (
          rows.map((run) => (
            <Fragment key={run.id}>
              <button
                className={`table-row run-row ${expandedId === run.id ? "expanded" : ""}`}
                onClick={() =>
                  setExpandedId((current) => (current === run.id ? null : run.id))
                }
              >
                <span className="mono">
                  {expandedId === run.id ? (
                    <ChevronDown size={12} />
                  ) : (
                    <ChevronRight size={12} />
                  )}{" "}
                  {run.id.slice(0, 14)}
                </span>
                <span title={run.revision_id}>
                  {run.revision_sequence
                    ? `${t("Revision")} ${run.revision_sequence}`
                    : run.revision_id.slice(0, 10)}
                </span>
                <span>
                  <span className={`run-pill ${run.status}`}>{run.status}</span>
                </span>
                <span>
                  {new Date(run.created_at).toLocaleString(i18n.language)}
                </span>
                <span>{duration(run) != null ? `${duration(run)}ms` : "—"}</span>
                <span title={outputText(run.output) || run.error || ""}>
                  {outputText(run.output).slice(0, 52) ||
                    run.error?.slice(0, 52) ||
                    "—"}
                </span>
              </button>
              {expandedId === run.id && (
                <RunDetailPanel
                  runId={run.id}
                  remote={remote}
                  localRun={localRuns.find((item) => item.id === run.id)}
                />
              )}
            </Fragment>
          ))
        ) : (
          <Empty
            title={t("No runs recorded")}
            copy={t(
              "Run the current revision to create the first persistent trace.",
            )}
          />
        )}
      </div>
    </div>
  );
}

function RunDetailPanel({
  runId,
  remote,
  localRun,
}: {
  runId: string;
  remote: boolean;
  localRun?: RunRecord;
}) {
  const { t } = useTranslation();
  const detail = useQuery({
    queryKey: ["run-detail", runId],
    queryFn: () => api.getRun(runId),
    enabled: remote,
  });
  const pretty = (value: unknown) =>
    value == null ? "—" : JSON.stringify(value, null, 2);
  if (!remote)
    return (
      <div className="run-detail">
        <div className="section-label">{t("Trace")}</div>
        {localRun?.trace.length ? (
          localRun.trace.map((event) => (
            <div className="run-detail-span" key={event.id}>
              <span className={`run-pill ${event.status === "success" ? "success" : event.status === "error" ? "failed" : ""}`}>
                {event.status}
              </span>
              <span className="mono">{event.nodeName ?? event.type}</span>
              <span>{event.message}</span>
              <span>{event.durationMs ? `${event.durationMs}ms` : ""}</span>
            </div>
          ))
        ) : (
          <div className="empty-field">{t("No trace events yet")}</div>
        )}
      </div>
    );
  if (detail.isLoading)
    return (
      <div className="run-detail">
        <div className="loading-row">
          <LoaderCircle className="spin" size={14} /> {t("Loading run detail")}
        </div>
      </div>
    );
  if (detail.error || !detail.data)
    return (
      <div className="run-detail">
        <div className="empty-field">{t("Run detail unavailable")}</div>
      </div>
    );
  const run = detail.data;
  return (
    <div className="run-detail">
      {run.error && (
        <div className="run-error-banner">
          <AlertTriangle size={13} />
          <span>{run.error}</span>
        </div>
      )}
      <div className="section-label">{t("Node spans")}</div>
      <div className="run-span-table">
        <div className="run-detail-span run-detail-head">
          <span>{t("Status")}</span>
          <span>{t("Node")}</span>
          <span>{t("Block")}</span>
          <span>{t("Duration")}</span>
          <span>{t("Tokens")}</span>
          <span>{t("Cost")}</span>
        </div>
        {run.spans.length ? (
          run.spans.map((span) => (
            <div className="run-detail-span" key={span.id}>
              <span>
                <span className={`run-pill ${span.status === "completed" ? "success" : span.status === "failed" ? "failed" : ""}`}>
                  {span.status}
                </span>
              </span>
              <span className="mono">{span.node_id}</span>
              <span>{span.block_type ?? "—"}</span>
              <span>
                {typeof span.metrics?.duration_ms === "number"
                  ? `${span.metrics.duration_ms}ms`
                  : "—"}
              </span>
              <span>
                {typeof span.metrics?.tokens === "number" && span.metrics.tokens
                  ? span.metrics.tokens
                  : "—"}
              </span>
              <span>
                {typeof span.metrics?.cost_usd === "number"
                  ? `$${span.metrics.cost_usd.toFixed(4)}`
                  : "—"}
              </span>
            </div>
          ))
        ) : (
          <div className="empty-field">{t("No spans recorded for this run.")}</div>
        )}
      </div>
      <div className="run-detail-io">
        <div>
          <div className="section-label">{t("Input")}</div>
          <pre>{pretty(run.input)}</pre>
        </div>
        <div>
          <div className="section-label">{t("Output")}</div>
          <pre>{run.error ? run.error : pretty(run.output)}</pre>
        </div>
      </div>
    </div>
  );
}

function Empty({ title, copy }: { title: string; copy: string }) {
  return (
    <div className="table-empty">
      <Activity size={18} />
      <strong>{title}</strong>
      <span>{copy}</span>
    </div>
  );
}
