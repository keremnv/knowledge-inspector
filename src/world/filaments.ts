/**
 * The world's filament — a straight stroke whose held end will fan out.
 *
 * G6's `line` draws source to target and nothing else, which is right at rest:
 * a filament is a claim that two referents are joined, and a curve for its own
 * sake would be decoration on a structural mark.
 *
 * What it cannot do is make room. Every bond and spoke a mark carries stations
 * its plate a fixed 44px out from that mark's rim, so two neighbours sitting a
 * few degrees apart put two names on top of each other — and the moment
 * someone selects a mark is exactly the moment every one of those names is
 * revealed at once. The names are the answer; overlapping, they are not
 * readable.
 *
 * So the filament carries one optional elbow near the held end. Off, the path
 * is the chord it has always been — the same two commands, so nothing about
 * the resting field changes. On, the stroke leaves the mark on a spread angle,
 * reaches its plate's station, and runs straight to the far end from there.
 * The plates travel with their strokes, so what was a pile of names becomes a
 * fan of them; the far end never moves, so nothing about what is joined to
 * what changes.
 *
 * The elbow is renderer state, deliberately not graph data. Where a stroke
 * leaves a mark so its name can be read is presentation — nothing about the
 * world changed — and writing it into the data would make every fan a change
 * to the drawing everyone else reads back.
 *
 * Ported from the product canvas's selection fan; `spread.ts` is the geometry
 * that decides the angles.
 */

import {
  ExtensionCategory,
  Label,
  Line,
  register,
  type BaseEdgeStyleProps,
  type Graph,
} from "@antv/g6";
import { Rect, type Group } from "@antv/g";
import type { PathArray } from "@antv/util";
import type { LabelStyleProps } from "@antv/g6";

export const WORLD_FILAMENT_EDGE = "world-filament";

/**
 * Hold a plate where its station put it while its name is lowered.
 *
 * A plate's name is lowered by `dy` to centre its capitals (`capitalCentring`
 * in `marks`), and G6 centres a label's background on its text box, so the
 * plate went down with it — as it does with a transform. It is put back after
 * G6 has laid it out, on every render, since every render lays it out again.
 * Everything that reads the plate (the ants, picking, the knockout tab) still
 * reads the station.
 */
function holdPlate(label: Label | undefined, dy: number) {
  const plate = label?.getShape("background");
  if (plate && dy) plate.attr("y", Number(plate.attr("y")) - dy);
}

/** Restate an already-drawn name under endpoint movement, without a draw. */
export function restationFilament(graph: Graph, id: string, layout: {
  placement: number; offsetX: number; offsetY: number;
}) {
  const element = (graph as unknown as {
    context?: { element?: { getElement: (id: string) => {
      parsedAttributes: Record<string, unknown>; onframe: () => void;
    } | undefined } };
  }).context?.element?.getElement(id);
  if (!element) return;
  element.parsedAttributes.labelPlacement = layout.placement;
  element.parsedAttributes.labelOffsetX = layout.offsetX;
  element.parsedAttributes.labelOffsetY = layout.offsetY;
  element.onframe();
}

export type FilamentFan = {
  /** 0 on the chord, 1 fully spread. */
  amount: number;
  /** The spread direction, from the held mark's centre. */
  angle: number;
  /** How far past the held mark's rim the elbow — and its plate — sits. */
  along: number;
  /** Which end is held. The other end does not move. */
  fromSource: boolean;
};

/**
 * The role each end fills, drawn beside that end's rim.
 *
 * A stored bond is a two-role tuple, and a framed one is a wider tuple with
 * its ambient role set aside — either way its spokes had names, and folding
 * them onto one line must not lose them. Drawn by the stroke itself so the
 * names ride every drag and fan the line does without a second pass.
 */
export type RoleEnds = {
  source: { text: string; width: number } | null;
  target: { text: string; width: number } | null;
  fontFamily: string;
  fontSize: number;
  fontWeight: number;
  fill: string;
  ground: string;
  height: number;
  radius: number;
  padding: [number, number];
  /** Air between the rim and the near edge of the plate. */
  gap: number;
  /** How far each name is lowered inside its plate — see `holdPlate`. */
  dy: number;
};

type Vec = [number, number];

function mix(from: number, to: number, amount: number) {
  return from + (to - from) * amount;
}

