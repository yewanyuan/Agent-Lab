import { useEffect, useMemo, useRef, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useTranslation } from "react-i18next";
import {
  Activity,
  ArrowLeftRight,
  Braces,
  Check,
  FileJson,
  FlaskConical,
  LoaderCircle,
  Play,
  Plus,
  Save,
  ShieldCheck,
  Trash2,
  Upload,
  X,
} from "lucide-react";
import { api, streamEvaluationEvents } from "../api/client";
import { redactCodeSecrets, redactSecrets } from "../utils/revisionDiff";
import type {
  EvalAssertion,
  EvalCase,
  EvalSuite,
  EvaluationExperiment,
  EvaluatorType,
  RevisionRecord,
} from "../types";

type SuiteDraft = Omit<EvalSuite, "id" | "project_id"> & { id?: string };
const blankSuite = (translate: (value: string) => string = (value) => value): SuiteDraft => ({
  name: translate("New evaluation suite"),
  description: "",
  cases: [
    {
      id: crypto.randomUUID(),
      name: `${translate("Case")} 1`,
      input: "",
      expected: "",
      assertions: [{ type: "exact", value: "" }],
    },
  ],
});
const display = (value: unknown) =>
  typeof value === "string" ? value : JSON.stringify(value);
const safeDisplay = (value: unknown) =>
  redactCodeSecrets(display(redactSecrets(value)));
const parse = (value: string): unknown => {
  const trimmed = value.trim();
  if (!trimmed) return "";
  try {
    return JSON.parse(trimmed);
  } catch {
    return value;
  }
};

