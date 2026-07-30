import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import {
  ReactFlow,
  ReactFlowProvider,
  Background,
  Controls,
  MiniMap,
  addEdge,
  applyEdgeChanges,
  useReactFlow,
  type Connection,
  type OnSelectionChangeParams,
} from "@xyflow/react";
import "@xyflow/react/dist/style.css";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import Editor from "@monaco-editor/react";
import {
  Activity,
  Archive,
  ArrowDownToLine,
  ArrowLeft,
  ArrowRight,
  ArrowUpRight,
  Blocks,
  BookOpen,
  Box,
  Braces,
  Check,
  CircleHelp,
  Clipboard,
  Code2,
  Copy,
  Download,
  FileArchive,
  FileCode2,
  FilePlus2,
  FolderOpen,
  GitBranch,
  History,
  LayoutDashboard,
  LoaderCircle,
  Maximize2,
  Menu,
  MoreHorizontal,
  PanelBottom,
  Play,
  Plus,
  Redo2,
  RotateCcw,
  Save,
  Scissors,
  Search,
  Settings2,
  ShieldCheck,
  Sparkles,
  Square,
  Terminal,
  Trash2,
  Undo2,
  Upload,
  X,
  Zap,
} from "lucide-react";
import { AgentNode } from "./components/AgentNode";
import { SettingsModal } from "./components/SettingsModal";
import { EdgeInspector } from "./components/EdgeInspector";
import { ProjectsModal } from "./components/ProjectsModal";
import { WorkspaceSwitcher } from "./components/WorkspaceSwitcher";
import { RunsView as PersistentRunsView } from "./components/RunsView";
import { VersionsView as PersistentVersionsView } from "./components/VersionsView";
import { EvaluationsView } from "./components/EvaluationsView";
import {
  ApiError,
  api,
  fromRunnerGraph,
  streamEvents,
  toRunnerGraph,
} from "./api/client";
import { categoryMeta, catalog, templates } from "./data/catalog";
import { useEditorStore } from "./store/editor";
import { usePreferencesStore } from "./store/preferences";
import {
  clearWorkspaceSession,
  readWorkspaceSession,
} from "./store/workspaceSession";
import type {
  AgentEdge,
  AgentNode as AgentNodeType,
  BottomTab,
  BlockCategory,
  BlockManifest,
  InspectorTab,
  TraceEvent,
} from "./types";
import "./styles.css";

const nodeTypes = { agent: AgentNode };
const categoryOrder: BlockCategory[] = [
  "input",
  "model",
  "control",
  "tool",
  "memory",
  "guardrail",
  "eval",
  "harness",
  "output",
];
const IconFor = ({ name, size = 14 }: { name: string; size?: number }) => {
  const map: Record<string, typeof Sparkles> = {
    message: Activity,
    sparkles: Zap,
    repeat: RotateCcw,
    "list-checks": Check,
    route: GitBranch,
    network: Blocks,
    database: Archive,
    globe: Activity,
    plug: Zap,
    "shield-check": ShieldCheck,
    scan: Search,
    activity: Activity,
    "minimize-2": Maximize2,
    "badge-check": Check,
    "arrow-up-right": ArrowRight,
  };
  const I = map[name] ?? Blocks;
  return <I size={size} />;
};

function App() {
  return (
    <ReactFlowProvider>
      <Workbench />
    </ReactFlowProvider>
  );
}