function mixPoint(from: Vec, to: Vec, amount: number): Vec {
  return [mix(from[0], to[0], amount), mix(from[1], to[1], amount)];
}

/**
 * The plate's resting station: `along` px from the held end, down the chord.
 *
 * `along` unconditionally, capped only at the midpoint — the same rule
 * `bondLabelAlong` holds. A `len * 0.45` cap here would put the fan's elbow at
 * a percentage while the chord it interpolates from is at a distance, so a
 * half-spread plate would sit somewhere neither station named.
 */
function stationOnChord(held: Vec, far: Vec, along: number): Vec {
  const dx = far[0] - held[0];
  const dy = far[1] - held[1];
  const len = Math.hypot(dx, dy);
  if (!(len > 1)) return held;
  const u = Math.min(along, len / 2) / len;
  return [held[0] + dx * u, held[1] + dy * u];
}

/**
 * How far past the stroke a plate's knockout reaches: the stroke's own
 * half-width, plus a pixel for its antialiased edge.
 *
 * Every named plate breaks the line it stands on — the gap is what keeps
 * the name readable. A plate sitting on its line breaks it with its own
 * opaque background and needs no tab at all; a stacked plate stands
 * *beside* its line, so its background knocks out nothing and the tab is
 * the bridge from the plate to the stroke, in the background's own fill,
 * where it overlaps the plate vanishing into it.
 *
 * There was air here — 3px past the stroke on both sides and past the
 * plate on none — and it was the bar: past-line air from stacked
 * siblings joined into one tall rectangle through the whole stack, and
 * on a lone plate the same air stood past it top and bottom as a nub
 * covering no line at all. The tab now stops at the stroke's far edge,
 * and a plate the stroke already crosses draws nothing. Stacked plates
 * draw nothing either — see below — so the sharing this rule once
 * managed no longer arises; what remains is one bridge per lone plate.
 * The stroke is 1px, so 1px past its centre covers it fully.
 */
const KNOCKOUT_PAST_LINE_PX = 1;

/**
 * Whether another named edge rides this edge's pair.
 *
 * Asked of the drawing rather than plumbed through the layouts: whatever
 * named a second edge on these endpoints stacked it, in either room,
 * whatever seated it. Endpoints compare unordered — members of a pair may
 * list them either way round. The stroke edge never counts: it carries no
 * name. The naming threshold mirrors the tab's own gate below, so an edge
 * too dim to draw a plate never vetoes its sibling's bridge.
 */
export function hasNamedPairSibling(
  edges: ReadonlyArray<{
    id?: unknown;
    source?: unknown;
    target?: unknown;
    style?: { labelOpacity?: unknown } | undefined;
  }>,
  selfId: string,
  source: string,
  target: string,
): boolean {
  return edges.some(
    (edge) =>
      edge.id !== selfId &&
      ((edge.source === source && edge.target === target) ||
        (edge.source === target && edge.target === source)) &&
      Number(edge.style?.labelOpacity) > 0.01,
  );
}

/** Point at ratio along legs that run from the stroke's start to its end. */
function strokePointAt(legs: ReadonlyArray<readonly [Vec, Vec]>, ratio: number): Vec {
  const lengths = legs.map(([a, b]) => Math.hypot(b[0] - a[0], b[1] - a[1]));
  const total = lengths.reduce((sum, len) => sum + len, 0);
  if (!(total > 0)) return [legs[0][0][0], legs[0][0][1]];
  let along = Math.min(1, Math.max(0, ratio)) * total;
  for (let i = 0; i < legs.length; i++) {
    const [a, b] = legs[i];
    const len = lengths[i];
    if (along <= len || i === legs.length - 1) {
      const k = len > 0 ? Math.min(1, Math.max(0, along / len)) : 0;
      return [a[0] + (b[0] - a[0]) * k, a[1] + (b[1] - a[1]) * k];
    }
    along -= len;
  }
  const last = legs[legs.length - 1][1];
  return [last[0], last[1]];
}

