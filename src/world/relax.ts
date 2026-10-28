/**
 * One settling pass over newly arrived matter.
 *
 * Not a layout engine and deliberately not a live simulation. The field is
 * still built by expansion — `workingSet` decides where new marks land, on a
 * ring around what they came from — and this only takes the slack out
 * afterwards, so two discs that were fanned into the same spot stop sitting on
 * top of each other. It runs to convergence once, with no renderer attached,
 * and then it is over. Nothing here ticks while a person is looking at it.
 *
 * That is the whole reason it is affordable. The ceiling a live force layout
 * hits is not the physics, it is a render per tick; three hundred ticks over a
 * hundred and fifty bodies with nothing drawn is a few milliseconds, once, at
 * the moment new material arrives.
 *
 * Four properties the field depends on, in the order they matter.
 *
 * **Everything already placed is pinned.** `Existing marks never move` is the
 * rule the canvas is built on, and here it is a constraint given to the solver
 * rather than a hope about how it will behave. A disc a person dragged
 * somewhere is, by then, something already on the field, so it is pinned too:
 * the settle can never take back a placement someone made by hand.
 *
 * **No charge and no centring.** Only links and collision. Those are the two
 * forces whose reach is bounded by construction — a link pulls between two
 * named bodies, a collision pushes only what overlaps — so with every old body
 * pinned, movement is provably local. Add `manyBody` and every node in the
 * field would feel every expansion; add `center` and the whole neighborhood
 * would drift toward the middle each time it grew. Both would move marks
 * nobody touched, which is the one thing that must not happen.
 *
 * **A plate is a body tied to its spokes.** It has no position of its own — it
 * sits between the marks it joins — and the way to say that to a solver is a
 * short link to each of them, not a rule applied afterwards. Given that, the
 * plate falls out where it belongs and is cleared off the discs by the same
 * collision that separates them, instead of being stepped diagonally by hand
 * until it either finds a gap or runs out of tries.
 *
 * **It is deterministic.** d3 reaches for randomness in exactly one place: to
 * jiggle two bodies that are perfectly coincident. Left alone that would make
 * the same expansions in the same order produce two different pictures, which
 * is precisely the property the ring placement was written to have. The random
 * source is seeded, and the tick count is fixed rather than timed.
 */

import {
  forceCollide,
  forceLink,
  forceSimulation,
  type SimulationLinkDatum,
  type SimulationNodeDatum,
} from "d3-force";

export type RelaxBody = {
  id: string;
  x: number;
  y: number;
  /** Already on the field: held exactly where it is. */
  pinned: boolean;
  /**
   * The room this body keeps around itself.
   *
   * Per body rather than global because a disc and a plate are not the same
   * size, and the separation d3 enforces between any two is the sum of theirs
   * — which is how one number each expresses disc-to-disc, disc-to-plate and
   * plate-to-plate clearance at once.
   */
  radius: number;
};

/** How far apart this pair would like to be. */
export type RelaxLink = { source: string; target: string; distance: number };

type Body = SimulationNodeDatum & {
  id: string;
  radius: number;
  fx?: number;
  fy?: number;
};

/**
 * A little past d3's own default, which tunes `alphaDecay` to reach `alphaMin`
 * in three hundred. Running a fixed count directly, rather than watching
 * `alpha`, keeps the pass a pure function of its input; running a few more
 * than the default gives a body wedged between pinned neighbours the ticks it
 * needs to walk out of the pocket.
 */
const TICKS = 400;

/**
 * A small deterministic generator, standing in for `Math.random`.
 *
 * mulberry32 — thirty-two bits of state, uniform enough for a jiggle, and the
 * same sequence every time the field is built the same way.
 */
function seededRandom(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/**
 * Settle the unpinned bodies and return where they came to rest.
 *
 * Only the bodies that were free appear in the result: a caller writing this
 * back cannot accidentally move something it pinned, whatever the solver did.
 */
export function relax(
  bodies: RelaxBody[],
  links: RelaxLink[],
): Map<string, { x: number; y: number }> {
  const free = bodies.filter((body) => !body.pinned);
  if (!free.length) return new Map();

  const nodes: Body[] = bodies.map((body) => ({
    id: body.id,
    x: body.x,
    y: body.y,
    radius: body.radius,
    ...(body.pinned ? { fx: body.x, fy: body.y } : {}),
  }));
  const index = new Map(nodes.map((node) => [node.id, node]));

  // A link naming a body that is not on the field would throw inside d3 rather
  // than be ignored, and the working set can hold a bond whose far end was
  // dropped.
  type Edge = SimulationLinkDatum<Body> & { distance: number };
  const edges: Edge[] = [];
  for (const link of links) {
    const source = index.get(link.source);
    const target = index.get(link.target);
    if (source && target && source !== target) {
      edges.push({ source, target, distance: link.distance });
    }
  }

  const simulation = forceSimulation(nodes)
    .randomSource(seededRandom(0x5eed))
    .force(
      "link",
      forceLink<Body, Edge>(edges)
        .id((node) => node.id)
        .distance((edge) => edge.distance)
        // Slack on purpose. `plateAt` has already put every plate roughly
        // between its spokes, so the links are here to hold that shape, not to
        // establish it — and a link firm enough to establish it is firm enough
        // to drag a new disc back through a pinned plate it is trying to get
        // clear of. Separation is the job; the links only stop the field
        // stretching while it happens.
        .strength(0.08),
    )
    .force(
      "collide",
      forceCollide<Body>((node) => node.radius).strength(1).iterations(3),
    )
    .stop();

  for (let tick = 0; tick < TICKS; tick += 1) simulation.tick();

  const settled = new Map<string, { x: number; y: number }>();
  for (const node of nodes) {
    if (node.fx !== undefined) continue;
    settled.set(node.id, {
      x: Math.round(node.x ?? 0),
      y: Math.round(node.y ?? 0),
    });
  }
  return settled;
}