function Workbench() {
  const { t, i18n } = useTranslation();
  const rf = useReactFlow<AgentNodeType, AgentEdge>();
  const queryClient = useQueryClient();
  const [paletteSearch, setPaletteSearch] = useState("");
  const [showTemplates, setShowTemplates] = useState(false);
  const [showProjects, setShowProjects] = useState(false);
  const [showSettings, setShowSettings] = useState(false);
  const [mobileNotice, setMobileNotice] = useState(true);
  const [toast, setToast] = useState("");
  const [restoringWorkspace, setRestoringWorkspace] = useState(true);
  const fileInput = useRef<HTMLInputElement>(null);
  const blockInput = useRef<HTMLInputElement>(null);
  const [evaluationPrefill, setEvaluationPrefill] = useState<{
    baseline: string;
    candidate: string;
  } | null>(null);
  const nodes = useEditorStore((s) => s.nodes);
  const edges = useEditorStore((s) => s.edges);
  const selectedId = useEditorStore((s) => s.selectedNodeId);
  const selectedEdgeIds = useEditorStore((s) => s.selectedEdgeIds);
  const activeView = useEditorStore((s) => s.activeView);
  const inspectorTab = useEditorStore((s) => s.inspectorTab);
  const bottomTab = useEditorStore((s) => s.bottomTab);
  const input = useEditorStore((s) => s.input);
  const isRunning = useEditorStore((s) => s.isRunning);
  const trace = useEditorStore((s) => s.trace);
  const problems = useEditorStore((s) => s.problems);
  const runs = useEditorStore((s) => s.runs);
  const output = useEditorStore((s) => s.output);
  const setNodes = useEditorStore((s) => s.setNodes);
  const applyChanges = useEditorStore((s) => s.applyChanges);
  const setEdges = useEditorStore((s) => s.setEdges);
  const selectNode = useEditorStore((s) => s.selectNode);
  const selectEdges = useEditorStore((s) => s.selectEdges);
  const setEdgeRoute = useEditorStore((s) => s.setEdgeRoute);
  const pushHistory = useEditorStore((s) => s.pushHistory);
  const addBlock = useEditorStore((s) => s.addBlock);
  const loadTemplate = useEditorStore((s) => s.loadTemplate);
  const setInspectorTab = useEditorStore((s) => s.setInspectorTab);
  const setBottomTab = useEditorStore((s) => s.setBottomTab);
  const setInput = useEditorStore((s) => s.setInput);
  const setView = useEditorStore((s) => s.setView);
  const setWorkspaceIdentity = useEditorStore((s) => s.setWorkspaceIdentity);
  const hydrateWorkspace = useEditorStore((s) => s.hydrateWorkspace);
  const undo = useEditorStore((s) => s.undo);
  const redo = useEditorStore((s) => s.redo);
  const copy = useEditorStore((s) => s.copySelected);
  const cut = useEditorStore((s) => s.cutSelected);
  const paste = useEditorStore((s) => s.paste);
  const removeNodes = useEditorStore((s) => s.removeNodes);
  const deleteSelection = useEditorStore((s) => s.deleteSelection);
  const duplicate = useEditorStore((s) => s.duplicateSelected);
  const saveRevision = useEditorStore((s) => s.saveRevision);
  const setRunState = useEditorStore((s) => s.setRunState);
  const addTrace = useEditorStore((s) => s.addTrace);
  const setRunMetrics = useEditorStore((s) => s.setRunMetrics);
  const detachProject = useEditorStore((s) => s.detachProject);
  const finishRun = useEditorStore((s) => s.finishRun);
  const addProblem = useEditorStore((s) => s.addProblem);
  const resetRun = useEditorStore((s) => s.resetRun);
  const selected = nodes.find((n) => n.id === selectedId) ?? null;
  const singleSelectedEdge =
    !selected && selectedEdgeIds.length === 1
      ? edges.find((edge) => edge.id === selectedEdgeIds[0]) ?? null
      : null;
  const edgeSourceNode = singleSelectedEdge
    ? nodes.find((n) => n.id === singleSelectedEdge.source) ?? null
    : null;
  const projectName = useEditorStore((s) => s.projectName);
  const projectId = useEditorStore((s) => s.projectId);
  const revisionId = useEditorStore((s) => s.revisionId);
  const revisionSequence = useEditorStore((s) => s.revisionSequence);
  const dirty = useEditorStore((s) => s.dirty);
  const fontScale = usePreferencesStore((s) => s.fontScale);
  const { data: health } = useQuery({
    queryKey: ["health"],
    queryFn: api.health,
    retry: false,
    staleTime: 30_000,
  });
  const filteredCatalog = useMemo(
    () => catalog.filter((b) => `${b.name} ${b.description} ${b.category} ${t(b.name)} ${t(b.description)}`.toLowerCase().includes(paletteSearch.toLowerCase())),
    [i18n.language, paletteSearch, t],
  );
  const displayProjectName = templates.some((template) => template.name === projectName) ? t(projectName) : projectName;

  useEffect(() => {
    let cancelled = false;
    const restore = async () => {
      const session = readWorkspaceSession();
      if (!session) {
        setRestoringWorkspace(false);
        return;
      }
      try {
        const result = await api.getProject(session.projectId);
        if (!result.revision)
          throw new ApiError(404, "project has no revision");
        const graph = fromRunnerGraph(result.revision.graph);
        if (!cancelled) {
          hydrateWorkspace({
            projectId: result.project.id,
            projectName: result.project.name,
            revisionId: result.revision.id,
            revisionSequence: result.revision.sequence ?? 1,
            activeView: session.activeView,
            nodes: graph.nodes,
            edges: graph.edges,
          });
          for (const key of ["runs", "revisions", "eval-suites", "evaluations"])
            void queryClient.invalidateQueries({
              queryKey: [key, result.project.id],
            });
        }
      } catch (error) {
        if (error instanceof ApiError && error.status === 404)
          clearWorkspaceSession();
      } finally {
        if (!cancelled) setRestoringWorkspace(false);
      }
    };
    void restore();
    return () => {
      cancelled = true;
    };
  }, [hydrateWorkspace, queryClient]);

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      const target = event.target as HTMLElement | null;
      const editing =
        target?.matches('input, textarea, select, [contenteditable="true"]') ||
        Boolean(target?.closest(".monaco-editor"));
      if (editing) return;
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "z") {
        event.preventDefault();
        event.shiftKey ? redo() : undo();
      } else if (
        (event.metaKey || event.ctrlKey) &&
        event.key.toLowerCase() === "y"
      ) {
        event.preventDefault();
        redo();
      } else if (
        (event.metaKey || event.ctrlKey) &&
        event.key.toLowerCase() === "c"
      ) {
        copy();
      } else if (
        (event.metaKey || event.ctrlKey) &&
        event.key.toLowerCase() === "x"
      ) {
        cut();
      } else if (
        (event.metaKey || event.ctrlKey) &&
        event.key.toLowerCase() === "v"
      ) {
        paste();
      } else if (event.key === "Delete" || event.key === "Backspace") {
        event.preventDefault();
        deleteSelection();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [copy, cut, deleteSelection, paste, redo, undo]);

  const onDrop = useCallback(
    (event: React.DragEvent) => {
      event.preventDefault();
      const manifestId = event.dataTransfer.getData(
        "application/agentlab-block",
      );
      if (!manifestId) return;
      addBlock(
        manifestId,
        rf.screenToFlowPosition({ x: event.clientX, y: event.clientY }),
      );
    },
    [addBlock, rf],
  );
  const onConnect = useCallback(
    (connection: Connection) => {
      pushHistory();
      setEdges(
        addEdge(
          { ...connection, type: "smoothstep", interactionWidth: 20 },
          edges,
        ),
      );
    },
    [edges, pushHistory, setEdges],
  );
  const onSelectionChange = useCallback(
    (params: OnSelectionChangeParams<AgentNodeType, AgentEdge>) => {
      selectNode(params.nodes[0]?.id ?? null);
      selectEdges(params.edges.map((edge) => edge.id));
    },
    [selectEdges, selectNode],
  );
  const onDragStop = useCallback(() => pushHistory(), [pushHistory]);
  const onNodesDelete = useCallback(
    (deleted: AgentNodeType[]) => removeNodes(deleted.map((n) => n.id)),
    [removeNodes],
  );

  const validate = async (): Promise<boolean> => {
    resetRun();
    setBottomTab("problems");
    try {
      const result = await api.validate({ nodes, edges });
      if (!result.valid) {
        (result.problems ?? [t("Graph has validation errors.")]).forEach(
          addProblem,
        );
        return false;
      }
      setToast(t("Graph is valid"));
      return true;
    } catch {
      const errors =
        nodes.length < 2
          ? [t("Add at least an input and an output block.")]
          : edges.length === 0
            ? [t("Connect blocks before running.")]
            : [];
      errors.forEach(addProblem);
      if (!errors.length) {
        setToast(t("Local validation passed"));
        return true;
      }
      return false;
    }
  };
  const persistProject = async () => {
    const graph = toRunnerGraph(nodes, edges);
    const saved =
      projectId !== "proj-local"
        ? await api.updateProject(projectId, projectName, graph)
        : await api.createProject(projectName, graph);
    setWorkspaceIdentity(
      saved.project.id,
      saved.revision.id,
      saved.revision.sequence ?? revisionSequence + 1,
    );
    void queryClient.invalidateQueries({
      queryKey: ["revisions", saved.project.id],
    });
    void queryClient.invalidateQueries({ queryKey: ["projects"] });
    const credentialWarnings = saved.credential_warnings ?? [];
    credentialWarnings.forEach(addProblem);
    return { projectId: saved.project.id, revisionId: saved.revision.id, credentialWarnings };
  };
  const openProject = async (id: string) => {
    if (
      id !== projectId &&
      dirty &&
      !window.confirm(t("Discard unsaved changes and open this project?"))
    )
      return;
    try {
      const result = await api.getProject(id);
      if (!result.revision) throw new ApiError(404, "project has no revision");
      const graph = fromRunnerGraph(result.revision.graph);
      hydrateWorkspace({
        projectId: result.project.id,
        projectName: result.project.name,
        revisionId: result.revision.id,
        revisionSequence: result.revision.sequence ?? 1,
        activeView: "design",
        nodes: graph.nodes,
        edges: graph.edges,
      });
      for (const key of ["runs", "revisions", "eval-suites", "evaluations"])
        void queryClient.invalidateQueries({
          queryKey: [key, result.project.id],
        });
      setShowProjects(false);
      setToast(t("Project opened"));
    } catch {
      setToast(t("Could not open project"));
    }
  };
  const openRevision = async (id: string) => {
    if (id === revisionId) return;
    if (
      dirty &&
      !window.confirm(t("Discard unsaved changes and load this revision?"))
    )
      return;
    try {
      const revision = await api.getRevision(projectId, id);
      const graph = fromRunnerGraph(revision.graph);
      hydrateWorkspace({
        projectId,
        projectName,
        revisionId: revision.id,
        revisionSequence: revision.sequence ?? 1,
        activeView: "design",
        nodes: graph.nodes,
        edges: graph.edges,
      });
      setToast(t("Revision loaded; save to keep it as a new version"));
    } catch {
      setToast(t("Could not load revision"));
    }
  };
  const run = async () => {
    if (!(await validate())) return;
    setBottomTab("trace");
    setRunState(true, `local-${Date.now()}`);
    const runId = useEditorStore.getState().runId!;
    const started = Date.now();
    try {
      const saved = await persistProject();
      const remote = await api.createRun({
        project_id: saved.projectId,
        revision_id: saved.revisionId,
        input,
      });
      setRunState(true, remote.id);
      let finalOutput = t("Remote run completed.");
      let failed = false;
      streamEvents(
        remote.id,
        (event) => {
          addTrace(event);
          if (event.output !== undefined)
            finalOutput = JSON.stringify(event.output, null, 2);
          if (event.status === "error") failed = true;
          if (
            event.type === "output" &&
            (event.tokens !== undefined ||
              event.durationMs !== undefined ||
              event.costUsd !== undefined)
          )
            setRunMetrics({
              tokens: event.tokens,
              durationMs: event.durationMs,
              costUsd: event.costUsd,
            });
          if (event.nodeId)
            useEditorStore
              .getState()
              .updateNodeData(event.nodeId, {
                status:
                  event.status === "error"
                    ? "error"
                    : event.status === "success"
                      ? "success"
                      : "running",
              });
        },
        (status) =>
          finishRun(
            status === "failed" || failed ? "failed" : "success",
            status === "failed"
              ? t("Runner event stream failed. Inspect the run record before retrying.")
              : finalOutput,
          ),
      );
      return;
    } catch (error) {
      if (health) {
        const message =
          error instanceof Error ? error.message : t("Remote run failed");
        addProblem(message);
        finishRun("failed", message);
        return;
      }
    }
    for (const n of nodes) {
      addTrace({
        id: `${runId}-${n.id}`,
        timestamp: new Date().toISOString(),
        nodeId: n.id,
        nodeName: n.data.label,
        type: "lifecycle",
        status: "running",
        message: `Executing ${n.data.label}`,
      });
      useEditorStore.getState().updateNodeData(n.id, { status: "running" });
      await new Promise((r) => setTimeout(r, 260));
      addTrace({
        id: `${runId}-${n.id}-done`,
        timestamp: new Date().toISOString(),
        nodeId: n.id,
        nodeName: n.data.label,
        type: n.data.category === "tool" ? "tool" : "lifecycle",
        status: "success",
        message: `${n.data.label} completed`,
        durationMs: Date.now() - started,
      });
      useEditorStore.getState().updateNodeData(n.id, { status: "success" });
    }
    finishRun(
      "success",
      t("Local simulation completed. Connect a runner for live model calls."),
    );
  };
  const stop = () => {
    const id = useEditorStore.getState().runId;
    if (id && !id.startsWith("local-"))
      void api.cancelRun(id).catch(() => undefined);
    setRunState(false);
    addTrace({
      id: `stop-${Date.now()}`,
      timestamp: new Date().toISOString(),
      type: "error",
      status: "error",
      message: t("Run cancelled by user."),
    });
    finishRun("cancelled");
  };
  const save = async () => {
    try {
      const saved = await persistProject();
      setToast(
        saved.credentialWarnings.length
          ? t("Saved with credential warnings; check Problems")
          : t("Revision saved"),
      );
    } catch {
      saveRevision();
      setToast(t("Saved locally; runner unavailable"));
    }
  };
  const exportFile = async (codeExport = false) => {
    try {
      const saved = await persistProject();
      let response = await (codeExport
        ? api.codeExport(saved.projectId)
        : api.exportProject(saved.projectId));
      if (response.status === 422) {
        const detail = (await response.json().catch(() => null)) as {
          detail?: { findings?: Array<{ path: string; kind: string }> };
        } | null;
        const summary = (detail?.detail?.findings ?? [])
          .slice(0, 5)
          .map((finding) => `${finding.kind}: ${finding.path}`)
          .join("\n");
        if (
          !window.confirm(
            `${t("Export blocked: credential-like data found")}\n${summary}\n\n${t("Export anyway?")}`,
          )
        ) {
          setToast(t("Export cancelled"));
          return;
        }
        response = await (codeExport
          ? api.codeExport(saved.projectId, true)
          : api.exportProject(saved.projectId, true));
      }
      if (!response.ok) throw new Error("export failed");
      const blob = await response.blob();
      const a = document.createElement("a");
      a.href = URL.createObjectURL(blob);
      a.download = codeExport
        ? "agent-runtime.zip"
        : "agentlab-project.agentlab.zip";
      a.click();
      URL.revokeObjectURL(a.href);
      setToast(t("Export downloaded"));
    } catch {
      const payload = JSON.stringify(
        { project: projectName, nodes, edges },
        null,
        2,
      );
      const a = document.createElement("a");
      a.href = URL.createObjectURL(
        new Blob([payload], { type: "application/json" }),
      );
      a.download = "agentlab-project.json";
      a.click();
      setToast(t("Saved local project JSON"));
    }
  };
  const importFile = async (event: React.ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0];
    if (!file) return;
    try {
      const result = await api.importProject(file);
      const graph = fromRunnerGraph(result.revision.graph);
      hydrateWorkspace({ projectId: result.project.id, projectName: result.project.name, revisionId: result.revision.id, revisionSequence: result.revision.sequence ?? 1, activeView: "design", nodes: graph.nodes, edges: graph.edges });
      setToast(t("Project imported"));
      void queryClient.invalidateQueries({
        queryKey: ["revisions", result.project.id],
      });
    } catch {
      setToast(t("Import failed"));
    }
    event.target.value = "";
  };
  const importBlock = async (event: React.ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0];
    if (!file) return;
    try {
      const result = await api.importPython(file);
      const entrypoint = result.functions[0]?.name ?? result.classes[0];
      if (!entrypoint) throw new Error("No callable entrypoint found");
      const id = `custom-${Date.now()}`;
      pushHistory();
      setNodes(
        nodes.concat({
          id,
          type: "agent",
          position: { x: 180 + nodes.length * 18, y: 180 + nodes.length * 12 },
          data: {
            label: entrypoint,
            manifestId: result.source,
            category: "tool",
            description: `Imported from ${result.filename}`,
            color: "#3aa4cc",
            icon: "plug",
            code: result.code,
            originalCode: result.code,
            isOverride: true,
            config: { entrypoint, sha256: result.sha256, timeout_seconds: 30 },
            source: result.source,
            version: "1.0.0",
            inputPorts:
              result.functions[0]?.parameters.map((p) => ({
                id: p.name,
                label: p.name,
                type: p.type,
              })) ?? [],
            outputPorts: [
              {
                id: "result",
                label: "result",
                type: result.functions[0]?.returns ?? "any",
              },
            ],
          },
        }),
      );
      setToast(
        result.safe_to_execute
          ? t("Python block imported")
          : t("Imported; Docker/Podman required to run"),
      );
    } catch {
      setToast(t("Python import failed"));
    }
    event.target.value = "";
  };

  if (restoringWorkspace)
    return (
      <div className="workspace-restoring">
        <LoaderCircle className="spin" size={18} /> {t("Restoring workspace")}
      </div>
    );
  return (
    <div
      className="app-shell"
      data-ui-font={fontScale}
      style={{ "--ui-font-scale": fontScale / 100 } as React.CSSProperties}
    >
      <header className="topbar">
        <div className="brand">
          <div className="brand-mark">
            <Zap size={16} fill="currentColor" />
          </div>
          <div>
            <strong>AGENT LAB</strong>
              <span>{t("design validation workspace")}</span>
          </div>
        </div>
        <div className="project-switcher-wrap">
          <WorkspaceSwitcher
            projectId={projectId}
            projectName={displayProjectName}
            revisionId={revisionId}
            revisionSequence={revisionSequence}
            onOpenProject={(id) => void openProject(id)}
            onOpenRevision={(id) => void openRevision(id)}
            onManageProjects={() => setShowProjects(true)}
          />
        </div>
        <div className="top-actions">
          <span className={`connection ${health ? "online" : ""}`}>
            <span className="connection-dot" />{" "}
            {t(health ? "Runner online" : "Local mode")}
          </span>
          <button className="icon-button" title={t("Help")}>
            <CircleHelp size={16} />
          </button>
          <button
            className="icon-button"
            title={t("Settings")}
            onClick={() => setShowSettings(true)}
          >
            <Settings2 size={16} />
          </button>
          <div className="avatar">DL</div>
        </div>
      </header>
      <div className="body-grid">
        <aside className="rail">
          <button className="rail-button active" title={t("Workspace")}>
            <LayoutDashboard size={18} />
          </button>
          <button
            className="rail-button"
            title={t("Projects")}
            onClick={() => setShowProjects(true)}
          >
            <FolderOpen size={18} />
          </button>
          <button
            className="rail-button"
            title={t("Templates")}
            onClick={() => setShowTemplates(true)}
          >
            <Blocks size={18} />
          </button>
          <div className="rail-spacer" />
          <button className="rail-button" title={t("Documentation")}>
            <BookOpen size={18} />
          </button>
        </aside>
        <aside className="left-panel">
          <div className="panel-header">
            <div>
              <div className="eyebrow">{t("BUILD")}</div>
              <h2>{t("Blocks")}</h2>
            </div>
            <button
              className="small-icon"
              title={t("Import Python block")}
              onClick={() => blockInput.current?.click()}
            >
              <Plus size={15} />
            </button>
            <input
              ref={blockInput}
              type="file"
              accept=".py"
              hidden
              onChange={importBlock}
            />
          </div>
          <button
            className="template-button"
            onClick={() => setShowTemplates(true)}
          >
            <span className="template-glyph">
              <Box size={15} />
            </span>
            <span>
                <strong>{t("Start from template")}</strong>
                <small>{t("Choose a tested topology")}</small>
            </span>
            <ArrowRight size={14} />
          </button>
          <div className="search-field">
            <Search size={14} />
            <input
              value={paletteSearch}
              onChange={(e) => setPaletteSearch(e.target.value)}
              placeholder={t("Search blocks")}
            />
            <kbd>/</kbd>
          </div>
          <div className="palette-scroll">
            {categoryOrder.map((category) => {
              const blocks = filteredCatalog.filter(
                (b) => b.category === category,
              );
              if (!blocks.length) return null;
              return (
                <div className="palette-group" key={category}>
                  <div className="group-label">
                    <span
                      className="category-dot"
                      style={{ background: categoryMeta[category].color }}
                    />
                    {t(categoryMeta[category].label)}
                    <span className="count">{blocks.length}</span>
                  </div>
                  {blocks.map((block) => (
                    <PaletteItem
                      key={block.id}
                      block={block}
                      onDragStart={(event) =>
                        event.dataTransfer.setData(
                          "application/agentlab-block",
                          block.id,
                        )
                      }
                      onClick={() =>
                        addBlock(block.id, {
                          x: 160 + nodes.length * 24,
                          y: 180 + nodes.length * 12,
                        })
                      }
                    />
                  ))}
                </div>
              );
            })}
          </div>
          <div className="left-footer">
            <button
              className="footer-link"
              onClick={() => setShowTemplates(true)}
            >
              <Archive size={14} /> {t("Template library")} <span>⌘K</span>
            </button>
            <button
              className="footer-link"
              onClick={() => blockInput.current?.click()}
            >
              <FilePlus2 size={14} /> {t("Import Python block")} <span>↗</span>
            </button>
          </div>
        </aside>
        <main className="main-area">
          <div className="workspace-tabs">
            <button
              className={activeView === "design" ? "active" : ""}
              onClick={() => setView("design")}
            >
              <Blocks size={14} /> {t("Design")}
            </button>
            <button
              className={activeView === "runs" ? "active" : ""}
              onClick={() => setView("runs")}
            >
              <Activity size={14} /> {t("Runs")}{" "}
              <span className="tab-count">{runs.length || ""}</span>
            </button>
            <button
              className={activeView === "evaluations" ? "active" : ""}
              onClick={() => setView("evaluations")}
            >
              <ShieldCheck size={14} /> {t("Evaluations")}
            </button>
            <button
              className={activeView === "versions" ? "active" : ""}
              onClick={() => setView("versions")}
            >
              <History size={14} /> {t("Versions")}
            </button>
            <div className="tabs-spacer" />
            <span className="save-state">
              {t(dirty ? "Unsaved changes" : "All changes saved")}
            </span>
          </div>
          {activeView === "design" ? (
            <>
              <div className="toolbar">
                <div className="toolbar-group">
                  <button className="tool-button" title={t("Undo")} onClick={undo}>
                    <Undo2 size={15} />
                  </button>
                  <button className="tool-button" title={t("Redo")} onClick={redo}>
                    <Redo2 size={15} />
                  </button>
                  <i />
                </div>
                <div className="toolbar-group">
                  <button className="tool-button" title={t("Cut")} onClick={cut}>
                    <Scissors size={15} />
                  </button>
                  <button className="tool-button" title={t("Copy")} onClick={copy}>
                    <Copy size={15} />
                  </button>
                  <button className="tool-button" title={t("Paste")} onClick={paste}>
                    <Clipboard size={15} />
                  </button>
                  <button
                    className="tool-button"
                    title={t("Duplicate")}
                    onClick={duplicate}
                  >
                    <FilePlus2 size={15} />
                  </button>
                  <button
                    className="tool-button"
                    title={t("Delete")}
                    onClick={() =>
                      removeNodes(
                        nodes.filter((n) => n.selected).map((n) => n.id),
                      )
                    }
                  >
                    <Trash2 size={15} />
                  </button>
                </div>
                <div className="toolbar-group">
                  <button className="tool-button with-label" onClick={validate}>
                    <ShieldCheck size={15} /> {t("Validate")}
                  </button>
                  <button
                    className="tool-button with-label primary"
                    onClick={isRunning ? stop : run}
                  >
                    {isRunning ? (
                      <>
                        <Square size={13} fill="currentColor" /> {t("Stop")}
                      </>
                    ) : (
                      <>
                        <Play size={14} fill="currentColor" /> {t("Run")}
                      </>
                    )}
                  </button>
                </div>
                <div className="toolbar-spacer" />
                <div className="toolbar-group">
                  <button className="tool-button with-label" onClick={save}>
                    <Save size={14} /> {t("Save")}
                  </button>
                  <button
                    className="tool-button"
                    title={t("Import project")}
                    onClick={() => fileInput.current?.click()}
                  >
                    <Upload size={15} />
                  </button>
                  <input
                    ref={fileInput}
                    type="file"
                    accept=".zip,.json,.agentlab"
                    hidden
                    onChange={importFile}
                  />
                  <button
                    className="tool-button"
                    title={t("Export project")}
                    onClick={() => exportFile(false)}
                  >
                    <Download size={15} />
                  </button>
                  <button
                    className="tool-button"
                    title={t("Export code")}
                    onClick={() => exportFile(true)}
                  >
                    <FileCode2 size={15} />
                  </button>
                </div>
              </div>
              <div className="editor-workspace">
                <div
                  className="canvas-wrap"
                  onDrop={onDrop}
                  onDragOver={(e) => e.preventDefault()}
                >
                  <ReactFlow<AgentNodeType, AgentEdge>
                    nodes={nodes}
                    edges={edges}
                    nodeTypes={nodeTypes}
                    fitView
                    fitViewOptions={{ padding: 0.25 }}
                    onNodesChange={applyChanges}
                    onEdgesChange={(changes) =>
                      setEdges(applyEdgeChanges(changes, edges))
                    }
                    onConnect={onConnect}
                    onSelectionChange={onSelectionChange}
                    onNodeDragStop={onDragStop}
                    onNodesDelete={onNodesDelete}
                    deleteKeyCode={null}
                    proOptions={{ hideAttribution: true }}
                    minZoom={0.2}
                    maxZoom={1.5}
                  >
                    <Background color="#d9dde3" gap={20} size={1} />
                    <Controls showInteractive={false} />
                    <MiniMap
                      nodeColor={(n) => (n.data as AgentNodeType["data"]).color}
                      maskColor="rgba(242,244,247,.8)"
                    />
                  </ReactFlow>
                  <div className="canvas-label">
                    <span className="live-dot" /> {t("Design canvas")} <span>•</span>{" "}
                    {nodes.length} {t("blocks")} <span>•</span> {edges.length}{" "}
                    {t("connections")}
                  </div>
                  <div className="canvas-hint">
                    <span>⌘</span> {t("drag to pan")} <span>·</span> {t("scroll to zoom")}
                  </div>
                </div>
                {selected ? (
                  <Inspector selected={selected} />
                ) : singleSelectedEdge ? (
                  <EdgeInspector
                    edge={singleSelectedEdge}
                    sourceNode={edgeSourceNode}
                    onSetRoute={(route) =>
                      setEdgeRoute(singleSelectedEdge.id, route)
                    }
                  />
                ) : (
                  <Inspector selected={null} />
                )}
              </div>
              <BottomPanel />
            </>
          ) : activeView === "runs" ? (
            <PersistentRunsView projectId={projectId} localRuns={runs} />
          ) : activeView === "evaluations" ? (
            <EvaluationsView
              projectId={projectId}
              prefill={evaluationPrefill}
              onPrefillConsumed={() => setEvaluationPrefill(null)}
            />
          ) : (
            <PersistentVersionsView
              projectId={projectId}
              activeRevisionId={revisionId}
              onEvaluate={(baseline, candidate) => {
                setEvaluationPrefill({ baseline, candidate });
                setView("evaluations");
              }}
            />
          )}
        </main>
      </div>
      {showTemplates && (
        <TemplateModal
          onClose={() => setShowTemplates(false)}
          onPick={(template) => {
            loadTemplate(template);
            setShowTemplates(false);
          }}
        />
      )}
      {showProjects && (
        <ProjectsModal
          currentProjectId={projectId}
          onClose={() => setShowProjects(false)}
          onOpen={(id) => void openProject(id)}
          onNew={() => {
            setShowProjects(false);
            setShowTemplates(true);
          }}
          onDeleted={(id) => {
            if (id === projectId) detachProject();
          }}
        />
      )}
      {showSettings && <SettingsModal onClose={() => setShowSettings(false)} />}
      {toast && (
        <button className="toast" onClick={() => setToast("")}>
          {toast}
          <X size={13} />
        </button>
      )}
      {mobileNotice && (
        <div className="mobile-notice">
          <div className="notice-icon">
            <Maximize2 size={18} />
          </div>
          <div>
            <strong>{t("Use a larger viewport to edit")}</strong>
            <p>{t("Agent Lab's canvas is optimized for 1280px and above. You can still inspect runs on mobile.")}</p>
          </div>
          <button onClick={() => setMobileNotice(false)}>
            <X size={15} />
          </button>
        </div>
      )}
    </div>
  );
}

