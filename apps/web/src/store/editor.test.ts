import { beforeEach, describe, expect, it } from 'vitest';
import { templates } from '../data/catalog';
import { useEditorStore } from './editor';

const clone = <T,>(value: T): T => JSON.parse(JSON.stringify(value)) as T;

describe('editor edge deletion', () => {
  beforeEach(() => {
    const nodes = clone(templates[0].nodes.slice(0, 2));
    const edges = [{ ...clone(templates[0].edges[0]), selected: true }];
    useEditorStore.setState({ nodes, edges, selectedNodeId: null, selectedEdgeIds: [edges[0].id], history: [{ nodes: clone(nodes), edges: clone(edges) }], historyIndex: 0, dirty: false });
  });

  it('deletes a selected connection and supports undo and redo', () => {
    useEditorStore.getState().deleteSelection();
    expect(useEditorStore.getState().edges).toHaveLength(0);
    expect(useEditorStore.getState().dirty).toBe(true);
    useEditorStore.getState().undo();
    expect(useEditorStore.getState().edges).toHaveLength(1);
    useEditorStore.getState().redo();
    expect(useEditorStore.getState().edges).toHaveLength(0);
  });

  it('does not mark the graph dirty for edge selection changes', () => {
    const next = useEditorStore.getState().edges.map((edge) => ({ ...edge, selected: false }));
    useEditorStore.getState().setEdges(next);
    expect(useEditorStore.getState().dirty).toBe(false);
    expect(useEditorStore.getState().historyIndex).toBe(0);
  });
});
