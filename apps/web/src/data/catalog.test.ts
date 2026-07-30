import { describe, expect, it } from 'vitest';
import { catalog, templates } from './catalog';

describe('template catalog', () => {
  it('ships six patterns and a twenty-step Harness Lab', () => {
    expect(templates).toHaveLength(7);
    const harness = templates.find((template) => template.id === 'harness-lab');
    expect(harness?.nodes).toHaveLength(20);
    expect(harness?.edges).toHaveLength(19);
    expect(catalog.filter((block) => /^harness\.s\d{2}$/.test(block.id))).toHaveLength(20);
  });

  it('keeps every template edge attached to a real node', () => {
    for (const template of templates) {
      const ids = new Set(template.nodes.map((node) => node.id));
      for (const edge of template.edges) {
        expect(ids.has(edge.source), `${template.id}:${edge.source}`).toBe(true);
        expect(ids.has(edge.target), `${template.id}:${edge.target}`).toBe(true);
      }
    }
  });
});

