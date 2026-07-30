import { create } from 'zustand';
import type { EdgeChange, NodeChange } from '@xyflow/react';
import { applyEdgeChanges, applyNodeChanges } from '@xyflow/react';
import { catalog, templates } from '../data/catalog';
import type { AgentEdge, AgentNode, BlockInstanceData, BottomTab, InspectorTab, RunRecord, Template, TraceEvent, WorkspaceView } from '../types';
import { clearWorkspaceSession, writeWorkspaceSession } from './workspaceSession';
import i18n from '../i18n';

interface Snapshot { nodes: AgentNode[]; edges: AgentEdge[]; }

export interface RunMetricsSummary { tokens?: number; durationMs?: number; costUsd?: number; }

const clone = <T,>(value: T): T => JSON.parse(JSON.stringify(value)) as T;
const edgeStructure = (edges: AgentEdge[]) => JSON.stringify(edges.map(({ selected: _selected, ...edge }) => edge));
const appendSnapshot = (state: EditorState, nodes: AgentNode[], edges: AgentEdge[]) => {
  const snapshot = { nodes: clone(nodes), edges: clone(edges) };
  const current = state.history[state.historyIndex];
  if (current && JSON.stringify(current) === JSON.stringify(snapshot)) return { history: state.history, historyIndex: state.historyIndex };
  const history = state.history.slice(0, state.historyIndex + 1).concat(snapshot).slice(-50);
  return { history, historyIndex: history.length - 1 };
};
const instantiateTemplate = (template: Template): Snapshot => {
  const ids = new Map(template.nodes.map((node, index) => [node.id, `${template.id}-${index + 1}`]));
  const nodes = template.nodes.map((node) => ({ ...clone(node), id: ids.get(node.id)! }));
  const edges = template.edges.map((edge, index) => ({ ...clone(edge), id: `${template.id}-edge-${index + 1}`, source: ids.get(edge.source) ?? edge.source, target: ids.get(edge.target) ?? edge.target }));
  return { nodes, edges };
};
const starter = templates[0];
const starterGraph = instantiateTemplate(starter);

interface EditorState {
  projectId: string;
  projectName: string;
  revisionId: string | null;
  revisionSequence: number;
  activeView: WorkspaceView;
  inspectorTab: InspectorTab;
  bottomTab: BottomTab;
  nodes: AgentNode[];
  edges: AgentEdge[];
  selectedNodeId: string | null;
  selectedEdgeIds: string[];
  clipboard: AgentNode[];
  history: Snapshot[];
  historyIndex: number;
  isRunning: boolean;
  runId: string | null;
  runs: RunRecord[];
  trace: TraceEvent[];
  runMetrics: RunMetricsSummary | null;
  problems: string[];
  consoleLines: string[];
  input: string;
  output: string;
  dirty: boolean;
  setView: (view: WorkspaceView) => void;
  setWorkspaceIdentity: (projectId: string, revisionId: string, revisionSequence: number) => void;
  detachProject: () => void;
  hydrateWorkspace: (payload: { projectId: string; projectName: string; revisionId: string; revisionSequence: number; activeView: WorkspaceView; nodes: AgentNode[]; edges: AgentEdge[] }) => void;
  setProjectName: (name: string) => void;
  setInspectorTab: (tab: InspectorTab) => void;
  setBottomTab: (tab: BottomTab) => void;
  selectNode: (id: string | null) => void;
  selectEdges: (ids: string[]) => void;
  setInput: (input: string) => void;
  loadTemplate: (template: Template) => void;
  pushHistory: () => void;
  undo: () => void;
  redo: () => void;
  applyChanges: (changes: NodeChange<AgentNode>[]) => void;
  applyEdgeChanges: (changes: EdgeChange<AgentEdge>[]) => void;
  setNodes: (nodes: AgentNode[]) => void;
  setEdges: (edges: AgentEdge[]) => void;
  setEdgeRoute: (edgeId: string, route: string | null) => void;
  addBlock: (manifestId: string, position: { x: number; y: number }) => void;
  updateNodeData: (id: string, patch: Partial<BlockInstanceData>) => void;
  removeNodes: (ids: string[]) => void;
  removeEdges: (ids: string[]) => void;
  deleteSelection: () => void;
  copySelected: () => void;
  cutSelected: () => void;
  paste: () => void;
  duplicateSelected: () => void;
  saveRevision: () => void;
  setRunState: (running: boolean, runId?: string | null) => void;
  addTrace: (event: TraceEvent) => void;
  setRunMetrics: (metrics: RunMetricsSummary | null) => void;
  finishRun: (status: RunRecord['status'], output?: string) => void;
  resetRun: () => void;
  addProblem: (message: string) => void;
}