/** Nearest point on the legs to p, with that leg's unit direction. */
function nearestOnStroke(
  legs: ReadonlyArray<readonly [Vec, Vec]>,
  p: Vec,
): { q: Vec; ux: number; uy: number } {
  let best: Vec = [legs[0][0][0], legs[0][0][1]];
  let bestUx = 1;
  let bestUy = 0;
  let bestD = Infinity;
  for (const [a, b] of legs) {
    const dx = b[0] - a[0];
    const dy = b[1] - a[1];
    const len2 = dx * dx + dy * dy;
    const k =
      len2 > 0
        ? Math.min(1, Math.max(0, ((p[0] - a[0]) * dx + (p[1] - a[1]) * dy) / len2))
        : 0;
    const qx = a[0] + dx * k;
    const qy = a[1] + dy * k;
    const d = Math.hypot(p[0] - qx, p[1] - qy);
    if (d < bestD) {
      bestD = d;
      best = [qx, qy];
      const len = Math.sqrt(len2);
      bestUx = len > 0 ? dx / len : 1;
      bestUy = len > 0 ? dy / len : 0;
    }
  }
  return { q: best, ux: bestUx, uy: bestUy };
}

/**
 * Live instances, keyed without retaining destroyed graphs.
 *
 * A fan is applied through the renderer rather than `graph.updateEdgeData()`
 * so only the strokes that actually move are touched and G6 is not asked to
 * re-run every style mapper on the field for a presentation change.
 */
const rendered = new WeakMap<Graph, Map<string, WorldFilament>>();

class WorldFilament extends Line {
  private fan: FilamentFan | null = null;

  constructor(options: ConstructorParameters<typeof Line>[0]) {
    super(options);
    const graph = this.context.graph;
    const edges = rendered.get(graph) ?? new Map<string, WorldFilament>();
    edges.set(this.elementId(), this);
    rendered.set(graph, edges);
  }

  public destroy() {
    rendered.get(this.context.graph)?.delete(this.elementId());
    super.destroy();
  }

  private elementId() {
    return String((this as unknown as { id: string }).id);
  }

  public hasFan(next: FilamentFan | null) {
    if (!this.fan && !next) return true;
    if (!this.fan || !next) return false;
    return (
      this.fan.fromSource === next.fromSource &&
      Math.abs(this.fan.amount - next.amount) < 0.012 &&
      Math.abs(this.fan.angle - next.angle) < 0.01 &&
      Math.abs(this.fan.along - next.along) < 0.15
    );
  }

  public setFan(next: FilamentFan | null) {
    const fan = next && next.amount > 0.01 ? next : null;
    if (this.hasFan(fan)) return;
    this.fan = fan;
    this.resync();
  }

  /**
   * Re-read live endpoints into the current fan.
   *
   * The angle is relative to the held mark, not a frozen world point, so a
   * mark that moves takes its fan with it — but G6 moving a node does not by
   * itself ask a custom path to recompute.
   *
   * Not while an end is still nucleating. A body part-way into its arrival has
   * no position yet, `getEndpoints` throws on the nulls, and the throw lands in
   * the spread field's own `requestAnimationFrame` where nothing catches it —
   * so selecting a mark while its neighbours were still arriving took the fan
   * down with it. Skipping is free: the arrival ends in a draw, and the draw
   * asks for this path again.
   */
  public resync() {
    if (!this.placed()) return;
    try {
      // Same attributes, new path: `update` is what makes G6 ask for the key
      // path again. Nothing about the stroke's material is being restated.
      super.update({ ...this.attributes });
    } catch {
      // `placed()` asks the graph where the ends are; G6 resolves them against
      // the node *elements*, and the two disagree for a frame around a draw.
      // The fan is a rest pose — losing one frame of it costs nothing, and the
      // next draw restates it.
    }
  }

  /** Whether both ends have a position the path can actually be drawn between. */
  private placed(): boolean {
    try {
      const graph = this.context.graph;
      const edge = graph?.getEdgeData(this.elementId());
      if (!edge) return false;
      for (const end of [String(edge.source), String(edge.target)]) {
        const at = graph.getElementPosition(end);
        if (!at || !Number.isFinite(at[0]) || !Number.isFinite(at[1])) return false;
      }
      return true;
    } catch {
      return false;
    }
  }

