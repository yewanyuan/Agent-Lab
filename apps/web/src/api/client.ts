import type { AgentEdge, AgentNode, EvalSuite, EvaluationExperiment, RemoteRunRecord, RevisionRecord, RunDetail, RunnerGraph, TraceEvent } from '../types';
import { catalog } from '../data/catalog';

export class ApiError extends Error {
  constructor(public status: number, message: string) { super(message); }
}

const request = async <T,>(path: string, init?: RequestInit): Promise<T> => {
  const headers = init?.body instanceof FormData ? init.headers : { 'Content-Type': 'application/json', ...(init?.headers ?? {}) };
  const response = await fetch(path, { ...init, headers });
  if (!response.ok) {
    const detail = await response.text();
    throw new ApiError(response.status, detail || `${response.status} ${response.statusText}`);
  }
  return response.json() as Promise<T>;
};

const blockTypes: Record<string, string> = {
  'input.user': 'input',
  'model.chat': 'llm',
  'control.react': 'react_loop',
  'control.plan': 'planner',
  'control.router': 'router',
  'agent.supervisor': 'supervisor',
  'memory.store': 'memory',
  'tool.http': 'tool',
  'tool.mcp': 'tool',
  'guardrail.approval': 'human_approval',
  'guardrail.policy': 'harness',
  'harness.trace': 'harness',
  'harness.compact': 'harness',
  'eval.assert': 'harness',
  'output.answer': 'output',
};

export const toRunnerGraph = (nodes: AgentNode[], edges: AgentEdge[]): RunnerGraph => ({
  blocks: nodes.map((node) => ({
    id: node.id,
    block_type: blockTypes[node.data.manifestId] ?? (node.data.manifestId.startsWith('harness.') ? 'harness' : node.data.manifestId),
    label: node.data.label,
    config: { ...node.data.config, __manifest_id: node.data.manifestId },
    code_override: node.data.isOverride || node.data.source?.startsWith('custom:') ? node.data.code : null,
    source: node.data.source ?? 'builtin',
    version: node.data.version ?? catalog.find((item) => item.id === node.data.manifestId)?.version ?? '1.0.0',
    position: node.position,
  })),
  edges: edges.map((edge) => ({
    id: edge.id,
    source: edge.source,
    target: edge.target,
    source_port: (edge.data as { route?: string } | undefined)?.route ?? null,
    target_port: null,
    kind: 'data',
  })),
  metadata: { editor: 'agentlab-web', schema_version: 1 },
});

export const fromRunnerGraph = (graph: RunnerGraph): { nodes: AgentNode[]; edges: AgentEdge[] } => ({
  nodes: graph.blocks.map((block) => {
    const manifestId = String(block.config.__manifest_id ?? Object.entries(blockTypes).find(([, value]) => value === block.block_type)?.[0] ?? block.block_type);
    const manifest = catalog.find((item) => item.id === manifestId);
    const code = block.code_override ?? manifest?.code ?? 'async def execute(context, inputs, config):\n    return inputs';
    return {
      id: block.id,
      type: 'agent',
      position: block.position ?? { x: 0, y: 0 },
      data: {
        label: block.label ?? manifest?.name ?? manifestId,
        manifestId,
        category: manifest?.category ?? 'tool',
        description: manifest?.description ?? 'Imported custom Python block.',
        color: manifest?.color ?? '#3aa4cc',
        icon: manifest?.icon ?? 'plug',
        code,
        originalCode: manifest?.code ?? code,
        isOverride: Boolean(block.code_override),
        config: Object.fromEntries(Object.entries(block.config).filter(([key]) => key !== '__manifest_id')),
        source: block.source,
        version: block.version,
        inputPorts: manifest?.inputPorts ?? [],
        outputPorts: manifest?.outputPorts ?? [],
      },
    };
  }),
  edges: graph.edges.map((edge) => ({ id: edge.id, source: edge.source, target: edge.target, type: 'smoothstep', interactionWidth: 20, ...(edge.source_port ? { data: { route: edge.source_port }, label: edge.source_port } : {}) })),
});

export interface PythonImportResult {
  filename: string;
  source: string;
  code: string;
  sha256: string;
  safe_to_execute: boolean;
  warnings: string[];
  functions: Array<{ name: string; async: boolean; parameters: Array<{ name: string; type: string }>; returns: string }>;
  classes: string[];
}

