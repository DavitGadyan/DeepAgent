import { describe, expect, it } from 'vitest';
import type { Pipeline, PipelineNode } from '@/lib/types';
import { layoutPipeline, nodeSize, pipelineEdges } from './layout';

const node = (id: string, kind: PipelineNode['kind'], parent?: string): PipelineNode => ({
  id,
  label: id,
  kind,
  description: '',
  model: '',
  parent,
  enabled: true,
});

const PIPELINE: Pipeline = {
  nodes: [
    node('source:a', 'source', 'scout'),
    node('source:b', 'source', 'scout'),
    node('scout', 'tool'),
    node('filter', 'tool'),
    node('extractor', 'llm'),
  ],
  edges: [
    { source: 'scout', target: 'filter' },
    { source: 'filter', target: 'extractor' },
  ],
};

describe('pipelineEdges', () => {
  it('adds the edge from a source into its parent when the API leaves it out', () => {
    expect(pipelineEdges(PIPELINE)).toContainEqual({ source: 'source:a', target: 'scout' });
  });

  it('does not duplicate an edge the API already lists', () => {
    const listed = {
      ...PIPELINE,
      edges: [...PIPELINE.edges, { source: 'source:a', target: 'scout' }],
    };
    const intoScout = pipelineEdges(listed).filter((edge) => edge.source === 'source:a');

    expect(intoScout).toHaveLength(1);
  });

  it('ignores edges that point at unknown nodes', () => {
    const dangling = { ...PIPELINE, edges: [{ source: 'scout', target: 'nowhere' }] };

    expect(pipelineEdges(dangling).some((edge) => edge.target === 'nowhere')).toBe(false);
  });
});

describe('layoutPipeline', () => {
  const positions = layoutPipeline(PIPELINE);
  const at = (id: string) => positions[id] ?? { x: NaN, y: NaN };

  it('places the stages left to right with the sources before the scout', () => {
    expect(at('source:a').x).toBeLessThan(at('scout').x);
    expect(at('scout').x).toBeLessThan(at('filter').x);
    expect(at('filter').x).toBeLessThan(at('extractor').x);
  });

  it('stacks the sources in one column without overlap', () => {
    const [a, b] = [at('source:a'), at('source:b')];
    const height = nodeSize(node('source:a', 'source')).height;

    expect(a.x).toBe(b.x);
    expect(Math.abs(a.y - b.y)).toBeGreaterThanOrEqual(height);
  });
});
