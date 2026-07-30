import { afterEach, describe, expect, it, vi } from 'vitest';
import { templates } from '../data/catalog';
import { api, fromRunnerGraph, toRunnerGraph } from './client';

afterEach(() => vi.unstubAllGlobals());

describe('runner graph adapter', () => {
  it('round-trips editor nodes without exporting instance secrets', () => {
    const template = templates[0];
    const graph = toRunnerGraph(template.nodes, template.edges);
    expect(graph.blocks[0].block_type).toBe('input');
    expect(JSON.stringify(graph)).not.toContain('api_key');

    const restored = fromRunnerGraph(graph);
    expect(restored.nodes.map((node) => node.data.manifestId)).toEqual(template.nodes.map((node) => node.data.manifestId));
    expect(restored.edges).toHaveLength(template.edges.length);
  });

  it('uses persistent revision, run, suite and evaluation endpoints', async () => {
    const fetchMock = vi.fn(async (_url: RequestInfo | URL, _init?: RequestInit) => new Response(JSON.stringify([]), { status: 200, headers: { 'Content-Type': 'application/json' } }));
    vi.stubGlobal('fetch', fetchMock);
    await api.listRevisions('project-1');
    await api.listRuns('project-1');
    await api.listEvalSuites('project-1');
    expect(fetchMock.mock.calls.map(([url]) => url)).toEqual(['/api/projects/project-1/revisions', '/api/projects/project-1/runs', '/api/projects/project-1/eval-suites']);

    fetchMock.mockResolvedValueOnce(new Response(JSON.stringify({ id: 'eval-1' }), { status: 200, headers: { 'Content-Type': 'application/json' } }));
    await api.startEvaluation('project-1', { baseline_revision_id: 'rev-a', candidate_revision_id: 'rev-b', eval_suite_id: 'suite-1' });
    const [, init] = fetchMock.mock.calls.at(-1)!;
    expect(fetchMock.mock.calls.at(-1)?.[0]).toBe('/api/projects/project-1/evaluations');
    expect(JSON.parse(String(init?.body))).toMatchObject({ baseline_revision_id: 'rev-a', candidate_revision_id: 'rev-b', eval_suite_id: 'suite-1' });

    fetchMock.mockResolvedValueOnce(new Response(JSON.stringify({ provider: 'openai', default_model: 'gpt-test' }), { status: 200, headers: { 'Content-Type': 'application/json' } }));
    await api.setProviderSettings('openai', 'gpt-test');
    const [settingsUrl, settingsInit] = fetchMock.mock.calls.at(-1)!;
    expect(settingsUrl).toBe('/api/providers/openai/settings');
    expect(JSON.parse(String(settingsInit?.body))).toEqual({ default_model: 'gpt-test' });
  });
});
