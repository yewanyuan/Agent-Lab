import type { Edge, Node } from '@xyflow/react';

export type BlockCategory = 'input' | 'model' | 'control' | 'tool' | 'memory' | 'guardrail' | 'eval' | 'output' | 'harness';
export type InspectorTab = 'config' | 'code' | 'ports' | 'docs';
export type BottomTab = 'console' | 'trace' | 'io' | 'metrics' | 'problems';
export type WorkspaceView = 'design' | 'runs' | 'evaluations' | 'versions';
export type UiFontScale = number;
export type UiLocale = 'en' | 'zh-CN';

export interface BlockManifest {
  id: string;
  version: string;
  name: string;
  shortName?: string;
  category: BlockCategory;
  description: string;
  icon: string;
  color: string;
  inputPorts: Port[];
  outputPorts: Port[];
  code: string;
  docs: string;
  permissions?: string[];
  capabilities?: string[];
}

export interface Port {
  id: string;
  label: string;
  type: string;
  required?: boolean;
}

export interface BlockInstanceData extends Record<string, unknown> {
  label: string;
  manifestId: string;
  category: BlockCategory;
  description: string;
  color: string;
  icon: string;
  code: string;
  originalCode: string;
  isOverride: boolean;
  config: Record<string, unknown>;
  source?: string;
  version?: string;
  inputPorts?: Port[];
  outputPorts?: Port[];
  status?: 'idle' | 'running' | 'success' | 'error';
}

export type AgentNode = Node<BlockInstanceData, 'agent'>;
export type AgentEdge = Edge;

export interface Template {
  id: string;
  name: string;
  description: string;
  mode: string;
  accent: string;
  difficulty: 'Starter' | 'Intermediate' | 'Advanced';
  tags: string[];
  nodes: AgentNode[];
  edges: AgentEdge[];
}

export interface TraceEvent {
  id: string;
  timestamp: string;
  nodeId?: string;
  nodeName?: string;
  type: 'lifecycle' | 'model' | 'tool' | 'state' | 'error' | 'output';
  status: 'running' | 'success' | 'error' | 'info';
  message: string;
  detail?: string;
  durationMs?: number;
  tokens?: number;
  costUsd?: number;
  output?: unknown;
}

export interface RunnerGraph {
  blocks: Array<{
    id: string;
    block_type: string;
    label?: string;
    config: Record<string, unknown>;
    code_override?: string | null;
    source: string;
    version: string;
    position: { x: number; y: number };
  }>;
  edges: Array<{
    id: string;
    source: string;
    target: string;
    source_port?: string | null;
    target_port?: string | null;
    kind: 'data' | 'control' | 'error';
  }>;
  metadata: Record<string, unknown>;
}

export interface RunRecord {
  id: string;
  projectId: string;
  revisionId: string | null;
  revisionSequence?: number;
  status: 'queued' | 'running' | 'success' | 'failed' | 'cancelled';
  startedAt: string;
  completedAt?: string | null;
  durationMs?: number;
  input: unknown;
  output?: string;
  error?: string | null;
  trace: TraceEvent[];
}

export interface RevisionRecord {
  id: string;
  project_id: string;
  sequence: number;
  graph: RunnerGraph;
  created_at: string;
  message: string;
}

export interface RunMetrics {
  tokens?: number;
  input_tokens?: number;
  cached_input_tokens?: number;
  output_tokens?: number;
  duration_ms?: number;
  cost_usd?: number;
  pricing_version?: string | string[];
  [key: string]: unknown;
}

export interface RemoteRunRecord {
  id: string;
  project_id: string;
  revision_id: string;
  revision_sequence?: number;
  status: RunRecord['status'];
  input?: unknown;
  output?: unknown;
  error?: string | null;
  created_at: string;
  completed_at?: string | null;
  duration_ms?: number;
  metrics?: RunMetrics;
}

export interface RunSpan {
  id: string;
  run_id: string;
  node_id: string;
  block_type?: string | null;
  status: string;
  input?: unknown;
  output?: unknown;
  error?: string | null;
  metrics: RunMetrics;
  started_at?: string | null;
  completed_at?: string | null;
}

export interface RunDetail extends RemoteRunRecord {
  spans: RunSpan[];
}

export type EvaluatorType = 'exact' | 'contains' | 'regex' | 'json_schema' | 'max_steps' | 'tool_called' | 'max_cost_usd';

export interface EvalAssertion { type: EvaluatorType; value: unknown; }

export interface EvalCase {
  id: string;
  name: string;
  input: unknown;
  expected?: unknown;
  assertions: EvalAssertion[];
}

export interface EvalSuite {
  id: string;
  project_id: string;
  name: string;
  description?: string;
  cases: EvalCase[];
  created_at?: string;
  updated_at?: string;
}

export interface EvaluationVariantResult {
  run_id?: string;
  output?: unknown;
  score?: number;
  latency_ms?: number;
  tokens?: number;
  cost_usd?: number;
  error?: string | null;
}

export interface EvaluationCaseResult {
  id?: string;
  case_id?: string;
  name?: string;
  status: 'regression' | 'improvement' | 'both_pass' | 'both_fail' | 'not_evaluable';
  baseline_result: { passed: boolean; skipped?: boolean; failures: string[]; not_evaluable?: string[]; output?: unknown; metrics?: RunMetrics };
  candidate_result: { passed: boolean; skipped?: boolean; failures: string[]; not_evaluable?: string[]; output?: unknown; metrics?: RunMetrics };
}

export interface EvaluationSummary {
  baseline_wins: number;
  candidate_wins: number;
  ties: number;
  baseline_score?: number;
  candidate_score?: number;
  baseline_cost_usd?: number;
  candidate_cost_usd?: number;
  baseline_latency_ms?: number;
  candidate_latency_ms?: number;
}

export interface EvaluationExperiment {
  id: string;
  project_id: string;
  baseline_revision_id: string;
  candidate_revision_id: string;
  eval_suite_id: string;
  status: 'queued' | 'running' | 'completed' | 'partial' | 'failed' | 'cancelled';
  provider?: string | null;
  provider_snapshot?: Record<string, string>;
  budgets?: Record<string, number>;
  completed_cases?: number;
  total_cases?: number;
  metrics?: {
    cases?: number;
    failed_pairs?: number;
    baseline_passed?: number;
    candidate_passed?: number;
    baseline_pass_rate?: number;
    candidate_pass_rate?: number;
    regressions?: number;
    improvements?: number;
    unchanged?: number;
    total_tokens?: number;
    total_cost_usd?: number;
    pricing_version?: string | string[];
    stop_reason?: string | null;
  };
  cases?: EvaluationCaseResult[];
  error?: string | null;
  created_at: string;
  started_at?: string | null;
  completed_at?: string | null;
}
