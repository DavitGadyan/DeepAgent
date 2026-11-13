'use client';
import {
  Background,
  BackgroundVariant,
  Controls,
  type Edge,
  type FitViewOptions,
  MiniMap,
  type NodeChange,
  ReactFlow,
  ReactFlowProvider,
  useReactFlow,
} from '@xyflow/react';
import '@xyflow/react/dist/base.css';
import { type CSSProperties, useCallback, useEffect, useMemo, useState } from 'react';
import {
  type FlowEdge,
  gridEdges,
  litEdgeIds,
  pathEdgeIds,
  withExtraEdges,
} from '@/lib/pipeline/edges';
import { KIND_COLOR, KIND_LABEL, NODE_KINDS } from '@/lib/pipeline/kinds';
import {
  type Cell,
  type Grid,
  jsonCellId,
  layoutPipeline,
  pipelineGrid,
  type Point,
  type Size,
} from '@/lib/pipeline/layout';
import { type Placement, placeCard } from '@/lib/pipeline/placement';
import type { PipelineState } from '@/lib/pipeline/reducer';
import { parseNodeId } from '@/lib/pipeline/stages';
import { rankThreads, type Thread, threadPath } from '@/lib/pipeline/threads';
import { useTheme } from '@/lib/theme';
import type { Pipeline, PipelineNode } from '@/lib/types';
import { nodeTypes } from './AgentCard';
import { type FlowNode, type FlowView, FlowViewCtx } from './FlowView';
import { ThreadCard } from './ThreadCard';

/** The bottom padding keeps the lowest cards clear of the legend. */
const FIT_PADDING = { x: 0.04, top: 0.04, bottom: '56px' } as const;
const FIT_VIEW: FitViewOptions<FlowNode> = { padding: FIT_PADDING, maxZoom: 1.1 };
/** With the side panel open the graph is fitted into what the panel leaves free (panel width + margins). */
const FIT_VIEW_BESIDE_PANEL: FitViewOptions<FlowNode> = {
  ...FIT_VIEW,
  padding: { ...FIT_PADDING, right: '368px' },
};

const reduceMotion = () => matchMedia('(prefers-reduced-motion: reduce)').matches;

/**
 * How far the pointer may move, in px, between press and release and still
 * click the card's button instead of dragging the card. Without it a hand that
 * trembles by one pixel would move the card and lose the click.
 */
const CLICK_SLOP = 4;

type NodesById = ReadonlyMap<string, PipelineNode>;

/** The card of `cell` as a React Flow node; null when the pipeline no longer has its agent. */
function toFlowNode(cell: Cell, byId: NodesById, grid: Grid): FlowNode | null {
  const { id, x, y, width, height } = cell;
  const base = { id, position: { x, y }, initialWidth: width, initialHeight: height };
  if (cell.kind === 'json') return { ...base, type: 'json', data: { row: cell.worker ?? 1 } };

  const node = byId.get(cell.agent);
  if (!node) return null;
  if (cell.kind === 'header') {
    // The header is a label, not a card: it cannot be dragged away from its column.
    return { ...base, type: 'header', draggable: false, data: { node, width } };
  }
  if (cell.kind === 'source') return { ...base, type: 'source', data: { node } };
  const workers = grid.columns.find((column) => column.node.id === node.id)?.workers ?? 1;
  return {
    ...base,
    type: 'agent',
    data: { node, worker: cell.worker, workers },
  };
}

/**
 * Controlled React Flow keeps a node's measured size only on the node object it
 * is given, so sizes reported through `dimensions` changes are stored and
 * handed back here; without them a rebuilt node is invisible until re-measured.
 */
function buildNodes(
  cells: Cell[],
  byId: NodesById,
  grid: Grid,
  dragged: Record<string, Point>,
  measured: Record<string, Size>,
): FlowNode[] {
  return cells.flatMap((cell) => {
    const node = toFlowNode(cell, byId, grid);
    if (!node) return [];
    return [{ ...node, position: dragged[cell.id] ?? node.position, measured: measured[cell.id] }];
  });
}

const ROLE_CLASS: Record<FlowEdge['role'], string> = {
  flow: '',
  gate: 'mm__edge--gate',
  json: 'mm__edge--json',
};

/** `path` is null when no thread is highlighted; otherwise the edges off it are dimmed. */
function buildEdges(
  edges: FlowEdge[],
  lit: ReadonlySet<string>,
  path: ReadonlySet<string> | null,
  byId: NodesById,
): Edge[] {
  return edges.map((edge) => {
    const on = lit.has(edge.id);
    const onPath = path?.has(edge.id) ?? false;
    const kind = byId.get(parseNodeId(edge.source).agent)?.kind ?? 'store';
    const classes = [
      'mm__edge',
      ROLE_CLASS[edge.role],
      on && 'mm__edge--lit',
      onPath && 'mm__edge--path',
      path !== null && !onPath && 'mm__edge--dim',
    ];
    return {
      id: edge.id,
      source: edge.source,
      target: edge.target,
      animated: on,
      className: classes.filter(Boolean).join(' '),
      style: on || onPath ? ({ '--mm-c': KIND_COLOR[kind] } as CSSProperties) : undefined,
      selectable: false,
      focusable: false,
    };
  });
}