export function EvaluationsView({
  projectId,
  prefill,
  onPrefillConsumed,
}: {
  projectId: string;
  prefill?: { baseline: string; candidate: string } | null;
  onPrefillConsumed?: () => void;
}) {
  const { t, i18n } = useTranslation();
  const queryClient = useQueryClient();
  const [editorOpen, setEditorOpen] = useState(false);
  const [draft, setDraft] = useState<SuiteDraft>(() => blankSuite(t));
  const [baselineId, setBaselineId] = useState(prefill?.baseline ?? "");
  const [candidateId, setCandidateId] = useState(prefill?.candidate ?? "");
  const [suiteId, setSuiteId] = useState("");
  const [selectedEvalId, setSelectedEvalId] = useState("");
  const [progress, setProgress] = useState<{
    done: number;
    total: number;
  } | null>(null);
  const importInput = useRef<HTMLInputElement>(null);
  const [budgets, setBudgets] = useState({
    max_cases: 20,
    max_tokens: 100_000,
    max_cost_usd: 10,
    max_wall_seconds: 120,
  });
  useEffect(() => {
    if (prefill) {
      setBaselineId(prefill.baseline);
      setCandidateId(prefill.candidate);
      onPrefillConsumed?.();
    }
  }, [prefill, onPrefillConsumed]);
  const enabled = projectId !== "proj-local";
  const revisions = useQuery({
    queryKey: ["revisions", projectId],
    queryFn: () => api.listRevisions(projectId),
    enabled,
  });
  const suites = useQuery({
    queryKey: ["eval-suites", projectId],
    queryFn: () => api.listEvalSuites(projectId),
    enabled,
  });
  const evaluations = useQuery({
    queryKey: ["evaluations", projectId],
    queryFn: () => api.listEvaluations(projectId),
    enabled,
    refetchInterval: (query) =>
      (query.state.data as EvaluationExperiment[] | undefined)?.some(
        (item) => item.status === "running" || item.status === "queued",
      )
        ? 3000
        : false,
  });
  const selectedEvaluation = useQuery({
    queryKey: ["evaluation", projectId, selectedEvalId],
    queryFn: () => api.getEvaluation(projectId, selectedEvalId),
    enabled: Boolean(selectedEvalId),
    refetchInterval: (query) =>
      ["running", "queued"].includes(
        (query.state.data as EvaluationExperiment | undefined)?.status ?? "",
      )
        ? 2500
        : false,
  });
  useEffect(() => {
    const evaluation = selectedEvaluation.data;
    if (!evaluation || !["running", "queued"].includes(evaluation.status))
      return;
    return streamEvaluationEvents(
      projectId,
      evaluation.id,
      (event) => {
        const done = Number(
          event.completed_cases ??
            event.completed ??
            (typeof event.case_index === "number" ? event.case_index + 1 : 0),
        );
        const total = Number(
          event.total_cases ??
            event.total ??
            evaluation.total_cases ??
            suites.data?.find((suite) => suite.id === evaluation.eval_suite_id)
              ?.cases.length ??
            0,
        );
        setProgress({ done, total });
      },
      () => {
        void queryClient.invalidateQueries({
          queryKey: ["evaluation", projectId, evaluation.id],
        });
        void queryClient.invalidateQueries({
          queryKey: ["evaluations", projectId],
        });
      },
    );
  }, [projectId, queryClient, selectedEvaluation.data, suites.data]);
  useEffect(() => {
    if (!suiteId && suites.data?.[0]) setSuiteId(suites.data[0].id);
  }, [suiteId, suites.data]);
  const saveSuite = useMutation({
    mutationFn: () =>
      draft.id
        ? api.updateEvalSuite(projectId, draft.id, draft)
        : api.createEvalSuite(projectId, draft),
    onSuccess: (saved) => {
      setSuiteId(saved.id);
      setDraft({ ...saved });
      setEditorOpen(false);
      void queryClient.invalidateQueries({
        queryKey: ["eval-suites", projectId],
      });
    },
  });
  const deleteSuite = useMutation({
    mutationFn: (id: string) => api.deleteEvalSuite(projectId, id),
    onSuccess: () => {
      setSuiteId("");
      setDraft(blankSuite(t));
      setEditorOpen(false);
      void queryClient.invalidateQueries({
        queryKey: ["eval-suites", projectId],
      });
    },
  });
  const start = useMutation({
    mutationFn: () =>
      api.startEvaluation(projectId, {
        baseline_revision_id: baselineId,
        candidate_revision_id: candidateId,
        eval_suite_id: suiteId,
        budgets,
      }),
    onSuccess: (evaluation) => {
      setSelectedEvalId(evaluation.id);
      setProgress({
        done: evaluation.completed_cases ?? evaluation.cases?.length ?? 0,
        total: evaluation.total_cases ?? 0,
      });
      void queryClient.invalidateQueries({
        queryKey: ["evaluations", projectId],
      });
    },
  });
  const deleteEvaluation = useMutation({
    mutationFn: (id: string) => api.deleteEvaluation(projectId, id),
    onSuccess: (_result, id) => {
      if (selectedEvalId === id) setSelectedEvalId("");
      void queryClient.invalidateQueries({
        queryKey: ["evaluations", projectId],
      });
    },
  });
  const openSuite = (suite?: EvalSuite) => {
    setDraft(
      suite ? { ...suite, cases: structuredClone(suite.cases) } : blankSuite(t),
    );
    setEditorOpen(true);
  };
  const importJson = async (file?: File) => {
    if (!file) return;
    try {
      const parsed = JSON.parse(await file.text()) as
        | Partial<EvalSuite>
        | EvalCase[];
      const cases = Array.isArray(parsed) ? parsed : parsed.cases;
      if (!Array.isArray(cases)) throw new Error("cases missing");
      setDraft({
        name: Array.isArray(parsed)
          ? file.name.replace(/\.json$/i, "")
          : (parsed.name ?? "Imported suite"),
        description: Array.isArray(parsed) ? "" : (parsed.description ?? ""),
        cases: cases.map((item, index) => ({
          id: item.id || `case-${index + 1}`,
          name: item.name || `Case ${index + 1}`,
          input: item.input,
          expected: item.expected,
          assertions: item.assertions?.length
            ? item.assertions
            : [{ type: "exact", value: item.expected ?? "" }],
        })),
      });
      setEditorOpen(true);
    } catch {
      /* Keep the current draft when JSON is invalid. */
    }
  };
  if (!enabled)
    return (
      <div className="page-empty">
        <FlaskConical size={22} />
        <strong>{t("Save the project before evaluating")}</strong>
        <span>{t("A/B evaluation requires two immutable server revisions and a persistent evaluation suite.")}</span>
      </div>
    );
  const selectedSuite = suites.data?.find((suite) => suite.id === suiteId);
  const estimatedRuns =
    Math.min(selectedSuite?.cases.length ?? 0, budgets.max_cases) * 2;
  const detail = selectedEvaluation.data;
  const currentProgress =
    progress ??
    (detail
      ? {
          done: detail.completed_cases ?? detail.cases?.length ?? 0,
          total: detail.total_cases ?? 0,
        }
      : null);
  return (
    <div className="evaluations-view">
      <div className="view-heading">
        <div>
          <div className="eyebrow">{t("VERIFY")}</div>
          <h1>{t("A/B evaluations")}</h1>
          <p>{t("Compare immutable revisions against a reusable test suite.")}</p>
        </div>
        <div className="view-actions">
          <input
            ref={importInput}
            type="file"
            accept="application/json,.json"
            hidden
            onChange={(event) => {
              void importJson(event.target.files?.[0]);
              event.target.value = "";
            }}
          />
          <button
            className="tool-button with-label"
            onClick={() => importInput.current?.click()}
          >
            <Upload size={14} /> {t("Import JSON")}
          </button>
          <button
            className="tool-button with-label"
            onClick={() => openSuite()}
          >
            <Plus size={14} /> {t("New suite")}
          </button>
        </div>
      </div>
      <div className="evaluation-layout">
        <aside className="evaluation-launcher">
          <div className="section-label">{t("Start comparison")}</div>
          <label>
            {t("Baseline revision")}
            <select
              value={baselineId}
              onChange={(e) => setBaselineId(e.target.value)}
            >
              <option value="">{t("Select baseline A")}</option>
              {revisions.data?.map((revision) => (
                <option key={revision.id} value={revision.id}>
                  {t("Revision")} {revision.sequence}
                </option>
              ))}
            </select>
          </label>
          <label>
            {t("Candidate revision")}
            <select
              value={candidateId}
              onChange={(e) => setCandidateId(e.target.value)}
            >
              <option value="">{t("Select candidate B")}</option>
              {revisions.data?.map((revision) => (
                <option key={revision.id} value={revision.id}>
                  {t("Revision")} {revision.sequence}
                </option>
              ))}
            </select>
          </label>
          <label>
            {t("Evaluation suite")}
            <select
              value={suiteId}
              onChange={(e) => setSuiteId(e.target.value)}
            >
              <option value="">{t("Select suite")}</option>
              {suites.data?.map((suite) => (
                <option key={suite.id} value={suite.id}>
                  {suite.name} · {suite.cases.length} {t("cases")}
                </option>
              ))}
            </select>
          </label>
          <div className="budget-grid">
            <label>
              {t("Max cases")}
              <input
                type="number"
                min="1"
                max="100"
                value={budgets.max_cases}
                onChange={(e) =>
                  setBudgets((current) => ({
                    ...current,
                    max_cases: Math.max(
                      1,
                      Math.min(100, Number(e.target.value) || 1),
                    ),
                  }))
                }
              />
            </label>
            <label>
              {t("Max tokens")}
              <input
                type="number"
                min="1"
                max="10000000"
                value={budgets.max_tokens}
                onChange={(e) =>
                  setBudgets((current) => ({
                    ...current,
                    max_tokens: Math.max(1, Number(e.target.value) || 1),
                  }))
                }
              />
            </label>
            <label>
              {t("Max cost USD")}
              <input
                type="number"
                min="0"
                max="1000"
                step="0.1"
                value={budgets.max_cost_usd}
                onChange={(e) =>
                  setBudgets((current) => ({
                    ...current,
                    max_cost_usd: Math.max(0, Number(e.target.value) || 0),
                  }))
                }
              />
            </label>
            <label>
              {t("Wall seconds")}
              <input
                type="number"
                min="1"
                max="3600"
                value={budgets.max_wall_seconds}
                onChange={(e) =>
                  setBudgets((current) => ({
                    ...current,
                    max_wall_seconds: Math.max(1, Number(e.target.value) || 1),
                  }))
                }
              />
            </label>
          </div>
          <div className="evaluation-estimate">
            <strong>{estimatedRuns} {t("paired runs maximum")}</strong>
            <span>{t("Simulator runs are always available. Real-provider A/B requires an exact model snapshot in the runner price registry; aliases and unknown models fail closed.")}</span>
          </div>
          <button
            className="launch-eval"
            disabled={
              !baselineId ||
              !candidateId ||
              baselineId === candidateId ||
              !suiteId ||
              start.isPending
            }
            onClick={() => start.mutate()}
          >
            {start.isPending ? (
              <LoaderCircle className="spin" size={14} />
            ) : (
              <Play size={14} fill="currentColor" />
            )}{" "}
            {t("Start A/B evaluation")}
          </button>
          {start.error && (
            <div className="inline-error">
              {start.error instanceof Error
                ? redactCodeSecrets(start.error.message)
                : t("Could not start evaluation.")}
            </div>
          )}
          <div className="suite-list-head">
            <span>{t("Evaluation suites")}</span>
          </div>
          <div className="suite-list">
            {suites.data?.map((suite) => (
              <button key={suite.id} onClick={() => openSuite(suite)}>
                <FileJson size={13} />
                <span>
                  <strong>{suite.name}</strong>
                  <small>{suite.cases.length} {t("cases")} · {t("paired assertions")}</small>
                </span>
              </button>
            ))}
            {!suites.isLoading && !suites.data?.length && (
              <div className="empty-suite">
                {t("Create or import a suite to begin.")}
              </div>
            )}
          </div>
        </aside>
        <main className="evaluation-results">
          <div className="evaluation-history">
            <div className="section-label">{t("Experiments")}</div>
            {evaluations.isLoading ? (
              <div className="loading-row">
                <LoaderCircle className="spin" size={14} /> {t("Loading evaluations")}
              </div>
            ) : evaluations.data?.length ? (
              evaluations.data.map((evaluation) => (
                <button
                  className={selectedEvalId === evaluation.id ? "active" : ""}
                  key={evaluation.id}
                  onClick={() => setSelectedEvalId(evaluation.id)}
                >
                  <span className={`eval-status ${evaluation.status}`} />
                  <span>
                    <strong>
                      {revisionLabel(
                        revisions.data,
                        evaluation.baseline_revision_id,
                        t,
                      )}{" "}
                      →{" "}
                      {revisionLabel(
                        revisions.data,
                        evaluation.candidate_revision_id,
                        t,
                      )}
                    </strong>
                    <small>
                      {new Date(evaluation.created_at).toLocaleString(i18n.language)}
                    </small>
                  </span>
                  <span className="eval-progress-text">
                    {evaluation.completed_cases ??
                      evaluation.cases?.length ??
                      0}
                    /{evaluation.total_cases ?? "—"}
                  </span>
                </button>
              ))
            ) : (
              <div className="evaluation-empty">
                <Activity size={18} />
                <strong>{t("No evaluations yet")}</strong>
                <span>{t("Configure revisions and a suite, then start the first comparison.")}</span>
              </div>
            )}
          </div>
          {detail ? (
            <EvaluationDetail
              evaluation={detail}
              progress={currentProgress}
              onCancel={() =>
                api
                  .cancelEvaluation(projectId, detail.id)
                  .then(() =>
                    queryClient.invalidateQueries({
                      queryKey: ["evaluation", projectId, detail.id],
                    }),
                  )
              }
              onDelete={() => {
                if (window.confirm(t("Delete this evaluation and its recorded results?")))
                  deleteEvaluation.mutate(detail.id);
              }}
              deleting={deleteEvaluation.isPending}
            />
          ) : (
            <div className="evaluation-detail-empty">
              <ArrowLeftRight size={22} />
              <strong>{t("Select an experiment")}</strong>
              <span>{t("Results, paired metrics and assertion failures appear here.")}</span>
            </div>
          )}
        </main>
      </div>
      {editorOpen && (
        <SuiteEditor
          draft={draft}
          setDraft={setDraft}
          onClose={() => setEditorOpen(false)}
          onSave={() => saveSuite.mutate()}
          saving={saveSuite.isPending}
          onDelete={draft.id ? () => deleteSuite.mutate(draft.id!) : undefined}
        />
      )}
    </div>
  );
}