  /**
   * The held mark's centre, and how far its rim sits from it.
   *
   * Read from the graph rather than stored, because the endpoint G6 hands the
   * path is already clipped to whatever shape the mark is — a disc's radius, a
   * plate's edge — and the fan has to leave from that same rim or the stroke
   * would start inside the mark it belongs to.
   */
  private origin(held: Vec): { x: number; y: number; radius: number } | null {
    try {
      const graph = this.context.graph;
      const edge = graph?.getEdgeData(this.elementId());
      if (!edge || !this.fan) return null;
      const heldId =
        this.fan.fromSource === true ? String(edge.source) : String(edge.target);
      const [x, y] = graph.getElementPosition(heldId);
      if (!Number.isFinite(x) || !Number.isFinite(y)) return null;
      const radius = Math.hypot(held[0] - x, held[1] - y);
      return { x, y, radius: radius > 1 ? radius : 12 };
    } catch {
      return null;
    }
  }

  /**
   * Where G6 says this stroke's two ends are, or nothing.
   *
   * `getEndpoints` resolves the endpoint against the *node element*, not
   * against stored data, and it throws outright — "Vectors could not operate
   * due to different dimensions" — whenever that element cannot answer: a body
   * still nucleating, or one being replaced by the draw currently running.
   *
   * Thrown from `getKeyPath` it took down whatever asked for the path: a whole
   * `transitionCanvasData` frame, or the spread field's own
   * `requestAnimationFrame`, where nothing catches it and the fan simply
   * stopped. A stroke whose ends are unknown for one frame is not an error —
   * it is a stroke with nothing to draw yet, and the draw that places those
   * ends will ask again.
   */
  private endpoints(
    attributes: Required<BaseEdgeStyleProps>,
  ): [Vec, Vec] | null {
    let ends: [Vec, Vec] | null = null;
    try {
      ends = this.getEndpoints(attributes) as [Vec, Vec];
    } catch {
      ends = null;
    }
    const usable = (point: Vec | undefined | null): point is Vec =>
      Boolean(point) && Number.isFinite(point![0]) && Number.isFinite(point![1]);
    if (ends && usable(ends[0]) && usable(ends[1])) return ends;
    /**
     * The clipped end failed; the mark's own centre has not.
     *
     * `getConnectionPoint` resolves against the node *element*'s bounds, and
     * those can be empty for a frame — around a draw, or while a body is still
     * nucleating — even though the graph knows exactly where the mark is. Seen
     * directly: `getEndpoints` answering `[[null, null, null], [363, -6, 0]]`
     * for an edge whose source `getElementPosition` reports at
     * `[156.1, 143.6, 0]`.
     *
     * Falling back to the centre draws the chord a little long — it starts at
     * the middle of the disc rather than its rim — which is visibly a stroke
     * in roughly the right place, and self-corrects the moment the bounds come
     * back. Drawing nothing would be a filament silently missing from a claim
     * that exists, and throwing took the whole frame down.
     */
    const graph = this.context.graph;
    const edge = graph?.getEdgeData(this.elementId());
    if (!edge) return null;
    const centre = (id: string): Vec | null => {
      try {
        const at = graph.getElementPosition(id);
        return usable(at as unknown as Vec) ? ([at[0], at[1]] as Vec) : null;
      } catch {
        return null;
      }
    };
    const from = usable(ends?.[0]) ? ends![0] : centre(String(edge.source));
    const to = usable(ends?.[1]) ? ends![1] : centre(String(edge.target));
    return from && to ? [from, to] : null;
  }

  /** The three points the fanned stroke runs through, or null when it is straight. */
  private vertices(
    attributes: Required<BaseEdgeStyleProps>,
  ): { src: Vec; elbow: Vec; tgt: Vec } | null {
    const fan = this.fan;
    if (!fan || fan.amount < 0.01) return null;
    const ends = this.endpoints(attributes);
    if (!ends) return null;
    const [source, target] = ends;
    const held = fan.fromSource ? source : target;
    const far = fan.fromSource ? target : source;
    const origin = this.origin(held);
    if (!origin) return null;
    const ux = Math.cos(fan.angle);
    const uy = Math.sin(fan.angle);
    const rim = mixPoint(
      held,
      [origin.x + ux * origin.radius, origin.y + uy * origin.radius],
      fan.amount,
    );
    const elbow = mixPoint(
      stationOnChord(held, far, fan.along),
      [
        origin.x + ux * (origin.radius + fan.along),
        origin.y + uy * (origin.radius + fan.along),
      ],
      fan.amount,
    );
    return fan.fromSource
      ? { src: rim, elbow, tgt: target }
      : { src: source, elbow, tgt: rim };
  }

