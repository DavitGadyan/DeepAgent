import { describe, expect, it } from 'vitest';
import { END, START } from './agentGraph';
import {
  flowOrder,
  HUB_R,
  layoutOrbit,
  neighbours,
  ORBIT_H,
  ORBIT_W,
  STEP_R,
  stepsShape,
} from './orbit';
import { CHAIN, LOOP } from './testEvents';

/** The middle of a quadratic curve `M x y Q cx cy ex ey`, where it comes closest to its control point. */
function curveMiddle(path: string): { x: number; y: number } {
  const [sx = 0, sy = 0, cx = 0, cy = 0, ex = 0, ey = 0] =
    path.match(/-?\d+(\.\d+)?/g)?.map(Number) ?? [];
  return { x: 0.25 * sx + 0.5 * cx + 0.25 * ex, y: 0.25 * sy + 0.5 * cy + 0.25 * ey };
}

describe('flowOrder', () => {
  it('orders a chain from start to end', () => {
    expect(flowOrder(CHAIN)).toEqual([START, 'facts', 'highlights', 'tidy', END]);
  });

  it('follows the edges, not the order the nodes are listed in', () => {
    const shuffled = { ...CHAIN, nodes: [...CHAIN.nodes].reverse() };

    expect(flowOrder(shuffled)).toEqual([START, 'facts', 'highlights', 'tidy', END]);
  });

  it('puts the model before its tools in the researcher loop, and the end last', () => {
    expect(flowOrder(LOOP)).toEqual([START, 'model', 'tools', END]);
  });

  it('includes start and end when the shape lists them only as edge ends', () => {
    const shape = {
      nodes: [{ id: 'judge', label: 'Judge' }],
      edges: [
        { source: START, target: 'judge', conditional: false },
        { source: 'judge', target: END, conditional: false },
      ],
    };

    expect(flowOrder(shape)).toEqual([START, 'judge', END]);
  });

  it('keeps a node no edge leads to, after the ones that were reached', () => {
    const shape = { ...CHAIN, nodes: [{ id: 'spare', label: 'spare' }, ...CHAIN.nodes] };

    expect(flowOrder(shape)).toEqual([START, 'facts', 'highlights', 'tidy', 'spare', END]);
  });
});

describe('stepsShape', () => {
  it('chains the steps one after the other', () => {
    expect(stepsShape(['Tailor', 'Fill', 'Stop'])).toEqual({
      nodes: [
        { id: 'step:0', label: 'Tailor' },
        { id: 'step:1', label: 'Fill' },
        { id: 'step:2', label: 'Stop' },
      ],
      edges: [
        { source: 'step:0', target: 'step:1', conditional: false },
        { source: 'step:1', target: 'step:2', conditional: false },
      ],
    });
  });

  it('has no edge for a single step and nothing at all without steps', () => {
    expect(stepsShape(['Only'])).toEqual({ nodes: [{ id: 'step:0', label: 'Only' }], edges: [] });
    expect(stepsShape([])).toEqual({ nodes: [], edges: [] });
  });

  it('keeps the steps in their order on the ring', () => {
    expect(flowOrder(stepsShape(['Tailor', 'Fill', 'Stop']))).toEqual([
      'step:0',
      'step:1',
      'step:2',
    ]);
  });
});