const NO_DRAGS: Record<string, Point> = {};

const splitKey = (key: string): string[] => (key ? key.split('|') : []);

/** The cards to highlight for `thread`: its path, and the JSON card that shows it. */
function pathCards(thread: Thread, rows: PipelineState['rows']): Set<string> {
  const json = Object.entries(rows)
    .filter(([, job]) => job === thread.id)
    .map(([row]) => jsonCellId(Number(row)));
  return new Set([...threadPath(thread), ...json]);
}

/** Positions of the cards the user dragged, and how to record one. */
function useDraggedCards(cells: Cell[]) {
  const [drag, setDrag] = useState<{ layout: string; at: Record<string, Point> }>({
    layout: '',
    at: {},
  });
  // Dragged cards stay where they were put until the layout itself changes (a
  // row appears): then every card is placed anew.
  const layout = useMemo(() => cells.map((c) => `${c.id}@${c.x},${c.y}`).join('|'), [cells]);
  const move = (id: string, position: Point) =>
    setDrag((prev) => ({
      layout,
      at: { ...(prev.layout === layout ? prev.at : {}), [id]: position },
    }));
  return { dragged: drag.layout === layout ? drag.at : NO_DRAGS, move };
}

/** The sizes React Flow measured, and how to record one (see `buildNodes`). */
function useMeasuredSizes() {
  const [measured, setMeasured] = useState<Record<string, Size>>({});
  const measure = (id: string, { width, height }: Size) =>
    setMeasured((prev) =>
      prev[id]?.width === width && prev[id]?.height === height
        ? prev
        : { ...prev, [id]: { width, height } },
    );
  return { measured, measure };
}

/**
 * The thread in focus: the one whose hover card is open, else the one a click
 * pinned. Its path is highlighted and everything else steps back.
 */
function useThreadFocus(state: PipelineState) {
  const [pinned, setPinned] = useState<string | null>(null);
  const [hover, setHover] = useState<{ thread: string; place: Placement } | null>(null);
  const thread = state.threads[hover?.thread ?? pinned ?? ''];
  const cards = useMemo(
    () => (thread ? pathCards(thread, state.rows) : null),
    [thread, state.rows],
  );

  const togglePinned = useCallback(
    (id: string) => setPinned((current) => (current === id ? null : id)),
    [],
  );
  const unpin = useCallback(() => setPinned(null), []);
  const showThread = useCallback((id: string, anchor: Element) => {
    const viewport = { width: window.innerWidth, height: window.innerHeight };
    setHover({ thread: id, place: placeCard(anchor.getBoundingClientRect(), viewport) });
  }, []);
  const hideThread = useCallback(() => setHover(null), []);

  return { thread, cards, pinned, hover, togglePinned, unpin, showThread, hideThread };
}

/**
 * The edges to draw at `now`: the fixed ones, plus those a thread uses to
 * change rows while they are lit or on the highlighted thread's path.
 */
function useFlowEdges(
  pipeline: Pipeline,
  grid: Grid,
  cells: Cell[],
  byId: NodesById,
  state: PipelineState,
  now: number,
  focus: Thread | undefined,
): Edge[] {
  // Joined into strings so the edges are rebuilt only when the lit set or the
  // highlighted path changes, not on every tick of the clock.
  const litKey = litEdgeIds(state, pipeline, now).join('|');
  const pathKey = focus ? pathEdgeIds(threadPath(focus)).join('|') : null;
  return useMemo(() => {
    const lit = splitKey(litKey);
    const onPath = pathKey === null ? null : splitKey(pathKey);
    const known = new Set(cells.map((cell) => cell.id));
    const wanted = [...lit, ...(onPath ?? [])];
    const drawn = withExtraEdges(gridEdges(pipeline, grid), wanted, grid, known);
    return buildEdges(drawn, new Set(lit), onPath && new Set(onPath), byId);
  }, [pipeline, grid, cells, byId, litKey, pathKey]);
}

interface Props {
  pipeline: Pipeline;
  state: PipelineState;
  /** The moment the graph shows, in epoch ms: wall clock when live, event time in replay. */
  now: number;
  /** Id of the card whose details are open in the side panel. */
  selected: string | null;
  onSelect: (id: string | null) => void;
  /** The highest worker number each stage used in this run (lib/pipeline/stages.ts). */
  seenWorkers: Record<string, number>;
}

