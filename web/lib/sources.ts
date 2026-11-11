import type { Pipeline } from './types';

const SOURCE_PREFIX = 'source:';

export interface SourceInfo {
  /** Adapter name, as used in `Settings.sources` and `LeadSummary.source`. */
  name: string;
  label: string;
}

/** The job boards the pipeline knows, read from its source nodes. */
export function pipelineSources(pipeline: Pipeline | undefined): SourceInfo[] {
  if (!pipeline) return [];
  return pipeline.nodes
    .filter((node) => node.kind === 'source' && node.id.startsWith(SOURCE_PREFIX))
    .map((node) => ({ name: node.id.slice(SOURCE_PREFIX.length), label: node.label }));
}

/** Display label of a source; falls back to the adapter name when the pipeline is unknown. */
export const sourceLabel = (sources: SourceInfo[], name: string) =>
  sources.find((source) => source.name === name)?.label ?? name;
