import { useMemo, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useTranslation } from "react-i18next";
import {
  ArrowLeftRight,
  Check,
  Code2,
  GitBranch,
  History,
  LayoutGrid,
  ShieldCheck,
  Trash2,
} from "lucide-react";
import { ApiError, api } from "../api/client";
import {
  diffRevisions,
  redactCodeSecrets,
  redactSecrets,
} from "../utils/revisionDiff";
import type { RevisionRecord } from "../types";

export function VersionsView({
  projectId,
  activeRevisionId,
  onEvaluate,
}: {
  projectId: string;
  activeRevisionId: string | null;
  onEvaluate: (a: string, b: string) => void;
}) {
  const { t, i18n } = useTranslation();
  const queryClient = useQueryClient();
  const {
    data = [],
    isLoading,
    error,
  } = useQuery({
    queryKey: ["revisions", projectId],
    queryFn: () => api.listRevisions(projectId),
    enabled: projectId !== "proj-local",
  });
  const [baselineId, setBaselineId] = useState("");
  const [candidateId, setCandidateId] = useState("");
  const [showCompare, setShowCompare] = useState(false);
  const [detailId, setDetailId] = useState("");
  const [deleteError, setDeleteError] = useState("");
  const removeRevision = useMutation({
    mutationFn: (revisionId: string) =>
      api.deleteRevision(projectId, revisionId),
    onSuccess: (_result, revisionId) => {
      setDeleteError("");
      if (baselineId === revisionId) setBaselineId("");
      if (candidateId === revisionId) setCandidateId("");
      void queryClient.invalidateQueries({ queryKey: ["revisions", projectId] });
    },
    onError: (mutationError) =>
      setDeleteError(
        mutationError instanceof ApiError && mutationError.status === 409
          ? t("This version is referenced by an A/B evaluation, or is the only version — it cannot be deleted.")
          : t("Could not delete version"),
      ),
  });
  const baseline = data.find((revision) => revision.id === baselineId);
  const candidate = data.find((revision) => revision.id === candidateId);
  const diff = useMemo(
    () => (baseline && candidate ? diffRevisions(baseline, candidate) : null),
    [baseline, candidate],
  );
  const select = (slot: "a" | "b", id: string) => {
    if (slot === "a") {
      setBaselineId(id);
      if (candidateId === id) setCandidateId("");
    } else {
      setCandidateId(id);
      if (baselineId === id) setBaselineId("");
    }
    setShowCompare(false);
  };
  if (projectId === "proj-local")
    return (
      <PageEmpty
        title={t("Save the project first")}
        copy={t("Version comparison requires immutable server revision IDs.")}
      />
    );
  return (
    <div className="table-view">
      <div className="view-heading">
        <div>
          <div className="eyebrow">{t("HISTORY")}</div>
          <h1>{t("Versions")}</h1>
          <p>{t("Select one baseline and one candidate revision.")}</p>
        </div>
        <div className="view-actions">
          <button
            className="tool-button with-label"
            disabled={!baseline || !candidate}
            onClick={() =>
              baseline && candidate && onEvaluate(baseline.id, candidate.id)
            }
          >
            <ShieldCheck size={14} /> {t("A/B evaluate")}
          </button>
          <button
            className="tool-button with-label primary"
            disabled={!diff}
            onClick={() => setShowCompare(true)}
          >
            <GitBranch size={14} /> {t("Compare")}
          </button>
        </div>
      </div>
      {isLoading ? (
        <PageEmpty
          title={t("Loading revisions")}
          copy={t("Reading immutable project history.")}
        />
      ) : error ? (
        <PageEmpty
          title={t("Revisions unavailable")}
          copy={t("Could not read revision history from the runner.")}
        />
      ) : (
        <div
          className={`versions-layout ${showCompare && diff ? "comparing" : ""}`}
        >
          <div className="version-list">
            <div className="version-selection-head">
              <span>{t("Revision")}</span>
              <span>{t("Baseline A")}</span>
              <span>{t("Candidate B")}</span>
            </div>
            {data.map((revision) => (
              <div
                className={`version-item ${revision.id === activeRevisionId ? "current" : ""}`}
                key={revision.id}
              >
                <div className="version-mark">
                  {revision.id === activeRevisionId ? (
                    <Check size={13} />
                  ) : (
                    <History size={13} />
                  )}
                </div>
                <div className="version-copy">
                  <strong>
                    {t("Revision")} {revision.sequence ?? "?"}
                  </strong>
                  <p>
                    {revision.message || t("Checkpoint")} ·{" "}
                    {new Date(revision.created_at).toLocaleString(
                      i18n.language,
                    )}
                  </p>
                </div>
                <label className="revision-radio">
                  <input
                    type="radio"
                    name="baseline"
                    checked={baselineId === revision.id}
                    onChange={() => select("a", revision.id)}
                  />
                  <span>A</span>
                </label>
                <label className="revision-radio">
                  <input
                    type="radio"
                    name="candidate"
                    checked={candidateId === revision.id}
                    onChange={() => select("b", revision.id)}
                  />
                  <span>B</span>
                </label>
                <button
                  className="small-icon version-delete"
                  title={
                    revision.id === activeRevisionId
                      ? t("The active version cannot be deleted")
                      : t("Delete version")
                  }
                  disabled={
                    revision.id === activeRevisionId || removeRevision.isPending
                  }
                  onClick={() => {
                    if (window.confirm(t("Delete this version and its run records?")))
                      removeRevision.mutate(revision.id);
                  }}
                >
                  <Trash2 size={13} />
                </button>
              </div>
            ))}
          </div>
          {deleteError && <div className="inline-error">{deleteError}</div>}
          {showCompare && diff && baseline && candidate && (
            <RevisionCompare
              baseline={baseline}
              candidate={candidate}
              diff={diff}
              detailId={detailId}
              setDetailId={setDetailId}
            />
          )}
        </div>
      )}
    </div>
  );
}