function Flow({ pipeline, state, now, selected, onSelect, seenWorkers }: Props) {
  const flow = useReactFlow<FlowNode, Edge>();
  const theme = useTheme();
  const panelOpen = selected !== null;

  const byId = useMemo(() => new Map(pipeline.nodes.map((n) => [n.id, n])), [pipeline]);
  const grid = useMemo(() => pipelineGrid(pipeline, seenWorkers), [pipeline, seenWorkers]);
  const cells = useMemo(() => layoutPipeline(grid), [grid]);
  const { dragged, move } = useDraggedCards(cells);
  const { measured, measure } = useMeasuredSizes();
  const nodes = useMemo(
    () => buildNodes(cells, byId, grid, dragged, measured),
    [cells, byId, grid, dragged, measured],
  );

  const focus = useThreadFocus(state);
  const edges = useFlowEdges(pipeline, grid, cells, byId, state, now, focus.thread);
  const ranks = useMemo(() => rankThreads(state.threads), [state.threads]);

  const { hideThread, showThread, togglePinned } = focus;
  const openDetails = useCallback(
    (id: string) => {
      onSelect(selected === id ? null : id);
      // The hover card would cover the panel the click just opened.
      hideThread();
    },
    [onSelect, selected, hideThread],
  );
  const { cards, pinned } = focus;
  const hovered = focus.hover?.thread ?? null;
  // Memoised: the clock re-renders this component twice a second, and a new
  // object here would re-render every card with it.
  const view = useMemo<FlowView>(
    () => ({
      state,
      ranks,
      selected,
      path: cards,
      pinned,
      hovered,
      openDetails,
      togglePinned,
      showThread,
      hideThread,
    }),
    [
      state,
      ranks,
      selected,
      cards,
      pinned,
      hovered,
      openDetails,
      togglePinned,
      showThread,
      hideThread,
    ],
  );

  const kinds = NODE_KINDS.filter((kind) => pipeline.nodes.some((node) => node.kind === kind));
  const hoverThread = focus.hover ? state.threads[focus.hover.thread] : undefined;

  // Refit when the side panel opens or closes, when a row of workers appears
  // or goes, and when the window is resized.
  const rows = grid.rows;
  useEffect(() => {
    const options = panelOpen ? FIT_VIEW_BESIDE_PANEL : FIT_VIEW;
    const fit = () => void flow.fitView({ ...options, duration: reduceMotion() ? 0 : 350 });
    fit();
    window.addEventListener('resize', fit);
    return () => window.removeEventListener('resize', fit);
  }, [panelOpen, rows, flow]);

  const onNodesChange = (changes: NodeChange<FlowNode>[]) => {
    for (const change of changes) {
      if (change.type === 'position' && change.position) move(change.id, change.position);
      if (change.type === 'dimensions' && change.dimensions) measure(change.id, change.dimensions);
    }
  };

  return (
    <div className="mm__stage">
      <FlowViewCtx.Provider value={view}>
        <ReactFlow<FlowNode, Edge>
          nodes={nodes}
          edges={edges}
          nodeTypes={nodeTypes}
          colorMode={theme}
          onNodesChange={onNodesChange}
          // The hover card is placed on the page, so it would stay behind when the canvas moves.
          onMoveStart={hideThread}
          onPaneClick={focus.unpin}
          fitView
          fitViewOptions={FIT_VIEW}
          minZoom={0.2}
          maxZoom={1.75}
          nodesConnectable={false}
          // A fast second click on a card must not zoom the canvas.
          zoomOnDoubleClick={false}
          nodeClickDistance={CLICK_SLOP}
          nodeDragThreshold={CLICK_SLOP}
          // The cards hold real buttons: those take the focus and the clicks.
          nodesFocusable={false}
          elementsSelectable={false}
          edgesFocusable={false}
          deleteKeyCode={null}
          multiSelectionKeyCode={null}
          selectionOnDrag={false}
        >
          <Background variant={BackgroundVariant.Dots} gap={22} size={1.2} color="var(--dot)" />
          <Controls showInteractive={false} position="bottom-right" />
          <MiniMap
            pannable
            zoomable
            position="top-right"
            style={{ width: 150, height: 100 }}
            bgColor="var(--panel)"
            maskColor="var(--minimap-mask)"
            nodeColor={minimapColor}
          />
        </ReactFlow>
      </FlowViewCtx.Provider>
      <ul className="mm__legend" aria-label="Node kinds">
        {kinds.map((kind) => (
          <li key={kind} data-kind={kind}>
            <i aria-hidden="true" />
            {KIND_LABEL[kind]}
          </li>
        ))}
      </ul>
      {focus.hover && hoverThread && (
        <ThreadCard
          thread={hoverThread}
          rank={ranks[hoverThread.id]}
          place={focus.hover.place}
          labelOf={(agent) => byId.get(agent)?.label ?? agent}
        />
      )}
    </div>
  );
}

function minimapColor(node: FlowNode): string {
  if (node.type === 'agent' || node.type === 'source') return KIND_COLOR[node.data.node.kind];
  return node.type === 'json' ? 'var(--line-strong)' : 'transparent';
}

/**
 * The pipeline on a React Flow canvas: sources on the left, then the scout,
 * then one row per worker. Every row is a whole pipeline (filter to applier)
 * and ends with its JSON card (lib/pipeline/layout.ts). Cards show live status
 * and counters from the reduced event log; an edge lights up in its upstream
 * node's colour while a thread moves along it. Click an agent card for its
 * graph and past events, point at a card to see its thread, drag to rearrange.
 */
export default function PipelineFlow(props: Props) {
  return (
    <ReactFlowProvider>
      <Flow {...props} />
    </ReactFlowProvider>
  );
}
