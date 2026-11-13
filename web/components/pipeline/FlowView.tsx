'use client';
import type { Node } from '@xyflow/react';
import { createContext, type SyntheticEvent, useContext } from 'react';
import { INITIAL_STATE, type PipelineState } from '@/lib/pipeline/reducer';
import type { Rank } from '@/lib/pipeline/threads';
import type { PipelineNode } from '@/lib/types';

/** `worker` is null for an agent drawn as one card; `workers` is how many cards its agent has. */
export type AgentNode = Node<
  { node: PipelineNode; worker: number | null; workers: number },
  'agent'
>;
export type SourceNode = Node<{ node: PipelineNode }, 'source'>;
export type JsonNode = Node<{ row: number }, 'json'>;
export type HeaderNode = Node<{ node: PipelineNode; width: number }, 'header'>;
export type FlowNode = AgentNode | SourceNode | JsonNode | HeaderNode;

/** The id of the one thread hover card on the page, for `aria-describedby`. */
export const THREAD_CARD_ID = 'thread-card';

/** What the cards on the canvas read and can do. */
export interface FlowView {
  state: PipelineState;
  /** Rank of every scored thread of the run. */
  ranks: Record<string, Rank>;
  /** Id of the card whose details are open in the side panel. */
  selected: string | null;
  /** Ids of the cards on the highlighted thread's path; null when no thread is highlighted. */
  path: ReadonlySet<string> | null;
  /** The thread kept highlighted by a click. */
  pinned: string | null;
  /** The thread the hover card shows. */
  hovered: string | null;
  openDetails: (id: string) => void;
  togglePinned: (threadId: string) => void;
  showThread: (threadId: string, anchor: Element) => void;
  hideThread: () => void;
}

const noop = () => {};

export const FlowViewCtx = createContext<FlowView>({
  state: INITIAL_STATE,
  ranks: {},
  selected: null,
  path: null,
  pinned: null,
  hovered: null,
  openDetails: noop,
  togglePinned: noop,
  showThread: noop,
  hideThread: noop,
});

export const useFlowView = () => useContext(FlowViewCtx);

/**
 * Props for the element that stands for a thread: pointing at it or focusing
 * it (or anything inside it) shows the thread's hover card and highlights its
 * path. Nothing when the card has no thread yet.
 */
export function useThreadAnchor(threadId: string | undefined) {
  const { showThread, hideThread, hovered } = useFlowView();
  if (!threadId) return {};
  const show = (event: SyntheticEvent<Element>) => showThread(threadId, event.currentTarget);
  return {
    onMouseEnter: show,
    onMouseLeave: hideThread,
    onFocus: show,
    onBlur: hideThread,
    'aria-describedby': hovered === threadId ? THREAD_CARD_ID : undefined,
  };
}

/** `data-on-path` / `data-dim` for a card, while a thread is highlighted. */
export function pathAttrs(path: ReadonlySet<string> | null, id: string) {
  if (path === null) return {};
  return path.has(id) ? { 'data-on-path': '' } : { 'data-dim': '' };
}
