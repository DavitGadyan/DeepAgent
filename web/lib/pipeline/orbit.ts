/**
 * An agent's graph drawn as an orbit: the agent in the middle, its steps on a
 * ring around it in the order a job passes them, and the graph's edges as
 * curves between the steps. Pure geometry, so it can be tested without a DOM.
 */
import type { GraphShape } from '@/lib/types';
import { END, START } from './agentGraph';
import type { Point } from './layout';

// Sizes are mirrored in app/pipeline.css (.orbit*).
export const ORBIT_W = 296;
export const ORBIT_H = 252;
/** Radius of a step's dot and of the agent in the middle. */
export const STEP_R = 12;
export const HUB_R = 32;
const RING_R = 84;
/** Gap between a step's dot and its label, which sits on the outside of the ring. */
const LABEL_GAP = 7;
/** How far an edge bends towards the middle (below 1) or away from it (above 1). */
const BEND_IN = 0.62;
const BEND_OUT = 1.3;
/** Gap between a step's dot and the end of an edge, so the arrow head stays visible. */
const EDGE_GAP = 3;
/** An edge between steps on opposite sides goes round the agent at this distance. */
const ROUND_HUB = HUB_R + 26;

export interface OrbitStep extends Point {
  id: string;
  label: string;
  /** Where the label goes: outside the ring, so no edge crosses it. */
  labelAt: Point;
  anchor: 'start' | 'middle' | 'end';
}

export interface OrbitEdge {
  id: string;
  source: string;
  target: string;
  conditional: boolean;
  /** SVG path data, from the rim of the source dot to the rim of the target dot. */
  path: string;
}

export interface Orbit {
  width: number;
  height: number;
  centre: Point;
  ringRadius: number;
  steps: OrbitStep[];
  edges: OrbitEdge[];
}

const LABELS: Record<string, string> = { [START]: 'Start', [END]: 'End' };

const round = (value: number) => Math.round(value * 10) / 10;

/**
 * The ids of the graph's nodes in the order a job reaches them: breadth first
 * from the start, the end last. A node no edge leads to keeps its listed place
 * after the ones that were reached.
 */
export function flowOrder(shape: GraphShape): string[] {
  const listed = shape.nodes.map((node) => node.id);
  const ids = new Set([...listed, ...shape.edges.flatMap((edge) => [edge.source, edge.target])]);
  const first = ids.has(START) ? START : (listed[0] ?? [...ids][0]);
  const order: string[] = [];
  const queue = first === undefined ? [] : [first];
  const seen = new Set(queue);
  for (let id = queue.shift(); id !== undefined; id = queue.shift()) {
    if (id !== END) order.push(id);
    for (const edge of shape.edges) {
      if (edge.source !== id || seen.has(edge.target)) continue;
      seen.add(edge.target);
      queue.push(edge.target);
    }
  }
  const unreached = [...ids].filter((id) => !seen.has(id) && id !== END);
  return [...order, ...unreached, ...(ids.has(END) ? [END] : [])];
}

/** A graph for an agent that is not one: its fixed steps, one after the other. */
export function stepsShape(steps: readonly string[]): GraphShape {
  const ids = steps.map((_, index) => `step:${index}`);
  return {
    nodes: steps.map((label, index) => ({ id: ids[index] ?? '', label })),
    edges: ids.slice(1).map((target, index) => ({
      source: ids[index] ?? '',
      target,
      conditional: false,
    })),
  };
}

/** The angle of the step at `index` of `count`: the first at the top, then clockwise. */
const ringAngle = (index: number, count: number) =>
  -Math.PI / 2 + (2 * Math.PI * index) / Math.max(count, 1);

const atAngle = (centre: Point, angle: number, radius: number): Point => ({
  x: centre.x + radius * Math.cos(angle),
  y: centre.y + radius * Math.sin(angle),
});