function PaletteItem({
  block,
  onDragStart,
  onClick,
}: {
  block: BlockManifest;
  onDragStart: (event: React.DragEvent) => void;
  onClick: () => void;
}) {
  const { t } = useTranslation();
  return (
    <button
      className="palette-item"
      draggable
      onDragStart={onDragStart}
      onClick={onClick}
    >
      <span
        className="palette-icon"
        style={{ color: block.color, background: `${block.color}18` }}
      >
        <IconFor name={block.icon} />
      </span>
      <span className="palette-copy">
        <strong>{t(block.name)}</strong>
        <small>{t(block.description)}</small>
      </span>
      <MoreHorizontal size={13} className="palette-more" />
    </button>
  );
}

function Inspector({ selected }: { selected: AgentNodeType | null }) {
  const { t } = useTranslation();
  const tab = useEditorStore((s) => s.inspectorTab);
  const setTab = useEditorStore((s) => s.setInspectorTab);
  const update = useEditorStore((s) => s.updateNodeData);
  const [code, setCode] = useState(selected?.data.code ?? "");
  useEffect(
    () => setCode(selected?.data.code ?? ""),
    [selected?.id, selected?.data.code],
  );
  if (!selected)
    return (
      <aside className="inspector empty-inspector">
        <div className="empty-state">
          <div className="empty-illustration">
            <Blocks size={24} />
          </div>
          <strong>{t("Select a block")}</strong>
          <p>{t("Configure its inputs, edit instance code, or inspect ports and docs.")}</p>
        </div>
      </aside>
    );
  const data = selected.data;
  const manifest = catalog.find((b) => b.id === data.manifestId);
  const displayLabel = manifest && data.label === manifest.name ? t(manifest.name) : data.label;
  const updateCode = (value = "") => {
    setCode(value);
    update(selected.id, {
      code: value,
      isOverride: value !== data.originalCode,
    });
  };
  return (
    <aside className="inspector">
      <div className="inspector-heading">
        <div className="inspector-title">
          <span
            className="inspector-icon"
            style={{ color: data.color, background: `${data.color}1a` }}
          >
            <IconFor name={data.icon} />
          </span>
          <div>
            <strong>{displayLabel}</strong>
            <small>
              {data.manifestId} · v
              {manifest?.version ?? data.version ?? "1.0.0"}
            </small>
          </div>
        </div>
        <button className="small-icon">
          <MoreHorizontal size={15} />
        </button>
      </div>
      <div className="inspector-tabs">
        {(["config", "code", "ports", "docs"] as InspectorTab[]).map((item) => (
          <button
            key={item}
            className={tab === item ? "active" : ""}
            onClick={() => setTab(item)}
          >
            {t(item === "config" ? "Config" : item === "code" ? "Code" : item === "ports" ? "Ports" : "Docs")}
          </button>
        ))}
      </div>
      {tab === "config" && <ConfigPanel node={selected} />}
      {tab === "code" && (
        <div className="code-panel">
          <div className="code-status">
            <span
              className={data.isOverride ? "override-badge" : "catalog-badge"}
            >
              {t(data.isOverride ? "INSTANCE OVERRIDE" : "CATALOG CODE")}
            </span>
            <button
              className="reset-code"
              disabled={!data.isOverride || data.source?.startsWith("custom:")}
              onClick={() => updateCode(data.originalCode)}
            >
              {t("Reset")}
            </button>
          </div>
          <div className="code-editor-host">
            <Editor
              height="100%"
              language="python"
              theme="vs-dark"
              value={code}
              onChange={updateCode}
              options={{
                minimap: { enabled: false },
                fontSize: 12,
                lineNumbers: "on",
                padding: { top: 12 },
                scrollBeyondLastLine: false,
                wordWrap: "on",
              }}
            />
          </div>
        </div>
      )}
      {tab === "ports" && <PortsPanel node={selected} />}
      {tab === "docs" && <DocsPanel node={selected} />}
    </aside>
  );
}