export interface ProviderMetadata {
  provider: 'openai' | 'anthropic' | 'openai-compatible';
  configured: boolean;
  storage: 'session' | 'keyring';
  updated_at?: string | null;
  default_model: string;
  capabilities: string[];
}

export const api = {
  health: () => request<{ status: string; safe_runtime: boolean; container_runtime?: string }>('/api/health'),
  validate: async (payload: { nodes: AgentNode[]; edges: AgentEdge[] }) => {
    const result = await request<{ valid: boolean; errors: string[]; warnings: string[] }>('/api/validate', { method: 'POST', body: JSON.stringify(toRunnerGraph(payload.nodes, payload.edges)) });
    return { valid: result.valid, problems: [...result.errors, ...result.warnings] };
  },
  createProject: (name: string, graph: RunnerGraph) => request<{ project: { id: string; name: string }; revision: RevisionRecord; credential_warnings?: string[] }>('/api/projects', { method: 'POST', body: JSON.stringify({ name, graph }) }),
  listProjects: () => request<Array<{ id: string; name: string; description: string; created_at: string; updated_at: string }>>('/api/projects'),
  getProject: (id: string) => request<{ project: { id: string; name: string; description: string }; revision: RevisionRecord | null }>(`/api/projects/${id}`),
  updateProject: (id: string, name: string, graph: RunnerGraph) => request<{ project: { id: string; name: string }; revision: RevisionRecord; credential_warnings?: string[] }>(`/api/projects/${id}`, { method: 'PATCH', body: JSON.stringify({ name, graph }) }),
  renameProject: (id: string, name: string) => request<{ project: { id: string; name: string; description: string }; revision: RevisionRecord | null }>(`/api/projects/${id}`, { method: 'PATCH', body: JSON.stringify({ name }) }),
  deleteProject: (id: string) => request<{ deleted: boolean; id: string }>(`/api/projects/${id}`, { method: 'DELETE' }),
  listRevisions: (id: string) => request<RevisionRecord[]>(`/api/projects/${id}/revisions`),
  getRevision: (id: string, revisionId: string) => request<RevisionRecord>(`/api/projects/${id}/revisions/${revisionId}`),
  deleteRevision: (id: string, revisionId: string) => request<{ deleted: boolean; id: string }>(`/api/projects/${id}/revisions/${revisionId}`, { method: 'DELETE' }),
  listRuns: (id: string) => request<RemoteRunRecord[]>(`/api/projects/${id}/runs`),
  getRun: (runId: string) => request<RunDetail>(`/api/runs/${runId}`),
  createRun: (payload: { project_id: string; revision_id?: string; input: unknown; provider?: string }) => request<{ id: string; status: string; revision_id: string }>('/api/runs', { method: 'POST', body: JSON.stringify(payload) }),
  cancelRun: (id: string) => request<{ id: string; status: string }>(`/api/runs/${id}/cancel`, { method: 'POST' }),
  exportProject: (id: string, allowSecrets = false) => fetch(`/api/projects/${id}/export${allowSecrets ? '?allow_secrets=true' : ''}`),
  importProject: async (file: File) => { const form = new FormData(); form.append('file', file); return request<{ project: { id: string; name: string }; revision: RevisionRecord }>('/api/projects/import', { method: 'POST', body: form }); },
  codeExport: (id: string, allowSecrets = false) => fetch(`/api/projects/${id}/code-export${allowSecrets ? '?allow_secrets=true' : ''}`),
  importPython: async (file: File) => { const form = new FormData(); form.append('file', file); return request<PythonImportResult>('/api/import/python', { method: 'POST', body: form }); },
  providers: () => request<ProviderMetadata[]>('/api/providers'),
  setProviderSecret: (provider: string, apiKey: string, persist: boolean) => request<ProviderMetadata>(`/api/providers/${provider}/secret`, { method: 'PUT', body: JSON.stringify({ api_key: apiKey, persist }) }),
  setProviderSettings: (provider: string, defaultModel: string) => request<ProviderMetadata>(`/api/providers/${provider}/settings`, { method: 'PUT', body: JSON.stringify({ default_model: defaultModel }) }),
  deleteProviderSecret: (provider: string) => request<{ provider: string; configured: boolean }>(`/api/providers/${provider}/secret`, { method: 'DELETE' }),
  listEvalSuites: (projectId: string) => request<EvalSuite[]>(`/api/projects/${projectId}/eval-suites`),
  createEvalSuite: (projectId: string, suite: Omit<EvalSuite, 'id' | 'project_id' | 'created_at' | 'updated_at'>) => request<EvalSuite>(`/api/projects/${projectId}/eval-suites`, { method: 'POST', body: JSON.stringify(suite) }),
  updateEvalSuite: (projectId: string, suiteId: string, suite: Pick<EvalSuite, 'name' | 'description' | 'cases'>) => request<EvalSuite>(`/api/projects/${projectId}/eval-suites/${suiteId}`, { method: 'PUT', body: JSON.stringify(suite) }),
  deleteEvalSuite: (projectId: string, suiteId: string) => request<void>(`/api/projects/${projectId}/eval-suites/${suiteId}`, { method: 'DELETE' }),
  listEvaluations: (projectId: string) => request<EvaluationExperiment[]>(`/api/projects/${projectId}/evaluations`),
  startEvaluation: (projectId: string, payload: { baseline_revision_id: string; candidate_revision_id: string; eval_suite_id: string; provider?: string; budgets?: Record<string, number> }) => request<EvaluationExperiment>(`/api/projects/${projectId}/evaluations`, { method: 'POST', body: JSON.stringify(payload) }),
  getEvaluation: (projectId: string, id: string) => request<EvaluationExperiment>(`/api/evaluations/${id}?project_id=${encodeURIComponent(projectId)}`),
  deleteEvaluation: (projectId: string, id: string) => request<void>(`/api/evaluations/${id}?project_id=${encodeURIComponent(projectId)}`, { method: 'DELETE' }),
  cancelEvaluation: (projectId: string, id: string) => request<EvaluationExperiment>(`/api/evaluations/${id}/cancel?project_id=${encodeURIComponent(projectId)}`, { method: 'POST' }),
};