describe('layoutOrbit', () => {
  const shapes = [CHAIN, LOOP, stepsShape(['Tailor', 'Fill', 'Stop'])];

  it('places the steps in flow order and names start and end plainly', () => {
    const orbit = layoutOrbit(CHAIN);

    expect(orbit.steps.map((step) => step.id)).toEqual(flowOrder(CHAIN));
    expect(orbit.steps.map((step) => step.label)).toEqual([
      'Start',
      'facts',
      'highlights',
      'tidy',
      'End',
    ]);
  });

  it('puts the first step at the top of the ring', () => {
    for (const shape of shapes) {
      const orbit = layoutOrbit(shape);
      const [first, ...rest] = orbit.steps;

      expect(first).toMatchObject({
        x: orbit.centre.x,
        y: orbit.centre.y - orbit.ringRadius,
      });
      for (const step of rest) expect(step.y).toBeGreaterThan(first?.y ?? Infinity);
    }
  });

  it('goes clockwise: the second step is to the right of the first', () => {
    const [first, second] = layoutOrbit(CHAIN).steps;

    expect(second?.x).toBeGreaterThan(first?.x ?? Infinity);
  });

  it('puts every step on the ring around the middle', () => {
    for (const shape of shapes) {
      const orbit = layoutOrbit(shape);
      for (const step of orbit.steps) {
        const distance = Math.hypot(step.x - orbit.centre.x, step.y - orbit.centre.y);
        expect(distance).toBeCloseTo(orbit.ringRadius, 0);
      }
    }
  });

  it('keeps every step and the start of its label inside the picture', () => {
    for (const shape of shapes) {
      const orbit = layoutOrbit(shape);

      expect([orbit.width, orbit.height]).toEqual([ORBIT_W, ORBIT_H]);
      for (const step of orbit.steps) {
        expect(step.x - STEP_R).toBeGreaterThanOrEqual(0);
        expect(step.y - STEP_R).toBeGreaterThanOrEqual(0);
        expect(step.x + STEP_R).toBeLessThanOrEqual(orbit.width);
        expect(step.y + STEP_R).toBeLessThanOrEqual(orbit.height);
        expect(step.labelAt.x).toBeGreaterThan(0);
        expect(step.labelAt.x).toBeLessThan(orbit.width);
        expect(step.labelAt.y).toBeGreaterThan(0);
        expect(step.labelAt.y).toBeLessThan(orbit.height);
      }
    }
  });

  it('puts every label outside the ring, where no edge runs', () => {
    for (const shape of shapes) {
      const orbit = layoutOrbit(shape);
      for (const step of orbit.steps) {
        const { x, y } = step.labelAt;
        // Measured from the dot: the label is further from the middle than the dot is.
        const label = Math.hypot(x - orbit.centre.x, y - orbit.centre.y);
        expect(label).toBeGreaterThan(orbit.ringRadius);
      }
    }
  });

  it('writes a label beside a step at the sides, and centred above or below one at the ends', () => {
    const anchors = Object.fromEntries(
      layoutOrbit(LOOP).steps.map((step) => [step.id, step.anchor]),
    );

    // Start at the top, then clockwise: model on the right, tools at the bottom, end on the left.
    expect(anchors).toEqual({ [START]: 'middle', model: 'start', tools: 'middle', [END]: 'end' });
  });

  it('leads an edge between opposite steps round the agent in the middle, not through it', () => {
    const orbit = layoutOrbit(LOOP);
    const across = orbit.edges.find((edge) => edge.id === `model->${END}`);
    const middle = curveMiddle(across?.path ?? '');

    const fromCentre = Math.hypot(middle.x - orbit.centre.x, middle.y - orbit.centre.y);
    expect(fromCentre).toBeGreaterThan(HUB_R + STEP_R);
    expect(fromCentre).toBeLessThan(orbit.ringRadius);
  });

  it('gives every step its own place', () => {
    for (const shape of shapes) {
      const places = layoutOrbit(shape).steps.map((step) => `${step.x},${step.y}`);
      expect(new Set(places).size).toBe(places.length);
    }
  });

  it('gives every edge a curved path', () => {
    for (const shape of shapes) {
      const orbit = layoutOrbit(shape);

      expect(orbit.edges.map((edge) => edge.id)).toEqual(
        shape.edges.map((edge) => `${edge.source}->${edge.target}`),
      );
      for (const edge of orbit.edges) {
        expect(edge.path.startsWith('M')).toBe(true);
        expect(edge.path).toContain('Q');
        expect(edge.path).toMatch(/^M -?[\d.]+ -?[\d.]+ Q -?[\d.]+ -?[\d.]+ -?[\d.]+ -?[\d.]+$/);
      }
    }
  });

  it('draws the two directions of the model and tools loop as two different paths', () => {
    const orbit = layoutOrbit(LOOP);
    const edge = (id: string) => orbit.edges.find((candidate) => candidate.id === id);

    expect(orbit.edges).toHaveLength(4);
    expect(edge('model->tools')?.path).toBeDefined();
    expect(edge('tools->model')?.path).toBeDefined();
    expect(edge('model->tools')?.path).not.toBe(edge('tools->model')?.path);
  });

  it('keeps which edges are conditional', () => {
    const orbit = layoutOrbit(LOOP);
    const conditional = orbit.edges.filter((edge) => edge.conditional).map((edge) => edge.id);

    expect(conditional).toEqual(['model->tools', `model->${END}`]);
  });

  it('leaves out an edge from a step to itself', () => {
    const shape = {
      ...CHAIN,
      edges: [...CHAIN.edges, { source: 'facts', target: 'facts', conditional: true }],
    };

    expect(layoutOrbit(shape).edges.map((edge) => edge.id)).not.toContain('facts->facts');
  });
});

describe('neighbours', () => {
  it('returns the step and the steps joined to it', () => {
    expect(neighbours(layoutOrbit(CHAIN), 'facts')).toEqual(
      new Set(['facts', START, 'highlights']),
    );
    expect(neighbours(layoutOrbit(LOOP), 'model')).toEqual(new Set(['model', START, 'tools', END]));
  });

  it('returns only the step when nothing is joined to it', () => {
    expect(neighbours(layoutOrbit(stepsShape(['Only'])), 'step:0')).toEqual(new Set(['step:0']));
  });
});