const displayConfigValue = (value: unknown) =>
  typeof value === "string" ? value : JSON.stringify(value);
const parseConfigValue = (original: unknown, value: string): unknown => {
  if (typeof original === "number") {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : original;
  }
  if (typeof original === "boolean")
    return value.trim().toLowerCase() === "true";
  if (
    Array.isArray(original) ||
    (original !== null && typeof original === "object")
  ) {
    try {
      return JSON.parse(value);
    } catch {
      return original;
    }
  }
  return value;
};
function ConfigPanel({ node }: { node: AgentNodeType }) {
  const { t } = useTranslation();
  const update = useEditorStore((s) => s.updateNodeData);
  const entries = Object.entries(node.data.config);
  const manifest = catalog.find((item) => item.id === node.data.manifestId);
  const displayLabel = manifest && node.data.label === manifest.name ? t(manifest.name) : node.data.label;
  const displayDescription = manifest && node.data.description === manifest.description ? t(manifest.description) : node.data.description;
  return (
    <div className="config-panel">
      <div className="field">
        <label>{t("Display name")}</label>
        <input
          value={displayLabel}
          onChange={(e) => update(node.id, { label: e.target.value })}
        />
      </div>
      <div className="field">
        <label>{t("Block description")}</label>
        <textarea
          rows={3}
          value={displayDescription}
          onChange={(e) => update(node.id, { description: e.target.value })}
        />
      </div>
      <div className="section-label">{t("Runtime config")}</div>
      {entries.length ? (
        entries.map(([key, value]) => (
          <div className="field" key={`${node.id}-${key}`}>
            <label>{key.replaceAll("_", " ")}</label>
            <input
              defaultValue={displayConfigValue(value)}
              onBlur={(e) =>
                update(node.id, {
                  config: {
                    ...node.data.config,
                    [key]: parseConfigValue(value, e.target.value),
                  },
                })
              }
            />
          </div>
        ))
      ) : (
        <div className="empty-field">
          {t("This block has no custom configuration.")}
        </div>
      )}
      <div className="permission-box">
        <ShieldCheck size={14} />
        <div>
          <strong>{t("Sandbox policy")}</strong>
          <span>
            {catalog
              .find((b) => b.id === node.data.manifestId)
              ?.permissions?.join(", ") ?? t("No elevated permissions")}
          </span>
        </div>
      </div>
    </div>
  );
}
function PortsPanel({ node }: { node: AgentNodeType }) {
  const { t } = useTranslation();
  const b = catalog.find((x) => x.id === node.data.manifestId);
  return (
    <div className="ports-panel">
      <PortList
        title={t("Inputs")}
        ports={b?.inputPorts ?? node.data.inputPorts ?? []}
      />
      <PortList
        title={t("Outputs")}
        ports={b?.outputPorts ?? node.data.outputPorts ?? []}
      />
    </div>
  );
}
function PortList({
  title,
  ports,
}: {
  title: string;
  ports: Array<{ id: string; label: string; type: string; required?: boolean }>;
}) {
  const { t } = useTranslation();
  return (
    <div className="port-section">
      <div className="section-label">
        {title}
        <span>{ports.length}</span>
      </div>
      {ports.length ? (
        ports.map((p) => (
          <div className="port-row" key={p.id}>
            <span className="port-name">
              {p.label}
              {p.required && <b>*</b>}
            </span>
            <code>{p.type}</code>
          </div>
        ))
      ) : (
        <div className="empty-field">{t("No ports exposed.")}</div>
      )}
    </div>
  );
}
function DocsPanel({ node }: { node: AgentNodeType }) {
  const { t } = useTranslation();
  const b = catalog.find((x) => x.id === node.data.manifestId);
  const docs = b?.id.startsWith("harness.") ? `${t(b.description)}. ${t("Compatible lifecycle")}: ${b.capabilities?.[1] ?? "—"}. ${t("Platform sandbox and secret protection remain outside removable blocks.")}` : b ? t(b.docs) : `Local Python source snapshot. Entrypoint: ${String(node.data.config.entrypoint ?? t("not selected"))}.`;
  return (
    <div className="docs-panel">
      <div className="docs-callout">
        <BookOpen size={15} />
        <span>{t(b ? "Catalog reference" : "Imported block")}</span>
      </div>
      <p>{docs}</p>
      <div className="section-label">{t("Capabilities")}</div>
      <div className="chip-row">
        {(b?.capabilities ?? ["typed ports", "container execution"]).map(
          (x) => (
            <span className="chip" key={x}>
              {t(x)}
            </span>
          ),
        )}
      </div>
    </div>
  );
}