function RevisionCompare({
  baseline,
  candidate,
  diff,
  detailId,
  setDetailId,
}: {
  baseline: RevisionRecord;
  candidate: RevisionRecord;
  diff: ReturnType<typeof diffRevisions>;
  detailId: string;
  setDetailId: (id: string) => void;
}) {
  const { t } = useTranslation();
  const selected =
    diff.blocks.find((block) => block.id === detailId) ?? diff.blocks[0];
  const before = (baseline.graph?.blocks ?? []).find(
    (block) => block.id === selected?.id,
  );
  const after = (candidate.graph?.blocks ?? []).find(
    (block) => block.id === selected?.id,
  );
  return (
    <section className="revision-compare">
      <div className="compare-head">
        <div>
          <span>
            A · {t("Revision")} {baseline.sequence}
          </span>
          <ArrowLeftRight size={14} />
          <span>
            B · {t("Revision")} {candidate.sequence}
          </span>
        </div>
        <small>{t("Secret-like config and code values are redacted")}</small>
      </div>
      <div className="diff-summary">
        <DiffMetric label={t("Added")} value={diff.counts.added} tone="added" />
        <DiffMetric
          label={t("Removed")}
          value={diff.counts.removed}
          tone="removed"
        />
        <DiffMetric
          label={t("Modified")}
          value={diff.counts.modified}
          tone="modified"
        />
        <DiffMetric
          label={t("Layout only")}
          value={diff.counts.layoutOnly}
          tone="layout"
        />
        <DiffMetric
          label={t("Edges")}
          value={diff.counts.edgeChanges}
          tone="edge"
        />
      </div>
      <div className="diff-block-list">
        {diff.blocks.length ? (
          diff.blocks.map((block) => (
            <button
              className={selected?.id === block.id ? "active" : ""}
              key={block.id}
              onClick={() => setDetailId(block.id)}
            >
              <span className={`diff-kind ${block.kind}`} />{" "}
              <strong>{block.label}</strong>
              <span>{block.kind}</span>
              {block.configChanged && <Code2 size={11} />}
              {block.layoutChanged && <LayoutGrid size={11} />}
            </button>
          ))
        ) : (
          <div className="no-structural-diff">{t("No block changes.")}</div>
        )}
      </div>
      {selected && (
        <div className="diff-detail">
          <div>
            <div className="section-label">{t("Baseline config")}</div>
            <pre>
              {JSON.stringify(redactSecrets(before?.config ?? null), null, 2)}
            </pre>
          </div>
          <div>
            <div className="section-label">{t("Candidate config")}</div>
            <pre>
              {JSON.stringify(redactSecrets(after?.config ?? null), null, 2)}
            </pre>
          </div>
          <div>
            <div className="section-label">{t("Baseline code override")}</div>
            <pre>{redactCodeSecrets(before?.code_override)}</pre>
          </div>
          <div>
            <div className="section-label">{t("Candidate code override")}</div>
            <pre>{redactCodeSecrets(after?.code_override)}</pre>
          </div>
        </div>
      )}
      <div className="edge-diff">
        <span>
          + {diff.edges.added.length} {t("connections")}
        </span>
        <span>
          − {diff.edges.removed.length} {t("connections")}
        </span>
      </div>
    </section>
  );
}
function DiffMetric({
  label,
  value,
  tone,
}: {
  label: string;
  value: number;
  tone: string;
}) {
  return (
    <div className={`diff-metric ${tone}`}>
      <span>{label}</span>
      <strong>{value}</strong>
    </div>
  );
}
function PageEmpty({ title, copy }: { title: string; copy: string }) {
  return (
    <div className="page-empty">
      <History size={20} />
      <strong>{title}</strong>
      <span>{copy}</span>
    </div>
  );
}