  protected getKeyPath(attributes: Required<BaseEdgeStyleProps>): PathArray {
    const ends = this.endpoints(attributes);
    // A lone move-to draws nothing — not even the dot a zero-length line with
    // a round cap would leave behind.
    if (!ends) return [["M", 0, 0]] as PathArray;
    const [source, target] = ends;
    const points = this.vertices(attributes);
    if (!points) {
      return [
        ["M", source[0], source[1]],
        ["L", target[0], target[1]],
      ];
    }
    return [
      ["M", points.src[0], points.src[1]],
      ["L", points.elbow[0], points.elbow[1]],
      ["L", points.tgt[0], points.tgt[1]],
    ];
  }

  public render(
    attributes: Required<BaseEdgeStyleProps> = this.parsedAttributes,
    container: Group = this,
  ) {
    super.render(attributes, container);
    const roles = (attributes as unknown as { roleEnds?: RoleEnds | null }).roleEnds ?? null;
    const ends = roles ? this.endpoints(attributes) : null;
    const bent = ends ? this.vertices(attributes) : null;
    const placed = [true, false].map((fromSource) => {
      const role = roles ? (fromSource ? roles.source : roles.target) : null;
      if (!roles || !role || !ends) return null;
      const rim = bent ? (fromSource ? bent.src : bent.tgt) : ends[fromSource ? 0 : 1];
      const toward = bent ? bent.elbow : ends[fromSource ? 1 : 0];
      const dx = toward[0] - rim[0];
      const dy = toward[1] - rim[1];
      const len = Math.hypot(dx, dy);
      if (!(len > 1e-6)) return null;
      const ux = dx / len;
      const uy = dy / len;
      // The plate's half-extent along the stroke, so its near edge — not its
      // centre — keeps the gap.
      const extent = (role.width / 2) * Math.abs(ux) + (roles.height / 2) * Math.abs(uy);
      const along = roles.gap + extent;
      return { role, rim, ux, uy, along, reach: along + extent, len };
    });
    // A name must stay on its own end's side of the other: two that meet
    // cover each other, and one past the other reads as the wrong end's. On a
    // straight stroke both share one leg; a fan gives each end its own.
    const [head, tail] = placed;
    const crowded = !bent && head && tail && head.reach + tail.reach > head.len;
    for (const [index, end] of placed.entries()) {
      const key = index === 0 ? "role-source" : "role-target";
      if (!roles || !end || crowded || end.reach > end.len) {
        this.upsert(key, Label, false, container);
        continue;
      }
      const { role, rim, ux, uy, along } = end;
      const label = this.upsert(
        key,
        Label,
        {
          x: rim[0] + ux * along,
          y: rim[1] + uy * along,
          text: role.text,
          fontFamily: roles.fontFamily,
          fontSize: roles.fontSize,
          fontWeight: roles.fontWeight,
          fill: roles.fill,
          textAlign: "center",
          textBaseline: "middle",
          dy: roles.dy,
          wordWrap: false,
          background: true,
          backgroundFill: roles.ground,
          backgroundOpacity: 1,
          backgroundLineWidth: 0,
          backgroundRadius: roles.radius,
          backgroundWidth: role.width,
          backgroundHeight: roles.height,
          padding: roles.padding,
          pointerEvents: "none",
        } as LabelStyleProps,
        container,
      );
      holdPlate(label as Label | undefined, roles.dy);
    }
  }

  protected getKeyStyle(attributes: Required<BaseEdgeStyleProps>) {
    const style = super.getKeyStyle(attributes);
    // The stroke must not steal the pointer from discs or from a label sitting
    // beside it. The edge element stays in the picker tree; only the key path
    // opts out — see `getLabelStyle`.
    return { ...style, pointerEvents: "none" as const };
  }

  protected getLabelStyle(
    attributes: Required<BaseEdgeStyleProps>,
  ): false | LabelStyleProps {
    const attrs = this.placedLabel(attributes) as Record<string, unknown>;
    // G6's loop-label branch clears all offsets, collapsing parallel names
    // onto the same apex. Keep its native loop path/apex, but apply the same
    // authored stack offsets as every other canonical filament.
    const self = attrs.loop && this.sourceNode === this.targetNode;
    const style = super.getLabelStyle((self
      ? { ...attrs, loop: false, labelPlacement: 0.5 }
      : attrs) as Required<BaseEdgeStyleProps>);
    if (!style) return false;

    const shown = Number(attrs.labelOpacity ?? 0) > 0.01;
    let next: LabelStyleProps = style;
    if (typeof attrs.labelFill === "string") {
      next = { ...next, fill: attrs.labelFill };
    }

    if (!shown) return next;

    // Same contract as AmbientLinkageEdge: the stroke refuses the pointer,
    // so any label that is actually drawn must take it.
    return {
      ...next,
      pointerEvents: "auto" as const,
      cursor: "pointer" as const,
    };
  }