function BottomPanel() {
  const { t, i18n } = useTranslation();
  const tab = useEditorStore((s) => s.bottomTab);
  const setTab = useEditorStore((s) => s.setBottomTab);
  const trace = useEditorStore((s) => s.trace);
  const runMetrics = useEditorStore((s) => s.runMetrics);
  const lines = useEditorStore((s) => s.consoleLines);
  const input = useEditorStore((s) => s.input);
  const setInput = useEditorStore((s) => s.setInput);
  const output = useEditorStore((s) => s.output);
  const problems = useEditorStore((s) => s.problems);
  const select = useEditorStore((s) => s.selectNode);
  return (
    <section className="bottom-panel">
      <div className="bottom-tabs">
        {(["console", "trace", "io", "metrics", "problems"] as BottomTab[]).map(
          (item) => (
            <button
              key={item}
              className={tab === item ? "active" : ""}
              onClick={() => setTab(item)}
            >
              {item === "console" ? (
                <Terminal size={13} />
              ) : item === "trace" ? (
                <Activity size={13} />
              ) : item === "io" ? (
                <Braces size={13} />
              ) : item === "metrics" ? (
                <Zap size={13} />
              ) : (
                <ShieldCheck size={13} />
              )}
              {t(item === "io" ? "Io" : item[0].toUpperCase() + item.slice(1))}
              {item === "problems" && problems.length > 0 && (
                <span className="problem-count">{problems.length}</span>
              )}
            </button>
          ),
        )}
        <div className="tabs-spacer" />
        <button className="small-icon">
          <Maximize2 size={14} />
        </button>
      </div>
      <div className="bottom-content">
        {tab === "console" && (
          <div className="console-lines">
            {lines.map((line, i) => (
              <div key={i}>
                <span>{String(i + 1).padStart(2, "0")}</span>
                {line}
              </div>
            ))}
          </div>
        )}
        {tab === "trace" && (
          <div className="trace-list">
            {trace.length ? (
              trace.map((event) => (
                <button
                  className={`trace-row ${event.status}`}
                  key={event.id}
                  onClick={() => event.nodeId && select(event.nodeId)}
                >
                  <span className="trace-time">
                    {new Date(event.timestamp).toLocaleTimeString(i18n.language, {
                      hour: "2-digit",
                      minute: "2-digit",
                      second: "2-digit",
                    })}
                  </span>
                  <span className="trace-status" />
                  <span className="trace-node">
                    {event.nodeName ?? event.type}
                  </span>
                  <span
                    className="trace-message"
                    title={event.detail ?? event.message}
                  >
                    {event.detail ?? event.message}
                  </span>
                  <span className="trace-duration">
                    {event.durationMs ? `${event.durationMs}ms` : ""}
                  </span>
                </button>
              ))
            ) : (
              <EmptyBottom
                icon={<Activity size={18} />}
                title={t("No trace events yet")}
                copy={t("Run the graph to inspect each lifecycle span.")}
              />
            )}
          </div>
        )}
        {tab === "io" && (
          <div className="io-grid">
            <div>
              <div className="section-label">{t("Input")}</div>
              <textarea
                className="io-input"
                value={input}
                onChange={(event) => setInput(event.target.value)}
              />
            </div>
            <div>
              <div className="section-label">{t("Output")}</div>
              <pre>{output || t("No output yet.")}</pre>
            </div>
          </div>
        )}
        {tab === "metrics" && (
          <div className="metrics-grid">
            <Metric
              label={t("Total tokens")}
              value={
                runMetrics?.tokens ??
                (trace.reduce((sum, e) => sum + (e.tokens ?? 0), 0) || "—")
              }
            />
            <Metric
              label={t("Wall time")}
              value={
                runMetrics?.durationMs != null
                  ? `${runMetrics.durationMs}ms`
                  : trace.length
                    ? `${trace.reduce((sum, e) => sum + (e.durationMs ?? 0), 0)}ms`
                    : "—"
              }
            />
            <Metric
              label={t("Cost")}
              value={
                runMetrics?.costUsd != null
                  ? `$${runMetrics.costUsd.toFixed(4)}`
                  : "—"
              }
            />
            <Metric
              label={t("Tool calls")}
              value={trace.filter((e) => e.type === "tool").length || "—"}
            />
          </div>
        )}
        {tab === "problems" && (
          <div className="problems-list">
            {problems.length ? (
              problems.map((problem, i) => (
                <div key={i} className="problem-row">
                  <ShieldCheck size={14} />
                  {problem}
                </div>
              ))
            ) : (
              <EmptyBottom
                icon={<Check size={18} />}
                title={t("No problems")}
                copy={t("Validation issues will appear here.")}
              />
            )}
          </div>
        )}
      </div>
    </section>
  );
}
function Metric({ label, value }: { label: string; value: string | number }) {
  return (
    <div className="metric">
      <span>{label}</span>
      <strong>{value}</strong>
    </div>
  );
}
function EmptyBottom({
  icon,
  title,
  copy,
}: {
  icon: React.ReactNode;
  title: string;
  copy: string;
}) {
  return (
    <div className="empty-bottom">
      <div>{icon}</div>
      <strong>{title}</strong>
      <span>{copy}</span>
    </div>
  );
}

