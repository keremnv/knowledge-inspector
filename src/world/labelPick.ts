/**
 * Which edge label is under the pointer — asked of the drawing, not of G6.
 *
 * An edge on these canvases refuses the pointer along its stroke, deliberately:
 * a filament is drawn *through* the discs it joins, so a line that caught
 * clicks would steal them from the marks it runs between. The name it carries
 * is a different matter — a plate with a word on it is the most clickable
 * thing on the canvas, and for a binary claim it is the *only* drawing of that
 * claim, because a bond has no chip.
 *
 * G6 will not deliver those clicks. `labelPointerEvents: "auto"` is set, the
 * custom edge's `getLabelStyle` sets `pointerEvents: "auto"` on the drawn
 * label, and the picker still does not route to it: the key path opted out and
 * the label group does not always join the same hit-test path. This was found
 * once already, for the bundle count, and worked around there alone — which is
 * why every other named edge on both canvases could be read in a table and not
 * opened by clicking the name sitting on the canvas.
 *
 * So the label the renderer already drew is the authority for where its word
 * is. This runs once per click, not per pointer move.
 */

import type { Graph } from "@antv/g6";

type Bounds = {
  min: [number, number, number];
  max: [number, number, number];
};

/**
 * A little more than the plate, and the same amount however far you zoom out.
 *
 * A name plate is a thin box — sixty-eight by ten on the vocabulary canvas —
 * and ten is under a finger and under most people's idea of a click. The pad
 * is stated in screen pixels and divided by the zoom, because a constant in
 * graph space is a target that shrinks as the drawing is pushed away, which is
 * exactly when a person is least able to be precise. `MIN_REACH` is the floor
 * the box is opened to vertically, so the thinness of the plate is not what
 * decides whether the click lands.
 */
const HIT_PAD_PX = 6;
const HIT_MIN_REACH_PX = 22;

function pointInBounds(x: number, y: number, bounds: Bounds, zoom: number) {
  const pad = HIT_PAD_PX / Math.max(zoom, 0.01);
  const reach = HIT_MIN_REACH_PX / 2 / Math.max(zoom, 0.01);
  const growY = Math.max(pad, reach - (bounds.max[1] - bounds.min[1]) / 2);
  return (
    x >= bounds.min[0] - pad &&
    x <= bounds.max[0] + pad &&
    y >= bounds.min[1] - growY &&
    y <= bounds.max[1] + growY
  );
}

/**
 * The drawn edge label under the pointer, if any.
 *
 * `reachable` is the caller's, and it is not a detail: a canvas decides which
 * of its names stand for something a person can go to. A bond's name is the
 * claim itself; a role's name is a coordinate on a claim whose plate is
 * already sitting a few pixels away, and making it a target would mean two
 * ways to select one thing and one of them arriving by accident.
 */
export function labelUnderPointer(
  graph: Graph,
  clientX: number,
  clientY: number,
  reachable: (id: string) => boolean,
): string | null {
  const [x, y] = graph.getCanvasByClient([clientX, clientY]);
  const zoom = graph.getZoom() || 1;
  for (const edge of graph.getEdgeData()) {
    const id = String(edge.id);
    if (!reachable(id)) continue;
    // An invisible label is not a target. The same rule `summaryEdge` states
    // for its own hit region: something reachable where nothing is drawn is a
    // claim that something is there.
    const style = graph.getElementRenderStyle(id);
    if (Number(style.labelOpacity ?? 0) < 0.5) continue;
    const element = (
      graph as unknown as {
        context?: { element?: { getElement: (id: string) => unknown } };
      }
    ).context?.element?.getElement(id);
    if (!element || typeof element !== "object") continue;
    const label = (element as { shapeMap?: { label?: { getRenderBounds: () => Bounds } } })
      .shapeMap?.label;
    if (!label) continue;
    const bounds = label.getRenderBounds();
    if (pointInBounds(x, y, bounds, zoom)) return id;
  }
  return null;
}

/** The canonical host-level press/release guard, with subject-owned actions. */
export function bindLabelPicking(graph: Graph, host: HTMLElement, options: {
  dragging: () => boolean;
  reachable: (id: string) => boolean;
  pick: (id: string, button: number) => void;
}) {
  let pressed = false;
  const down = (event: PointerEvent) => {
    if (options.dragging()) return;
    const hit = labelUnderPointer(graph, event.clientX, event.clientY, options.reachable);
    pressed = Boolean(hit);
    if (!hit) return;
    event.stopPropagation(); event.preventDefault();
    options.pick(hit, event.button);
  };
  const click = (event: MouseEvent) => {
    if (!labelUnderPointer(graph, event.clientX, event.clientY, options.reachable)) return;
    event.stopPropagation(); event.preventDefault();
  };
  host.addEventListener("pointerdown", down, true);
  host.addEventListener("click", click, true);
  return {
    claimed: () => pressed,
    reset: () => { pressed = false; },
    dispose: () => {
      host.removeEventListener("pointerdown", down, true);
      host.removeEventListener("click", click, true);
    },
  };
}
