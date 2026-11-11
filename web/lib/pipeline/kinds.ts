import type { NodeKind } from '@/lib/types';

/** CSS colour of each kind; the values live in app/theme.css, one set per theme. */
export const KIND_COLOR: Record<NodeKind, string> = {
  source: 'var(--kind-source)',
  tool: 'var(--kind-tool)',
  llm: 'var(--kind-llm)',
  deep: 'var(--kind-deep)',
  human: 'var(--kind-human)',
  store: 'var(--kind-store)',
};

export const KIND_LABEL: Record<NodeKind, string> = {
  source: 'Source',
  tool: 'Tool',
  llm: 'LLM',
  deep: 'Deep agent',
  human: 'Human-gated',
  store: 'Store',
};

export const NODE_KINDS = Object.keys(KIND_LABEL) as NodeKind[];