const revisionLabel = (revisions: RevisionRecord[] | undefined, id: string, translate: (value: string) => string) => {
  const revision = revisions?.find((item) => item.id === id);
  return revision ? `${translate("Revision")} ${revision.sequence}` : id.slice(0, 8);
};

function EvaluationDetail({
  evaluation,
  progress,
  onCancel,
  onDelete,
  deleting,
}: {
  evaluation: EvaluationExperiment;
  progress: { done: number; total: number } | null;
  onCancel: () => void;
  onDelete: () => void;
  deleting: boolean;
}) {
  const { t } = useTranslation();
  const caseKey = (item: NonNullable<EvaluationExperiment["cases"]>[number]) =>
    item.case_id ?? item.id ?? item.name ?? "case";
  const [caseId, setCaseId] = useState("");
  const result =
    evaluation.cases?.find((item) => caseKey(item) === caseId) ??
    evaluation.cases?.[0];
  const metrics = evaluation.metrics;
  return (
    <section className="evaluation-detail">
      <div className="evaluation-detail-head">
        <div>
          <span className={`run-pill ${evaluation.status}`}>
            {evaluation.status}
          </span>
          <strong>{evaluation.id.slice(0, 14)}</strong>
        </div>
        {["running", "queued"].includes(evaluation.status) ? (
          <button className="tool-button with-label" onClick={onCancel}>
            <X size={13} /> {t("Cancel")}
          </button>
        ) : (
          <button
            className="tool-button with-label danger"
            disabled={deleting}
            onClick={onDelete}
          >
            <Trash2 size={13} /> {t("Delete")}
          </button>
        )}
      </div>
      {progress && progress.total > 0 && (
        <div className="evaluation-progress">
          <span
            style={{
              width: `${Math.min(100, (progress.done / progress.total) * 100)}%`,
            }}
          />
          <small>
            {progress.done} / {progress.total} {t("cases")}
          </small>
        </div>
      )}
      <div className="evaluation-summary">
        <Summary
          label={t("Baseline pass")}
          value={
            metrics?.baseline_pass_rate != null
              ? `${(metrics.baseline_pass_rate * 100).toFixed(1)}%`
              : "—"
          }
        />
        <Summary
          label={t("Candidate pass")}
          value={
            metrics?.candidate_pass_rate != null
              ? `${(metrics.candidate_pass_rate * 100).toFixed(1)}%`
              : "—"
          }
          accent
        />
        <Summary label={t("Improvements")} value={metrics?.improvements ?? "—"} />
        <Summary label={t("Regressions")} value={metrics?.regressions ?? "—"} />
      </div>
      <div className="case-results">
        <div className="case-table">
          <div className="case-row case-head">
            <span>{t("Case")}</span>
            <span>{t("Status")}</span>
            <span>{t("A pass")}</span>
            <span>{t("B pass")}</span>
            <span>{t("Tokens")}</span>
          </div>
          {evaluation.cases?.map((item) => (
            <button
              className={`case-row ${result && caseKey(result) === caseKey(item) ? "active" : ""}`}
              key={caseKey(item)}
              onClick={() => setCaseId(caseKey(item))}
            >
              <span>{item.name ?? caseKey(item)}</span>
              <span className={`winner ${item.status}`}>
                {item.status.replaceAll("_", " ")}
              </span>
              <span>
                {item.baseline_result.skipped
                  ? "n/a"
                  : item.baseline_result.passed
                    ? "pass"
                    : "fail"}
              </span>
              <span>
                {item.candidate_result.skipped
                  ? "n/a"
                  : item.candidate_result.passed
                    ? "pass"
                    : "fail"}
              </span>
              <span>
                {(item.baseline_result.metrics?.tokens ?? 0) +
                  (item.candidate_result.metrics?.tokens ?? 0) || "—"}
              </span>
            </button>
          ))}
        </div>
        {result && (
          <div className="case-detail">
            <div>
              <div className="section-label">{t("Baseline output")}</div>
              <pre>
                {safeDisplay(result.baseline_result.output ?? t("No output"))}
              </pre>
            </div>
            <div>
              <div className="section-label">{t("Candidate output")}</div>
              <pre>
                {safeDisplay(result.candidate_result.output ?? t("No output"))}
              </pre>
            </div>
            {[
              ...result.baseline_result.failures.map(
                (failure) => `A: ${failure}`,
              ),
              ...result.candidate_result.failures.map(
                (failure) => `B: ${failure}`,
              ),
              ...(result.baseline_result.not_evaluable ?? []).map(
                (failure) => `A: ${failure}`,
              ),
              ...(result.candidate_result.not_evaluable ?? []).map(
                (failure) => `B: ${failure}`,
              ),
            ].map((failure, index) => (
              <p key={index}>
                <ShieldCheck size={12} /> {redactCodeSecrets(failure)}
              </p>
            ))}
          </div>
        )}
      </div>
    </section>
  );
}
function Summary({
  label,
  value,
  accent,
}: {
  label: string;
  value: string | number;
  accent?: boolean;
}) {
  return (
    <div className={accent ? "summary-card accent" : "summary-card"}>
      <span>{label}</span>
      <strong>{value}</strong>
    </div>
  );
}

