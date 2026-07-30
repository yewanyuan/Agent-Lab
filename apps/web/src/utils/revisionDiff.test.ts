import { describe, expect, it } from 'vitest';
import type { RevisionRecord, RunnerGraph } from '../types';
import { diffRevisions, redactCodeSecrets, redactSecrets, safeCsvCell } from './revisionDiff';

const graph = (overrides: Partial<RunnerGraph> = {}): RunnerGraph => ({ blocks: [{ id: 'a', block_type: 'llm', label: 'Model', config: { model: 'x' }, source: 'builtin', version: '1', position: { x: 0, y: 0 } }], edges: [], metadata: {}, ...overrides });
const revision = (id: string, value: RunnerGraph): RevisionRecord => ({ id, project_id: 'p', sequence: Number(id), graph: value, created_at: '2026-01-01T00:00:00Z', message: '' });

describe('revision diff', () => {
  it('separates layout-only changes from config, code and edges', () => {
    const a = revision('1', graph());
    const b = revision('2', graph({ blocks: [{ ...graph().blocks[0], position: { x: 4, y: 5 } }] }));
    expect(diffRevisions(a, b).counts.layoutOnly).toBe(1);
    const c = revision('3', graph({ blocks: [{ ...graph().blocks[0], config: { model: 'y' }, code_override: 'return 1' }], edges: [{ id: 'e', source: 'a', target: 'a', kind: 'control' }] }));
    const diff = diffRevisions(a, c);
    expect(diff.counts.modified).toBe(1);
    expect(diff.counts.edgeChanges).toBe(1);
    expect(diff.blocks[0].codeChanged).toBe(true);
  });

  it('redacts nested secrets and neutralizes spreadsheet formulas', () => {
    expect(redactSecrets({ api_key: 'secret', nested: { password: 'value' } })).toEqual({ api_key: '[REDACTED]', nested: { password: '[REDACTED]' } });
    expect(redactCodeSecrets('api_key = "secret"\nAuthorization: "Bearer abc"')).not.toContain('secret');
    expect(safeCsvCell('=HYPERLINK("bad")')).toBe('"\'=HYPERLINK(""bad"")"');
    expect(safeCsvCell({ api_key: 'secret' })).not.toContain('secret');
    expect(safeCsvCell('Bearer should-not-export')).toContain('Bearer [REDACTED]');
    expect(safeCsvCell('api_key=should-not-export')).not.toContain('should-not-export');
  });

  it('detects nested config changes regardless of key order', () => {
    const a = revision('1', graph({ blocks: [{ ...graph().blocks[0], config: { nested: { a: 1, b: 2 } } }] }));
    const b = revision('2', graph({ blocks: [{ ...graph().blocks[0], config: { nested: { b: 3, a: 1 } } }] }));
    expect(diffRevisions(a, b).counts.modified).toBe(1);
  });

  it('detects secret-reference changes and tolerates missing legacy positions', () => {
    const a = revision('1', graph({ blocks: [{ ...graph().blocks[0], config: { secret_ref: 'A' }, position: undefined as never }] }));
    const b = revision('2', graph({ blocks: [{ ...graph().blocks[0], config: { secret_ref: 'B' } }] }));
    expect(diffRevisions(a, b).counts.modified).toBe(1);
  });
});