  protected drawLabelShape(
    attributes: Required<BaseEdgeStyleProps>,
    container: Group,
  ) {
    this.upsert("knockout", Rect, this.knockoutStyle(attributes), container);
    super.drawLabelShape(attributes, container);
    holdPlate(this.getShape<Label>("label"), Number((attributes as { labelDy?: unknown }).labelDy ?? 0));
    this.paintBundleInk(attributes);
  }

  /**
   * The background extended to the stroke — see `KNOCKOUT_PAST_LINE_PX`.
   *
   * Upserted before the label so it paints between the stroke and the plate:
   * over the line it must break, under the name it must not touch. Never
   * removed, only faded — re-adding would append it past the label and bury
   * the name in its own background. One rect, over the plate's own span too:
   * both wear the same opaque coat, so the overlap is invisible and the
   * notch and the plate read as one.
   */
  private knockoutStyle(attributes: Required<BaseEdgeStyleProps>) {
    const attrs = attributes as unknown as Record<string, unknown>;
    const hidden = {
      x: 0,
      y: 0,
      width: 0,
      height: 0,
      fill: "#000000",
      fillOpacity: 0,
      lineWidth: 0,
      pointerEvents: "none" as const,
    };
    if (!(Number(attrs.labelOpacity) > 0.01)) return hidden;
    const fill = attrs.labelBackgroundFill;
    const opacity = Number(attrs.labelBackgroundOpacity);
    const w = Number(attrs.labelBackgroundWidth);
    const h = Number(attrs.labelBackgroundHeight);
    if (typeof fill !== "string" || !(opacity > 0) || !(w > 0) || !(h > 0)) {
      return hidden;
    }
    // A stacked plate draws no tab. Its siblings stand in the same air the
    // tab would bridge — measured, two 12px tabs overlapping 0.8px and
    // joining the plates into one slab, and an outer tab reaching past an
    // inner sibling paints across that sibling's plate. The stack's own gap
    // is the air the cards were promised; the line shows in it honestly,
    // and each plate still breaks the span the stroke actually crosses.
    // Lone plates keep their bridge. A drawing that cannot be asked keeps
    // today's tab.
    try {
      const edges = (this.context.graph as Graph).getEdgeData() as Array<{
        id?: unknown;
        source?: unknown;
        target?: unknown;
        style?: { labelOpacity?: unknown };
      }>;
      const self = edges.find((edge) => edge.id === this.elementId());
      if (
        self !== undefined &&
        typeof self.source === "string" &&
        typeof self.target === "string" &&
        hasNamedPairSibling(edges, this.elementId(), self.source, self.target)
      ) {
        return hidden;
      }
    } catch {
      // Fall through to today's tab.
    }
    const ends = this.endpoints(attributes);
    if (!ends) return hidden;
    const bent = this.vertices(attributes);
    const legs: [Vec, Vec][] = bent
      ? [
          [bent.src, bent.elbow],
          [bent.elbow, bent.tgt],
        ]
      : [[ends[0], ends[1]]];
    const ratio = Number(
      (this.placedLabel(attributes) as unknown as Record<string, unknown>)
        .labelPlacement,
    );
    const ox = Number(attrs.labelOffsetX ?? 0);
    const oy = Number(attrs.labelOffsetY ?? 0);
    if (!Number.isFinite(ratio) || !Number.isFinite(ox) || !Number.isFinite(oy)) {
      return hidden;
    }
    const anchor = strokePointAt(legs, ratio);
    const px = anchor[0] + ox;
    const py = anchor[1] + oy;
    const { q, ux, uy } = nearestOnStroke(legs, [px, py]);
    // The stroke already crosses the plate: its opaque background breaks
    // the line across its own span and there is nothing left for a tab to
    // do. Drawing one anyway stood past the plate as a nub on every lone
    // name in both rooms.
    if (
      q[0] >= px - w / 2 &&
      q[0] <= px + w / 2 &&
      q[1] >= py - h / 2 &&
      q[1] <= py + h / 2
    ) {
      return hidden;
    }
    const past = KNOCKOUT_PAST_LINE_PX;
    // Narrow along the stroke, long across it: the tab's own width is a
    // plate-height slot, so the bridge notches its station instead of
    // swallowing the span. Tilt widens the slot — an axis-aligned tab
    // covers a diagonal stroke only as far as its width reaches across
    // the slope — continuously, so nothing pops as a drag turns the line
    // under it.
    //
    // One-sided, toward the line: the far side would stand past the plate
    // covering nothing, the way the old air did. Stacked plates never
    // reach here — they return above — so no min/max is needed to keep
    // siblings off each other's side of the line row.
    const flat = Math.abs(ux) >= Math.abs(uy);
    const major = flat ? Math.abs(ux) : Math.abs(uy);
    const minor = flat ? Math.abs(uy) : Math.abs(ux);
    const tilt = major > 1e-6 ? Math.min(1, minor / major) : 1;
    const alongHalf = h / 2 + Math.hypot(q[0] - px, q[1] - py) * tilt;
    let x0: number;
    let x1: number;
    let y0: number;
    let y1: number;
    if (flat) {
      x0 = px - alongHalf;
      x1 = px + alongHalf;
      y0 = Math.min(py - h / 2, q[1] - past);
      y1 = Math.max(py + h / 2, q[1] + past);
    } else {
      x0 = Math.min(px - w / 2, q[0] - past);
      x1 = Math.max(px + w / 2, q[0] + past);
      y0 = py - alongHalf;
      y1 = py + alongHalf;
    }
    return {
      x: x0,
      y: y0,
      width: Math.max(0, x1 - x0),
      height: Math.max(0, y1 - y0),
      fill,
      fillOpacity: opacity,
      lineWidth: 0,
      pointerEvents: "none" as const,
    };
  }