/** A step on the ring with its label outside: beside the dot at the sides, above or below it at the ends. */
function placeStep(id: string, label: string, angle: number, centre: Point): OrbitStep {
  const at = atAngle(centre, angle, RING_R);
  const side = Math.cos(angle);
  const upright = Math.abs(side) < 0.35;
  const out = atAngle(centre, angle, RING_R + STEP_R + LABEL_GAP);
  return {
    id,
    label,
    x: round(at.x),
    y: round(at.y),
    // The text's baseline: lowered a little, so the text is centred on the point.
    labelAt: {
      x: round(upright ? at.x : out.x),
      y: round(out.y + (Math.sin(angle) > 0.35 ? 7 : 3)),
    },
    anchor: upright ? 'middle' : side > 0 ? 'start' : 'end',
  };
}

/** Moves `from` towards `to` by `distance`. */
function towards(from: Point, to: Point, distance: number): Point {
  const length = Math.hypot(to.x - from.x, to.y - from.y) || 1;
  return {
    x: from.x + ((to.x - from.x) / length) * distance,
    y: from.y + ((to.y - from.y) / length) * distance,
  };
}

/**
 * A curve from one step to another. It bends towards the middle; when the two
 * steps call each other (model and tools), the way back bends outwards, so the
 * two directions are two separate lines.
 */
function curve(from: Point, to: Point, centre: Point, outwards: boolean): string {
  const mid = { x: (from.x + to.x) / 2, y: (from.y + to.y) / 2 };
  const control = controlPoint(from, to, mid, centre, outwards);
  const start = towards(from, control, STEP_R);
  const end = towards(to, control, STEP_R + EDGE_GAP);
  return (
    `M ${round(start.x)} ${round(start.y)} ` +
    `Q ${round(control.x)} ${round(control.y)} ${round(end.x)} ${round(end.y)}`
  );
}

/** The orbit for `shape`, in a box of ORBIT_W x ORBIT_H; the picture scales with its SVG view box. */
/**
 * The point an edge bends towards. Between steps on opposite sides of the ring
 * the straight way leads through the agent in the middle, so the edge goes
 * round it instead: to the right of its direction, the way back to the left.
 */
function controlPoint(from: Point, to: Point, mid: Point, centre: Point, outwards: boolean): Point {
  if (Math.hypot(mid.x - centre.x, mid.y - centre.y) < HUB_R + 14) {
    const length = Math.hypot(to.x - from.x, to.y - from.y) || 1;
    const side = outwards ? -1 : 1;
    return {
      x: centre.x + (-(to.y - from.y) / length) * side * ROUND_HUB * 2,
      y: centre.y + ((to.x - from.x) / length) * side * ROUND_HUB * 2,
    };
  }
  const bend = outwards ? BEND_OUT : BEND_IN;
  return { x: centre.x + (mid.x - centre.x) * bend, y: centre.y + (mid.y - centre.y) * bend };
}

export function layoutOrbit(shape: GraphShape): Orbit {
  const centre = { x: ORBIT_W / 2, y: ORBIT_H / 2 };
  const labels = new Map(shape.nodes.map((node) => [node.id, node.label]));
  const order = flowOrder(shape);
  const steps = order.map((id, index) =>
    placeStep(id, LABELS[id] ?? labels.get(id) ?? id, ringAngle(index, order.length), centre),
  );
  const place = new Map(steps.map((step, index) => [step.id, { step, index }]));
  const listed = new Set(shape.edges.map((edge) => `${edge.source}->${edge.target}`));

  const edges = shape.edges.flatMap((edge): OrbitEdge[] => {
    const from = place.get(edge.source);
    const to = place.get(edge.target);
    if (!from || !to || from === to) return [];
    const wayBack = listed.has(`${edge.target}->${edge.source}`) && from.index > to.index;
    return [
      {
        id: `${edge.source}->${edge.target}`,
        source: edge.source,
        target: edge.target,
        conditional: edge.conditional,
        path: curve(from.step, to.step, centre, wayBack),
      },
    ];
  });
  return { width: ORBIT_W, height: ORBIT_H, centre, ringRadius: RING_R, steps, edges };
}

/** The steps joined to `id` by an edge, and `id` itself: what stays bright when it is pointed at. */
export function neighbours(orbit: Orbit, id: string): Set<string> {
  const joined = new Set([id]);
  for (const edge of orbit.edges) {
    if (edge.source === id) joined.add(edge.target);
    if (edge.target === id) joined.add(edge.source);
  }
  return joined;
}