const toTrace = (raw: Record<string, unknown>): TraceEvent => {
  const eventType = String(raw.type ?? 'lifecycle');
  const metrics = (raw.metrics ?? {}) as Record<string, unknown>;
  const status = eventType.includes('error') ? 'error' : eventType.includes('completed') ? 'success' : eventType.includes('started') ? 'running' : 'info';
  return {
    id: `${raw.run_id ?? 'run'}-${raw.node_id ?? eventType}-${raw.timestamp ?? Date.now()}`,
    timestamp: String(raw.timestamp ?? new Date().toISOString()),
    nodeId: raw.node_id ? String(raw.node_id) : undefined,
    nodeName: raw.block_type ? String(raw.block_type) : undefined,
    type: eventType.startsWith('node') ? 'lifecycle' : eventType.includes('error') ? 'error' : eventType.includes('completed') ? 'output' : 'state',
    status,
    message: eventType.replaceAll('_', ' '),
    detail: raw.error ? String(raw.error) : undefined,
    durationMs: typeof metrics.duration_ms === 'number' ? metrics.duration_ms : undefined,
    tokens: typeof metrics.tokens === 'number' ? metrics.tokens : undefined,
    costUsd: typeof metrics.cost_usd === 'number' ? metrics.cost_usd : undefined,
    output: raw.output,
  };
};

export const streamEvents = (runId: string, onEvent: (event: TraceEvent) => void, onDone: (status: 'completed' | 'failed') => void) => {
  const source = new EventSource(`/api/runs/${runId}/events`);
  let done = false;
  source.onmessage = (message) => {
    try {
      const raw = JSON.parse(message.data) as Record<string, unknown>;
      onEvent(toTrace(raw));
      if (raw.type === 'run_completed' || raw.type === 'run_cancelled' || raw.type === 'node_error') {
        done = true;
        source.close();
        onDone(raw.type === 'run_completed' ? 'completed' : 'failed');
      }
    } catch { /* Ignore malformed telemetry packets. */ }
  };
  source.onerror = () => { source.close(); if (!done) onDone('failed'); };
  return () => source.close();
};

export const streamEvaluationEvents = (projectId: string, evaluationId: string, onEvent: (event: Record<string, unknown>) => void, onDone: () => void) => {
  const source = new EventSource(`/api/evaluations/${evaluationId}/events?project_id=${encodeURIComponent(projectId)}`);
  let done = false;
  source.onmessage = (message) => {
    try {
      const event = JSON.parse(message.data) as Record<string, unknown>;
      onEvent(event);
      if (['evaluation_completed', 'evaluation_failed', 'evaluation_cancelled'].includes(String(event.type))) { done = true; source.close(); onDone(); }
    } catch { /* Ignore malformed evaluation telemetry packets. */ }
  };
  source.onerror = () => { source.close(); if (!done) onDone(); };
  return () => source.close();
};