  public update(attributes: Record<string, unknown>) {
    super.update(attributes);
    this.paintBundleInk(attributes as Required<BaseEdgeStyleProps>);
  }

  /** G6's edge theme paints bond ink; furniture must stay lens ink. */
  private paintBundleInk(attributes: Required<BaseEdgeStyleProps>) {
    if (!this.elementId().startsWith("bundle:")) return;
    const fill = (attributes as Record<string, unknown>).labelFill;
    const label = this.shapeMap.label as
      | { getShape?: (name: string) => { attr: (style: Record<string, unknown>) => void } }
      | undefined;
    const text = label?.getShape?.("text");
    if (typeof fill === "string" && text) text.attr({ fill });
  }

  /**
   * Keep the plate on the elbow it was fanned to.
   *
   * `labelPlacement` is a ratio of the *whole* path, and the path just grew a
   * corner, so the ratio the mark authored — a fixed distance expressed
   * against a straight chord — no longer lands on the station. Restating it as
   * the elbow's own share of the path is what makes the name travel with the
   * stroke instead of sliding down it.
   *
   * Only when the plate is on the held side. A bond whose name is stationed at
   * the *other* end — the pointer is on that disc while this one is selected —
   * is not what the fan moved, and dragging its name to this end would be the
   * canvas answering a question nobody asked. The offsets are left alone
   * either way: they are the stack that keeps parallel claims apart.
   */
  private placedLabel(attributes: Required<BaseEdgeStyleProps>) {
    const fan = this.fan;
    const points = this.vertices(attributes);
    if (!fan || !points) return attributes;
    const authored = Number(attributes.labelPlacement);
    if (!Number.isFinite(authored)) return attributes;
    // On the midpoint counts as held: a short spoke's station clamps to half
    // its filament, so its name stands at exactly 0.5 — which is the middle,
    // not the other end, and pins it out of the fan under a strict test.
    const onHeldSide = fan.fromSource ? authored <= 0.5 : authored >= 0.5;
    if (!onHeldSide) return attributes;
    const first = Math.hypot(
      points.elbow[0] - points.src[0],
      points.elbow[1] - points.src[1],
    );
    const second = Math.hypot(
      points.tgt[0] - points.elbow[0],
      points.tgt[1] - points.elbow[1],
    );
    const total = first + second;
    if (!(total > 1)) return attributes;
    return { ...attributes, labelPlacement: first / total };
  }

