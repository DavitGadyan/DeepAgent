'use client';
import { Check, CircleDashed, CircleX, LoaderCircle, type LucideIcon } from 'lucide-react';
import { useId, useMemo, useState } from 'react';
import {
  completeNodes,
  END,
  fixedStepStates,
  type GraphNodeState,
  graphNodeStates,
  START,
  threadPlace,
} from '@/lib/pipeline/agentGraph';
import {
  HUB_R,
  layoutOrbit,
  neighbours,
  type Orbit,
  STEP_R,
  stepsShape,
} from '@/lib/pipeline/orbit';
import type { NodeState } from '@/lib/pipeline/reducer';
import { shortId, type Thread } from '@/lib/pipeline/threads';
import type { GraphShape, PipelineNode } from '@/lib/types';

type States = Record<string, GraphNodeState>;

const STATE_ICON: Record<GraphNodeState, LucideIcon> = {
  pending: CircleDashed,
  active: LoaderCircle,
  done: Check,
  failed: CircleX,
};
const STATE_WORD: Record<GraphNodeState, string> = {
  pending: 'not yet',
  active: 'running now',
  done: 'done',
  failed: 'failed',
};

/** An edge was travelled once its start is finished and its end has been reached. */
const travelled = (states: States, source: string, target: string) =>
  states[source] === 'done' && states[target] !== undefined && states[target] !== 'pending';

/** The edge the thread is on right now: the one that led into the step it is in. */
const isLive = (states: States, source: string, target: string) =>
  states[source] === 'done' && states[target] === 'active';

/** The agent in the middle, its steps on the ring, and the edges between them. */
function Ring({
  orbit,
  states,
  focus,
  onFocus,
  hub,
  label,
}: {
  orbit: Orbit;
  states: States;
  /** The step pointed at: it and its neighbours stay bright, the rest steps back. */
  focus: string | null;
  onFocus: (id: string | null) => void;
  hub: string;
  label: string;
}) {
  // An id unique on the page, without the characters `url(#...)` cannot hold.
  const arrow = `orbit${useId().replaceAll(/[^a-zA-Z0-9]/g, '')}`;
  const bright = focus === null ? null : neighbours(orbit, focus);
  const { centre, width, height } = orbit;

  return (
    <svg
      className="orbit"
      viewBox={`0 0 ${width} ${height}`}
      role="group"
      aria-label={label}
      onMouseLeave={() => onFocus(null)}
    >
      <defs>
        <marker id={arrow} viewBox="0 0 6 6" refX="5" refY="3" markerWidth="5" markerHeight="5">
          <path d="M0 0 L6 3 L0 6 z" fill="context-stroke" />
        </marker>
      </defs>
      <circle className="orbit__ring" cx={centre.x} cy={centre.y} r={orbit.ringRadius} />
      {orbit.steps.map((step) => (
        <line
          key={step.id}
          className="orbit__spoke"
          x1={centre.x}
          y1={centre.y}
          x2={step.x}
          y2={step.y}
        />
      ))}
      {orbit.edges.map((edge) => {
        const live = isLive(states, edge.source, edge.target);
        const dim = bright !== null && !(focus === edge.source || focus === edge.target);
        return (
          <g key={edge.id} data-dim={dim || undefined}>
            <path
              className="orbit__edge"
              d={edge.path}
              markerEnd={`url(#${arrow})`}
              data-conditional={edge.conditional || undefined}
              data-on={travelled(states, edge.source, edge.target) || undefined}
              data-live={live || undefined}
            />
            {live &&
              [0, 0.8].map((delay) => (
                // A particle travelling the edge the thread is on.
                <circle key={delay} className="orbit__particle" r={2.4}>
                  <animateMotion
                    dur="1.6s"
                    begin={`${delay}s`}
                    repeatCount="indefinite"
                    path={edge.path}
                  />
                </circle>
              ))}
          </g>
        );
      })}
      <g className="orbit__hub">
        <circle cx={centre.x} cy={centre.y} r={HUB_R} />
        <text x={centre.x} y={centre.y} dominantBaseline="central" textAnchor="middle">
          {hub}
        </text>
      </g>
      {orbit.steps.map((step) => {
        const state = states[step.id] ?? 'pending';
        const end = step.id === START || step.id === END;
        return (
          <g
            key={step.id}
            className="orbit__step"
            data-state={state}
            data-end={end || undefined}
            data-dim={(bright !== null && !bright.has(step.id)) || undefined}
            onMouseEnter={() => onFocus(step.id)}
          >
            <title>{`${step.label}: ${STATE_WORD[state]}`}</title>
            {state === 'active' && (
              <circle className="orbit__pulse" cx={step.x} cy={step.y} r={STEP_R} />
            )}
            <circle className="orbit__dot" cx={step.x} cy={step.y} r={end ? STEP_R - 4 : STEP_R} />
            <text
              className="orbit__label"
              x={step.labelAt.x}
              y={step.labelAt.y}
              textAnchor={step.anchor}
            >
              {step.label}
            </text>
          </g>
        );
      })}
    </svg>
  );
}

