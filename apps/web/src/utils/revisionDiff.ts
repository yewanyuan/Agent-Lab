import type { RevisionRecord, RunnerGraph } from '../types';

export interface BlockDiff {
  id: string;
  label: string;
  kind: 'added' | 'removed' | 'modified' | 'layout-only';
  configChanged: boolean;
  codeChanged: boolean;
  layoutChanged: boolean;
}

export interface RevisionDiff {
  blocks: BlockDiff[];
  edges: { added: string[]; removed: string[] };
  counts: { added: number; removed: number; modified: number; layoutOnly: number; edgeChanges: number };
}

const secretPattern = /(api[-_]?key|secret|token|password|authorization|credential)/i;
export const redactSecrets = (value: unknown): unknown => {
  if (Array.isArray(value)) return value.map(redactSecrets);
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value as Record<string, unknown>).map(([key, child]) => [key, secretPattern.test(key) ? '[REDACTED]' : redactSecrets(child)]));
  if (typeof value === 'string' && /bearer\s+\S+/i.test(value)) return value.replace(/bearer\s+\S+/gi, 'Bearer [REDACTED]');
  return value;
};

export const redactCodeSecrets = (value: string | null | undefined): string => {
  if (!value) return 'None';
  return value
    .replace(/((?:api[-_]?key|secret|token|password|authorization|credential)\s*[:=]\s*)(['"])[^'"\r\n]*\2/gi, '$1$2[REDACTED]$2')
    .replace(/((?:api[-_]?key|secret|token|password|authorization|credential)\s*[:=]\s*)(?!['"])[^\s,;}\]]+/gi, '$1[REDACTED]')
    .replace(/bearer\s+[^\s'"\r\n]+/gi, 'Bearer [REDACTED]');
};

const canonicalize = (value: unknown): unknown => {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value as Record<string, unknown>).sort(([a], [b]) => a.localeCompare(b)).map(([key, child]) => [key, canonicalize(child)]));
  return value;
};
const stable = (value: unknown) => JSON.stringify(canonicalize(value));
const edgeKey = (edge: RunnerGraph['edges'][number]) => [edge.source, edge.source_port ?? '', edge.target, edge.target_port ?? '', edge.kind].join('|');

export const diffRevisions = (baseline: RevisionRecord, candidate: RevisionRecord): RevisionDiff => {
  const beforeBlocks = Array.isArray(baseline.graph?.blocks) ? baseline.graph.blocks : [];
  const afterBlocks = Array.isArray(candidate.graph?.blocks) ? candidate.graph.blocks : [];
  const before = new Map(beforeBlocks.map((block) => [block.id, block]));
  const after = new Map(afterBlocks.map((block) => [block.id, block]));
  const blocks: BlockDiff[] = [];
  for (const id of new Set([...before.keys(), ...after.keys()])) {
    const a = before.get(id); const b = after.get(id);
    if (!a && b) { blocks.push({ id, label: b.label ?? id, kind: 'added', configChanged: false, codeChanged: false, layoutChanged: false }); continue; }
    if (a && !b) { blocks.push({ id, label: a.label ?? id, kind: 'removed', configChanged: false, codeChanged: false, layoutChanged: false }); continue; }
    if (!a || !b) continue;
    const configChanged = stable(a.config) !== stable(b.config);
    const codeChanged = (a.code_override ?? null) !== (b.code_override ?? null);
    const aPosition = a.position ?? { x: 0, y: 0 }; const bPosition = b.position ?? { x: 0, y: 0 };
    const layoutChanged = aPosition.x !== bPosition.x || aPosition.y !== bPosition.y;
    const structural = a.block_type !== b.block_type || a.source !== b.source || a.version !== b.version || configChanged || codeChanged;
    if (structural || layoutChanged) blocks.push({ id, label: b.label ?? a.label ?? id, kind: structural ? 'modified' : 'layout-only', configChanged, codeChanged, layoutChanged });
  }
  const beforeEdges = new Set((Array.isArray(baseline.graph?.edges) ? baseline.graph.edges : []).map(edgeKey)); const afterEdges = new Set((Array.isArray(candidate.graph?.edges) ? candidate.graph.edges : []).map(edgeKey));
  const edges = { added: [...afterEdges].filter((edge) => !beforeEdges.has(edge)), removed: [...beforeEdges].filter((edge) => !afterEdges.has(edge)) };
  return { blocks, edges, counts: { added: blocks.filter((b) => b.kind === 'added').length, removed: blocks.filter((b) => b.kind === 'removed').length, modified: blocks.filter((b) => b.kind === 'modified').length, layoutOnly: blocks.filter((b) => b.kind === 'layout-only').length, edgeChanges: edges.added.length + edges.removed.length } };
};

export const safeCsvCell = (value: unknown): string => {
  const redacted = redactSecrets(value);
  let text = redacted == null ? '' : typeof redacted === 'string' ? redacted : JSON.stringify(redacted);
  text = redactCodeSecrets(text);
  if (/^[=+\-@\t\r]/.test(text)) text = `'${text}`;
  return `"${text.replaceAll('"', '""')}"`;
};