  /**
   * Where the name stands on the drawn stroke, in graph space.
   *
   * The share `placedLabel` settled on, measured down the path G6 draws —
   * the chord, or the two legs through the elbow — plus the label's own
   * graph-space offsets. A plate opening onto this bond lands here, so the
   * line appears to open where its name stood rather than at a midpoint a
   * fan has left behind. Readable whether or not the name is showing: a
   * crowded label still has a station.
   */
  public labelAnchor(): { x: number; y: number } | null {
    const attributes = this.attributes as Required<BaseEdgeStyleProps>;
    const ends = this.endpoints(attributes);
    if (!ends) return null;
    const points = this.vertices(attributes);
    const path: Vec[] = points
      ? [points.src, points.elbow, points.tgt]
      : [ends[0], ends[1]];
    const placed = this.placedLabel(attributes) as { labelPlacement?: unknown };
    const share = Number(placed.labelPlacement);
    if (!Number.isFinite(share)) return null;
    const legs: number[] = [];
    for (let i = 0; i + 1 < path.length; i += 1) {
      legs.push(Math.hypot(path[i + 1][0] - path[i][0], path[i + 1][1] - path[i][1]));
    }
    const total = legs.reduce((sum, leg) => sum + leg, 0);
    if (!(total > 0)) return { x: path[0][0], y: path[0][1] };
    let along = Math.min(Math.max(share, 0), 1) * total;
    let at: Vec = path[0];
    for (let i = 0; i < legs.length; i += 1) {
      const leg = legs[i];
      const from = path[i];
      const to = path[i + 1];
      if (along <= leg || i === legs.length - 1) {
        const u = leg > 0 ? Math.min(Math.max(along / leg, 0), 1) : 0;
        at = [from[0] + (to[0] - from[0]) * u, from[1] + (to[1] - from[1]) * u];
        break;
      }
      along -= leg;
    }
    const offsetX = Number(attributes.labelOffsetX ?? 0);
    const offsetY = Number(attributes.labelOffsetY ?? 0);
    return {
      x: at[0] + (Number.isFinite(offsetX) ? offsetX : 0),
      y: at[1] + (Number.isFinite(offsetY) ? offsetY : 0),
    };
  }
}

export type FilamentFanPatch = FilamentFan & { id: string };

/** Apply the frame's fans. Strokes G6 has already retained are not touched. */
export function updateFilamentFans(graph: Graph, patches: FilamentFanPatch[]) {
  const edges = rendered.get(graph);
  if (!edges) return 0;
  let updated = 0;
  for (const patch of patches) {
    const edge = edges.get(patch.id);
    if (!edge || edge.destroyed) continue;
    const next =
      patch.amount > 0.01
        ? {
            amount: patch.amount,
            angle: patch.angle,
            along: patch.along,
            fromSource: patch.fromSource,
          }
        : null;
    if (edge.hasFan(next)) continue;
    edge.setFan(next);
    updated += 1;
  }
  return updated;
}

/**
 * The drawn centre of an edge's name, or null when it cannot be read.
 *
 * Asked of the renderer rather than re-derived, because the fan is renderer
 * state: only the stroke knows where its elbow took the name. Null when the
 * edge is gone or its ends are unknown for this frame — the caller keeps
 * whatever seat the store gave the plate.
 */
export function filamentLabelAnchor(
  graph: Graph,
  id: string,
): { x: number; y: number } | null {
  const edge = rendered.get(graph)?.get(id);
  if (!edge || edge.destroyed) return null;
  try {
    return edge.labelAnchor();
  } catch {
    return null;
  }
}

/** Put every stroke back on its chord, without waiting out an animation. */
export function clearFilamentFans(graph: Graph) {
  const edges = rendered.get(graph);
  if (!edges) return 0;
  let cleared = 0;
  for (const edge of edges.values()) {
    if (edge.destroyed) continue;
    if (edge.hasFan(null)) continue;
    edge.setFan(null);
    cleared += 1;
  }
  return cleared;
}

let registered = false;

export function ensureWorldFilamentRegistered() {
  if (registered) return;
  register(ExtensionCategory.EDGE, WORLD_FILAMENT_EDGE, WorldFilament);
  registered = true;
}