export const useEditorStore = create<EditorState>((set, get) => ({
  projectId: 'proj-local', projectName: 'Untitled Agent', revisionId: null, revisionSequence: 1, activeView: 'design', inspectorTab: 'config', bottomTab: 'trace',
  nodes: starterGraph.nodes, edges: starterGraph.edges, selectedNodeId: null, selectedEdgeIds: [], clipboard: [], history: [clone(starterGraph)], historyIndex: 0,
  isRunning: false, runId: null, runs: [], trace: [], runMetrics: null, problems: [], consoleLines: [i18n.t('Agent Lab ready. Load a template or add a block to begin.')], input: i18n.t('Find a concise answer and cite the sources you used.'), output: '', dirty: false,
  setView: (activeView) => { const { projectId } = get(); if (projectId !== 'proj-local') writeWorkspaceSession({ projectId, activeView }); set({ activeView }); },
  setWorkspaceIdentity: (projectId, revisionId, revisionSequence) => { writeWorkspaceSession({ projectId, activeView: get().activeView }); set({ projectId, revisionId, revisionSequence, dirty: false }); },
  detachProject: () => { clearWorkspaceSession(); set({ projectId: 'proj-local', revisionId: null, revisionSequence: 1, dirty: true }); },
  hydrateWorkspace: ({ projectId, projectName, revisionId, revisionSequence, activeView, nodes, edges }) => {
    const snapshot = { nodes: clone(nodes), edges: clone(edges) };
    writeWorkspaceSession({ projectId, activeView });
    set({ projectId, projectName, revisionId, revisionSequence, activeView, nodes, edges, selectedNodeId: null, selectedEdgeIds: [], history: [snapshot], historyIndex: 0, dirty: false, trace: [], runMetrics: null, output: '', problems: [], consoleLines: [i18n.t('Restored the last saved project.')] });
  },
  setProjectName: (projectName) => set({ projectName }),
  setInspectorTab: (inspectorTab) => set({ inspectorTab }),
  setBottomTab: (bottomTab) => set({ bottomTab }),
  selectNode: (selectedNodeId) => set({ selectedNodeId }),
  selectEdges: (selectedEdgeIds) => set({ selectedEdgeIds }),
  setInput: (input) => set({ input }),
  loadTemplate: (template) => {
    const { nodes, edges } = instantiateTemplate(template);
    clearWorkspaceSession();
    set({ projectName: template.name, nodes, edges, selectedNodeId: null, selectedEdgeIds: [], projectId: 'proj-local', revisionId: null, revisionSequence: 1, activeView: 'design', dirty: false, history: [{ nodes, edges }], historyIndex: 0, trace: [], runMetrics: null, output: '', problems: [], consoleLines: [`${i18n.t('Loaded')} ${i18n.t(template.name)}.`, i18n.t('Run validation before execution.')] });
  },
  pushHistory: () => set((state) => ({ ...appendSnapshot(state, state.nodes, state.edges), dirty: true })),
  undo: () => set((state) => {
    if (state.historyIndex <= 0) return state;
    const index = state.historyIndex - 1; const snap = state.history[index];
    return { nodes: clone(snap.nodes), edges: clone(snap.edges), historyIndex: index, dirty: true, selectedNodeId: null, selectedEdgeIds: [] };
  }),
  redo: () => set((state) => {
    if (state.historyIndex >= state.history.length - 1) return state;
    const index = state.historyIndex + 1; const snap = state.history[index];
    return { nodes: clone(snap.nodes), edges: clone(snap.edges), historyIndex: index, dirty: true, selectedNodeId: null, selectedEdgeIds: [] };
  }),
  applyChanges: (changes) => set((state) => ({ nodes: applyNodeChanges(changes, state.nodes) as AgentNode[], dirty: state.dirty })),
  applyEdgeChanges: (changes) => set((state) => ({ edges: applyEdgeChanges(changes, state.edges) as AgentEdge[], dirty: state.dirty })),
  setNodes: (nodes) => set((state) => ({ nodes, ...appendSnapshot(state, nodes, state.edges), dirty: true })),
  setEdges: (edges) => set((state) => {
    const structural = edgeStructure(edges) !== edgeStructure(state.edges);
    return { edges, ...(structural ? appendSnapshot(state, state.nodes, edges) : {}), dirty: structural ? true : state.dirty };
  }),
  setEdgeRoute: (edgeId, route) => set((state) => {
    const edges = state.edges.map((edge) => edge.id === edgeId ? { ...edge, data: { ...(edge.data ?? {}), route: route ?? undefined }, label: route ?? undefined } : edge);
    return { edges, ...appendSnapshot(state, state.nodes, edges), dirty: true };
  }),
  addBlock: (manifestId, position) => {
    const manifest = catalog.find((b) => b.id === manifestId); if (!manifest) return;
    const id = `${manifestId.replace('.', '-')}-${Date.now()}`;
    const llmBacked = ['model.chat', 'control.react', 'control.plan', 'control.router', 'agent.supervisor'].includes(manifestId);
    const config = llmBacked ? { provider: '', model: '', base_url: '', temperature: 0 } : {};
    const newNode: AgentNode = { id, type: 'agent', position, data: { label: manifest.name, manifestId, category: manifest.category, description: manifest.description, color: manifest.color, icon: manifest.icon, code: manifest.code, originalCode: manifest.code, isOverride: false, config } };
    set((state) => { const nodes = state.nodes.concat(newNode); return { nodes, ...appendSnapshot(state, nodes, state.edges), selectedNodeId: id, dirty: true, consoleLines: state.consoleLines.concat(`${i18n.t('Added')} ${i18n.t(manifest.name)}.`) }; });
  },
  updateNodeData: (id, patch) => set((state) => ({ nodes: state.nodes.map((n) => n.id === id ? { ...n, data: { ...n.data, ...patch } } : n), dirty: true })),
  removeNodes: (ids) => {
    const edgeIds = Array.from(new Set([...get().selectedEdgeIds, ...get().edges.filter((edge) => edge.selected).map((edge) => edge.id)]));
    if (!ids.length && !edgeIds.length) return;
    set((state) => { const nodes = state.nodes.filter((n) => !ids.includes(n.id)); const edges = state.edges.filter((e) => !edgeIds.includes(e.id) && !ids.includes(e.source) && !ids.includes(e.target)); return { nodes, edges, ...appendSnapshot(state, nodes, edges), selectedNodeId: null, selectedEdgeIds: [], dirty: true }; });
  },
  removeEdges: (ids) => { if (!ids.length) return; set((state) => { const edges = state.edges.filter((edge) => !ids.includes(edge.id)); return { edges, ...appendSnapshot(state, state.nodes, edges), selectedEdgeIds: [], dirty: true }; }); },
  deleteSelection: () => {
    const state = get();
    const nodeIds = state.nodes.filter((node) => node.selected).map((node) => node.id);
    const edgeIds = Array.from(new Set([...state.selectedEdgeIds, ...state.edges.filter((edge) => edge.selected).map((edge) => edge.id)]));
    if (!nodeIds.length && !edgeIds.length) return;
    set((current) => ({
      ...(() => { const nodes = current.nodes.filter((node) => !nodeIds.includes(node.id)); const edges = current.edges.filter((edge) => !edgeIds.includes(edge.id) && !nodeIds.includes(edge.source) && !nodeIds.includes(edge.target)); return { nodes, edges, ...appendSnapshot(current, nodes, edges) }; })(),
      selectedNodeId: null,
      selectedEdgeIds: [],
      dirty: true,
    }));
  },
  copySelected: () => set((state) => ({ clipboard: clone(state.nodes.filter((node) => node.selected)) })),
  cutSelected: () => { get().copySelected(); get().removeNodes(get().nodes.filter((n) => n.selected).map((n) => n.id)); },
  paste: () => {
    const items = get().clipboard; if (!items.length) return;
    const pasted = items.map((n, i) => ({ ...clone(n), id: `${n.data.manifestId.replace('.', '-')}-paste-${Date.now()}-${i}`, selected: false, position: { x: n.position.x + 48, y: n.position.y + 48 } }));
    set((state) => { const nodes = state.nodes.concat(pasted); return { nodes, ...appendSnapshot(state, nodes, state.edges), selectedNodeId: pasted[0].id, dirty: true, consoleLines: state.consoleLines.concat(`Pasted ${pasted.length} block${pasted.length > 1 ? 's' : ''}.`) }; });
  },
  duplicateSelected: () => { get().copySelected(); get().paste(); },
  saveRevision: () => set((state) => ({ revisionSequence: state.revisionSequence + 1, dirty: false, consoleLines: state.consoleLines.concat(`Saved revision ${state.revisionSequence + 1}.`) })),
  setRunState: (isRunning, runId = null) => set({ isRunning, runId }),
  addTrace: (event) => set((state) => ({ trace: state.trace.concat(event), bottomTab: 'trace' })),
  setRunMetrics: (runMetrics) => set({ runMetrics }),
  finishRun: (status, output) => set((state) => {
    const runId = state.runId ?? `local-${Date.now()}`; const run: RunRecord = { id: runId, projectId: state.projectId, revisionId: state.revisionId, revisionSequence: state.revisionSequence, status, startedAt: new Date().toISOString(), input: state.input, output, trace: state.trace };
    return { isRunning: false, output: output ?? state.output, runs: [run, ...state.runs], consoleLines: state.consoleLines.concat(status === 'success' ? i18n.t('Run completed successfully.') : `${i18n.t('Run')} ${status}.`) };
  }),
  resetRun: () => set({ trace: [], runMetrics: null, output: '', problems: [], isRunning: false, runId: null, consoleLines: [i18n.t('Ready for a new run.')] }),
  addProblem: (message) => set((state) => ({ problems: state.problems.concat(message), bottomTab: 'problems' })),
}));