function SuiteEditor({
  draft,
  setDraft,
  onClose,
  onSave,
  saving,
  onDelete,
}: {
  draft: SuiteDraft;
  setDraft: React.Dispatch<React.SetStateAction<SuiteDraft>>;
  onClose: () => void;
  onSave: () => void;
  saving: boolean;
  onDelete?: () => void;
}) {
  const { t } = useTranslation();
  const assertionTypes: EvaluatorType[] = [
    "exact",
    "contains",
    "regex",
    "json_schema",
    "max_steps",
    "tool_called",
    "max_cost_usd",
  ];
  const updateCase = (id: string, patch: Partial<EvalCase>) =>
    setDraft((current) => ({
      ...current,
      cases: current.cases.map((item) =>
        item.id === id ? { ...item, ...patch } : item,
      ),
    }));
  const updateAssertion = (
    caseId: string,
    index: number,
    patch: Partial<EvalAssertion>,
  ) =>
    setDraft((current) => ({
      ...current,
      cases: current.cases.map((item) =>
        item.id === caseId
          ? {
              ...item,
              assertions: item.assertions.map((assertion, assertionIndex) =>
                assertionIndex === index
                  ? { ...assertion, ...patch }
                  : assertion,
              ),
            }
          : item,
      ),
    }));
  return (
    <div className="modal-backdrop" onMouseDown={onClose}>
      <div
        className="suite-editor"
        onMouseDown={(event) => event.stopPropagation()}
      >
        <div className="modal-head">
          <div>
            <div className="eyebrow">{t("PERSISTENT DATASET")}</div>
            <h2>
              {t(draft.id ? "Edit evaluation suite" : "New evaluation suite")}
            </h2>
            <p>{t("Cases and assertions are saved independently from project revisions.")}</p>
          </div>
          <button className="small-icon" onClick={onClose}>
            <X size={16} />
          </button>
        </div>
        <div className="suite-meta">
          <label>
            {t("Name")}
            <input
              value={draft.name}
              onChange={(e) =>
                setDraft((current) => ({ ...current, name: e.target.value }))
              }
            />
          </label>
          <label>
            {t("Description")}
            <input
              value={draft.description ?? ""}
              onChange={(e) =>
                setDraft((current) => ({
                  ...current,
                  description: e.target.value,
                }))
              }
            />
          </label>
        </div>
        <div className="suite-section-head">
          <div>
            <strong>{t("Test cases")}</strong>
            <span>{draft.cases.length} {t("paired inputs")}</span>
          </div>
          <button
            className="tool-button with-label"
            onClick={() =>
              setDraft((current) => ({
                ...current,
                cases: current.cases.concat({
                  id: crypto.randomUUID(),
                  name: `${t("Case")} ${current.cases.length + 1}`,
                  input: "",
                  expected: "",
                  assertions: [{ type: "exact", value: "" }],
                }),
              }))
            }
          >
            <Plus size={13} /> {t("Add case")}
          </button>
        </div>
        <div className="cases-editor">
          <div className="cases-row cases-head">
            <span>{t("Name")}</span>
            <span>{t("Input / JSON")}</span>
            <span>{t("Expected / JSON")}</span>
            <span>{t("Assertion")}</span>
            <span />
          </div>
          {draft.cases.map((item) => (
            <div className="cases-row" key={item.id}>
              <input
                value={item.name}
                onChange={(e) => updateCase(item.id, { name: e.target.value })}
              />
              <textarea
                value={display(item.input)}
                onChange={(e) =>
                  updateCase(item.id, { input: parse(e.target.value) })
                }
              />
              <textarea
                value={display(item.expected ?? "")}
                onChange={(e) =>
                  updateCase(item.id, { expected: parse(e.target.value) })
                }
              />
              <div className="assertion-editor">
                {item.assertions.map((assertion, index) => (
                  <div className="assertion-row" key={index}>
                    <select
                      value={assertion.type}
                      onChange={(e) =>
                        updateAssertion(item.id, index, {
                          type: e.target.value as EvaluatorType,
                        })
                      }
                    >
                      {assertionTypes.map((type) => (
                        <option value={type} key={type}>
                          {type.replaceAll("_", " ")}
                        </option>
                      ))}
                    </select>
                    {assertion.type === "json_schema" ? (
                      <textarea
                        placeholder='{"type": "object"}'
                        value={display(assertion.value ?? "")}
                        onChange={(e) =>
                          updateAssertion(item.id, index, {
                            value: parse(e.target.value),
                          })
                        }
                      />
                    ) : (
                      <input
                        value={display(assertion.value ?? "")}
                        onChange={(e) =>
                          updateAssertion(item.id, index, {
                            value: parse(e.target.value),
                          })
                        }
                      />
                    )}
                    <button
                      className="small-icon"
                      title={t("Remove assertion")}
                      disabled={item.assertions.length <= 1}
                      onClick={() =>
                        updateCase(item.id, {
                          assertions: item.assertions.filter(
                            (_, assertionIndex) => assertionIndex !== index,
                          ),
                        })
                      }
                    >
                      <X size={12} />
                    </button>
                  </div>
                ))}
                <button
                  className="assertion-add"
                  onClick={() =>
                    updateCase(item.id, {
                      assertions: item.assertions.concat({
                        type: "contains",
                        value: "",
                      }),
                    })
                  }
                >
                  <Plus size={11} /> {t("Add assertion")}
                </button>
              </div>
              <button
                className="small-icon"
                onClick={() =>
                  setDraft((current) => ({
                    ...current,
                    cases: current.cases.filter(
                      (candidate) => candidate !== item,
                    ),
                  }))
                }
              >
                <Trash2 size={13} />
              </button>
            </div>
          ))}
        </div>
        <div className="modal-foot">
          {onDelete && (
            <button
              className="tool-button with-label danger"
              onClick={onDelete}
            >
              <Trash2 size={13} /> {t("Delete suite")}
            </button>
          )}
          <span className="tabs-spacer" />
          <button className="tool-button with-label" onClick={onClose}>
            {t("Cancel")}
          </button>
          <button
            className="tool-button with-label primary"
            disabled={
              !draft.name.trim() ||
              !draft.cases.length ||
              draft.cases.some((item) => !item.assertions.length) ||
              saving
            }
            onClick={onSave}
          >
            {saving ? (
              <LoaderCircle className="spin" size={13} />
            ) : (
              <Save size={13} />
            )}{" "}
            {t("Save suite")}
          </button>
        </div>
      </div>
    </div>
  );
}