/** The steps in the order a job passes them, with the one that runs now marked. */
function StepList({
  orbit,
  states,
  focus,
  onFocus,
}: {
  orbit: Orbit;
  states: States;
  focus: string | null;
  onFocus: (id: string | null) => void;
}) {
  const steps = orbit.steps.filter((step) => step.id !== START && step.id !== END);
  return (
    <ol className="orbit__steps" onMouseLeave={() => onFocus(null)}>
      {steps.map((step, index) => {
        const state = states[step.id] ?? 'pending';
        const Icon = STATE_ICON[state];
        return (
          <li
            key={step.id}
            data-state={state}
            data-focus={focus === step.id || undefined}
            aria-current={state === 'active' ? 'step' : undefined}
            onMouseEnter={() => onFocus(step.id)}
          >
            <span className="orbit__n">{index + 1}</span>
            <span className="orbit__name">{step.label}</span>
            <span className="orbit__state">
              <Icon
                size={12}
                className={state === 'active' ? 'spin' : undefined}
                aria-hidden="true"
              />
              {STATE_WORD[state]}
            </span>
          </li>
        );
      })}
    </ol>
  );
}

/** The thread whose position the graph shows: short id, title, and where it is in words. */
function ThreadLine({ thread, place }: { thread: Thread | undefined; place: string }) {
  return (
    <p className="orbit__thread">
      {thread ? (
        <>
          <code title={thread.id}>{shortId(thread.id)}</code> <span>{thread.title}</span>
        </>
      ) : (
        <span>Waiting for a job</span>
      )}
      <b>{place}</b>
    </p>
  );
}

function stepStatesById(shape: GraphShape, node: PipelineNode, state: NodeState): States {
  const fixed = fixedStepStates(node, state);
  return Object.fromEntries(shape.nodes.map((step, index) => [step.id, fixed[index] ?? 'pending']));
}

/**
 * What the agent does inside, as an orbit: the agent in the middle and its
 * steps around it. For a LangGraph agent the steps are the nodes of its graph
 * and the one its thread is in glows, with particles on the edge that led
 * there. The other agents show their fixed steps; only the applier's have a
 * live position. Pointing at a step dims the ones it is not joined to.
 */
export function OrbitGraph({
  node,
  nodeId,
  state,
  thread,
}: {
  node: PipelineNode;
  /** Id of the card: the worker (the row) whose thread is shown. */
  nodeId: string;
  state: NodeState;
  thread: Thread | undefined;
}) {
  const [focus, setFocus] = useState<string | null>(null);
  const isGraph = node.graph !== null && node.graph.nodes.length > 0;
  const shape = useMemo(
    () => (node.graph && isGraph ? node.graph : stepsShape(node.steps)),
    [node, isGraph],
  );
  const orbit = useMemo(() => layoutOrbit(shape), [shape]);
  if (completeNodes(shape).length === 0) {
    return (
      <p className="tg__hint py-2">The agent has not started yet, so its graph is not known.</p>
    );
  }
  const states = isGraph
    ? graphNodeStates(shape, thread, nodeId)
    : stepStatesById(shape, node, state);

  return (
    <section className="orbit__box" aria-label={`What the ${node.label} does inside`}>
      <h3 className="label">{isGraph ? 'LangGraph graph' : 'Steps'}</h3>
      {isGraph && <ThreadLine thread={thread} place={threadPlace(shape, thread, nodeId)} />}
      <Ring
        orbit={orbit}
        states={states}
        focus={focus}
        onFocus={setFocus}
        hub={node.label}
        label={`Graph of the ${node.label}`}
      />
      <StepList orbit={orbit} states={states} focus={focus} onFocus={setFocus} />
    </section>
  );
}