function TemplateModal({
  onClose,
  onPick,
}: {
  onClose: () => void;
  onPick: (template: (typeof templates)[number]) => void;
}) {
  const { t } = useTranslation();
  const [search, setSearch] = useState("");
  const matches = templates.filter((template) =>
    `${template.name} ${template.mode} ${template.tags.join(" ")} ${t(template.name)} ${t(template.description)}`
      .toLowerCase()
      .includes(search.toLowerCase()),
  );
  return (
    <div className="modal-backdrop" onMouseDown={onClose}>
      <div className="template-modal" onMouseDown={(e) => e.stopPropagation()}>
        <div className="modal-head">
          <div>
            <div className="eyebrow">{t("STARTER KIT")}</div>
            <h2>{t("Choose a design pattern")}</h2>
            <p>{t("Each template is a runnable baseline you can freely adapt.")}</p>
          </div>
          <button className="small-icon" onClick={onClose}>
            <X size={16} />
          </button>
        </div>
        <div className="search-field modal-search">
          <Search size={14} />
          <input
            autoFocus
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder={t("Search templates")}
          />
        </div>
        <div className="template-grid">
          {matches.map((template) => (
            <button
              className="template-card"
              key={template.id}
              onClick={() => onPick(template)}
            >
              <div className="template-card-top">
                <span
                  className="template-swatch"
                  style={{ background: template.accent }}
                />
                <span className="difficulty">{t(template.difficulty)}</span>
                <ArrowUpRight size={14} />
              </div>
              <h3>{t(template.name)}</h3>
              <p>{t(template.description)}</p>
              <div className="template-tags">
                {template.tags.map((tag) => (
                  <span key={tag}>{t(tag)}</span>
                ))}
              </div>
              <div className="template-meta">
                <span>{template.nodes.length} {t("blocks")}</span>
                <span>{t(template.mode)}</span>
              </div>
            </button>
          ))}
        </div>
        <div className="modal-foot">
          <span>
            <CircleHelp size={13} /> {t("Templates include editable instance code")}
          </span>
          <button className="tool-button" onClick={onClose}>
            {t("Cancel")}
          </button>
        </div>
      </div>
    </div>
  );
}

export default App;
