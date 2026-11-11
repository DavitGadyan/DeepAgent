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
import { type CSSProperties, useEffect, useMemo, useState } from 'react';
import { edgeId, flowingEdgeIds } from '@/lib/pipeline/edges';
import { KIND_COLOR, KIND_LABEL, NODE_KINDS } from '@/lib/pipeline/kinds';
import {
  layoutPipeline,
  nodeSize,
  pipelineEdges,
  type Point,
  type Size,
} from '@/lib/pipeline/layout';
import type { PipelineState } from '@/lib/pipeline/reducer';
import { useTheme } from '@/lib/theme';
import type { Pipeline, PipelineEdge, PipelineNode } from '@/lib/types';
import { type FlowNode, nodeTypes, PipelineCtx } from './AgentCard';

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
 * Controlled React Flow keeps a node's measured size only on the node object it
 * is given, so sizes reported through `dimensions` changes are stored and
 * handed back here; without them a rebuilt node is invisible until re-measured.
 */
function buildNodes(
  pipeline: Pipeline,
  layout: Record<string, Point>,
  pinned: Record<string, Point>,
  measured: Record<string, Size>,
  selected: string | null,
): FlowNode[] {
  return pipeline.nodes.map((node) => {
    const size = nodeSize(node);
    return {
      id: node.id,
      type: node.kind === 'source' ? 'source' : 'agent',
      position: pinned[node.id] ?? layout[node.id] ?? { x: 0, y: 0 },
      selected: selected === node.id,
      initialWidth: size.width,
      initialHeight: size.height,
      measured: measured[node.id],
      data: { node },
    };
  });
}

function buildEdges(
  edges: PipelineEdge[],
  lit: ReadonlySet<string>,
  byId: Map<string, PipelineNode>,
): Edge[] {
  return edges.map((edge) => {
    const id = edgeId(edge);
    const on = lit.has(id);
    const color = KIND_COLOR[byId.get(edge.source)?.kind ?? 'store'];
    return {
      id,
      source: edge.source,
      target: edge.target,
      animated: on,
      className: on ? 'mm__edge mm__edge--lit' : 'mm__edge',
      style: on ? ({ '--mm-c': color } as CSSProperties) : undefined,
      selectable: false,
      focusable: false,
    };
  });
}

interface Props {
  pipeline: Pipeline;
  state: PipelineState;
  /** The moment the graph shows, in epoch ms: wall clock when live, event time in replay. */
  now: number;
  selected: string | null;
  onSelect: (id: string | null) => void;
}

function Flow({ pipeline, state, now, selected, onSelect }: Props) {
  const flow = useReactFlow<FlowNode, Edge>();
  const theme = useTheme();
  const panelOpen = selected !== null;
  const [pinned, setPinned] = useState<Record<string, Point>>({});
  const [measured, setMeasured] = useState<Record<string, Size>>({});

  const layout = useMemo(() => layoutPipeline(pipeline), [pipeline]);
  const links = useMemo(() => pipelineEdges(pipeline), [pipeline]);
  const byId = useMemo(() => new Map(pipeline.nodes.map((n) => [n.id, n])), [pipeline]);
  const nodes = useMemo(
    () => buildNodes(pipeline, layout, pinned, measured, selected),
    [pipeline, layout, pinned, measured, selected],
  );
  // Joined into a string so the edges are rebuilt only when the lit set changes, not on every tick.
  const litKey = flowingEdgeIds(state, links, now).join('|');
  const edges = useMemo(
    () => buildEdges(links, new Set(litKey.split('|')), byId),
    [links, litKey, byId],
  );
  const kinds = NODE_KINDS.filter((kind) => pipeline.nodes.some((node) => node.kind === kind));

  // Refit when the side panel opens or closes, and when the window is resized.
  useEffect(() => {
    const options = panelOpen ? FIT_VIEW_BESIDE_PANEL : FIT_VIEW;
    const fit = () => void flow.fitView({ ...options, duration: reduceMotion() ? 0 : 350 });
    fit();
    window.addEventListener('resize', fit);
    return () => window.removeEventListener('resize', fit);
  }, [panelOpen, flow]);

  const onNodesChange = (changes: NodeChange<FlowNode>[]) => {
    let nextSelected = selected;
    for (const change of changes) {
      if (change.type === 'position' && change.position) {
        const position = change.position;
        setPinned((prev) => ({ ...prev, [change.id]: position }));
      } else if (change.type === 'dimensions' && change.dimensions) {
        const { width, height } = change.dimensions;
        setMeasured((prev) =>
          prev[change.id]?.width === width && prev[change.id]?.height === height
            ? prev
            : { ...prev, [change.id]: { width, height } },
        );
      } else if (change.type === 'select') {
        if (change.selected) nextSelected = change.id;
        else if (nextSelected === change.id) nextSelected = null;
      }
    }
    if (nextSelected !== selected) onSelect(nextSelected);
  };

  return (
    <div className="mm__stage">
      <PipelineCtx.Provider value={state.nodes}>
        <ReactFlow<FlowNode, Edge>
          nodes={nodes}
          edges={edges}
          nodeTypes={nodeTypes}
          colorMode={theme}
          onNodesChange={onNodesChange}
          fitView
          fitViewOptions={FIT_VIEW}
          minZoom={0.2}
          maxZoom={1.75}
          nodesConnectable={false}
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
            nodeColor={(node) => KIND_COLOR[(node as FlowNode).data.node.kind]}
          />
        </ReactFlow>
      </PipelineCtx.Provider>
      <ul className="mm__legend" aria-label="Node kinds">
        {kinds.map((kind) => (
          <li key={kind} data-kind={kind}>
            <i aria-hidden="true" />
            {KIND_LABEL[kind]}
          </li>
        ))}
      </ul>
    </div>
  );
}

/**
 * The pipeline on a React Flow canvas: sources on the left, agents left to
 * right (lib/pipeline/layout.ts). Cards show live status and counters from the
 * reduced event log; an edge lights up in its upstream node's colour while
 * items flow across it. Click a card to select it, drag to rearrange.
 */
export default function PipelineFlow(props: Props) {
  return (
    <ReactFlowProvider>
      <Flow {...props} />
    </ReactFlowProvider>
  );
}
