/**
 * The schema graph — a World's vocabulary as a picture.
 *
 * This is §7.1, and it is the only whole-World view the spec allows: a schema
 * is a dozen relations no matter how many tuples they hold, so it is safe to
 * draw entire where an extension never is. It answers the first question a
 * person has — *what kind of world is this?* — before they have anything to
 * search for.
 *
 * The same projection rule runs here as at instance level, which is what makes
 * the zoom feel like zoom rather than like four different applications: two
 * referent roles collapse onto a filament with the relation's chip on it, three
 * or more stand the chip on the field with a spoke per role, and a scalar role
 * never becomes a node at all. `projectionOf` decides, once, for both.
 *
 * Layout is deterministic and computed here rather than forced. The graph is
 * five kind discs and twenty chips; a force pass would settle somewhere
 * different on every load, and a schema that rearranges itself when you reopen
 * it is a schema you cannot learn the shape of. Kinds sit on a ring, and each
 * relation sits at the centroid of the kinds it connects, pushed off along the
 * perpendicular when several relations share the same pair — which is what
 * keeps `listing_of` and `offered_by` from landing on top of each other.
 * One or two kinds are not a ring but an axis, and the axis lies along the
 * landscape with the first kind leftmost — see `ringPositions`.
 */

import type { WorldRelation, WorldRole } from "../api/world";
import { ringPositions } from "./schemaRing";
import {
  bondFilament,
  bondLabelLayout,
  bondLabelStep,
  chipNode,
  chipKindOf,
  chipWidth,
  discNode,
  discRim,
  filamentEdge,
  plateRim,
  projectionOf,
  shelfNode,
  spokeEdge,
  spokeFilament,
  spokeLabelStation,
  SPOKE_LABEL_ALONG_PX,
  type ChipKind,
  type MarkParams,
  type Paint,
} from "./marks";
import { unsettled } from "./show";

export type SchemaLayout = {
  /** Relations with no place on the canvas: scalar properties of one kind. */
  fields: Map<string, WorldRelation[]>;
  data: { nodes: unknown[]; edges: unknown[] };
};

type Point = { x: number; y: number };

/** How far apart relations that connect the same kinds are pushed. */
const SIBLING_SPREAD = 46;
/** Clearance between a disc and the first relation hanging off it alone. */
const SATELLITE_GAP = 54;
/** Air between the closest chips of neighbouring tiers, measured along the
 * march. Tiers clear by projected chip extent plus this — not by a fixed
 * pitch, which only clears when the march runs across the chips' short side.
 * A fixed 26px pitch stacked wide chips on any near-horizontal ray.
 * See `fanSatellites`. */
const SATELLITE_TIER_GAP = 10;
/** Edge-to-edge air between two neighbours on one fan row. */
const SATELLITE_LATERAL_GAP = 14;
/** How far a fan row may reach either side of its ray. At the first tier's
 * distance this is about 60° off the outward ray, and the nearest neighbouring
 * disc sits more than 90° off it at every ring size — so one kind's fan
 * cannot reach another kind's disc. */
const SATELLITE_ARC_HALF = 170;
/** The same reach for a degenerate ring. Wider rows mean fewer tiers, and on
 * a two-kind axis tiers are what make the picture wide: thirteen satellites
 * at 170 pack 6/6/1 — the lone third tier costs a hundred pixels for one
 * chip — while at 300 they pack 7/6. About 72° off the ray at the first
 * tier; only used where a fan's sole neighbour sits at 180°, so the >90°
 * rule it bends never binds. Sized with room to spare, because measured chip
 * widths shift a few pixels with the fonts behind them. */
const SATELLITE_ARC_HALF_SMALL = 300;

function kindOf(role: { kinds?: string[] }): string | null {
  return role.kinds && role.kinds.length ? role.kinds[0] : null;
}

/** Construction origin decides the plate; derived still gets the shelf.
 *
 * A relation carries the origins of every tuple under it, so the test is
 * whether any of them was adjudicated, not whether all of them were: one human
 * verdict in a relation is the fact worth seeing from the schema, and reading
 * it as machine-made because its neighbours were is the error that matters.
 *
 * Exported because the reader header names the same fact in words, and a
 * panel that disagreed with the canvas beside it would be worse than either.
 */
export function chipKind(relation: WorldRelation): ChipKind {
  return chipKindOf(relation.origins);
}

/**
 * The rules a chip carries: a shelf under a derivation, a crown over a human
 * verdict. Both can be true of one relation, and the two are the same shape
 * mirrored, so they are emitted from one place rather than tested twice.
 */
function furniture(
  relation: WorldRelation,
  kind: ChipKind,
  at: Point,
  paint: Paint,
  params: MarkParams,
): unknown[] {
  const marks: unknown[] = [];
  const plate = `rel:${relation.name}`;
  if (relation.mode === "DERIVED") {
    marks.push(
      shelfNode(`shelf:${plate}`, at.x, at.y, relation.name, paint, params),
    );
  }
  if (kind === "adjudicated") {
    marks.push(
      shelfNode(
        `crown:${plate}`,
        at.x,
        at.y,
        relation.name,
        paint,
        params,
        "over",
      ),
    );
  }
  return marks;
}

/**
 * The kind a scalar property belongs to, or null when it is not one.
 *
 * §5.4: a scalar property of one kind is a card field, not a node — and a
 * relation with no kinded roles at all has no disc to hang from either, so it
 * is reported under "—" rather than dropped silently. The layout and the kind
 * panel both read this, so what the panel lists is what the canvas withheld.
 */
export function fieldOwner(relation: WorldRelation): string | null {
  const referentRoles = relation.roles.filter((role) => role.referent);
  const projection = projectionOf(relation.arity, relation.referent_arity);
  const roleKinds = referentRoles
    .map((role) => kindOf(role))
    .filter((kind): kind is string => Boolean(kind));
  if (projection !== "field" && roleKinds.length) return null;
  return roleKinds[0] ?? "—";
}

/**
 * The shared filament a base binary's name rides, or null when it rides none.
 *
 * A bond is drawn as its name on the filament and nothing else — no chip, no
 * plate anywhere else — so parallel bonds share one physical stroke and stack
 * their plates at its midpoint, in declaration order. The key names that
 * stroke. Derived and adjudicated binaries are chipped, not filament-drawn,
 * and a bond whose two roles resolve to one disc hangs beside it instead, so
 * neither takes a seat here. Read twice — once to count the seats, once to
 * take them — so the stack knows its middle before it is drawn.
 */
function filamentPairKey(relation: WorldRelation): string | null {
  const projection = projectionOf(relation.arity, relation.referent_arity);
  if (projection !== "bond") return null;
  if (relation.mode === "DERIVED" || chipKind(relation) === "adjudicated") {
    return null;
  }
  const roleKinds = relation.roles
    .filter((role) => role.referent)
    .map((role) => kindOf(role))
    .filter((kind): kind is string => Boolean(kind));
  if (roleKinds.length !== 2 || roleKinds[0] === roleKinds[1]) return null;
  return [...roleKinds].sort().join("|");
}

/** Every referent namespace the schema mentions, in a stable order. */
export function kindsIn(relations: WorldRelation[]): string[] {
  const seen = new Set<string>();
  for (const relation of relations) {
    for (const role of relation.roles) {
      const kind = kindOf(role);
      if (kind) seen.add(kind);
    }
  }
  return [...seen].sort();
}


function centroid(points: Point[]): Point {
  if (!points.length) return { x: 0, y: 0 };
  return {
    x: points.reduce((sum, p) => sum + p.x, 0) / points.length,
    y: points.reduce((sum, p) => sum + p.y, 0) / points.length,
  };
}

/**
 * Build the schema canvas.
 *
 * `stalePaint` is handed in rather than decided here: an unsettled relation
 * (stale, or a completeness receipt that is not COMPLETE) renders in that
 * palette, and which palette that is belongs to the theme, not to the
 * projection.
 */
/**
 * Which relations stand on each kind.
 *
 * Read off the same `kindOf` the layout uses, so a canvas asking "what is on
 * this disc" and the layout asking "where does this relation hang" cannot come
 * to different answers about the same role.
 */
export function relationsByKind(
  relations: WorldRelation[],
): Map<string, string[]> {
  const out = new Map<string, string[]>();
  for (const relation of relations) {
    for (const role of relation.roles) {
      if (!role.referent) continue;
      const kind = kindOf(role);
      if (!kind) continue;
      const standing = out.get(kind);
      if (standing) {
        if (!standing.includes(relation.name)) standing.push(relation.name);
      } else {
        out.set(kind, [relation.name]);
      }
    }
  }
  return out;
}

type Satellite = {
  relation: WorldRelation;
  referentRoles: WorldRole[];
  roleKinds: string[];
  projection: ReturnType<typeof projectionOf>;
  disc: Point;
};

/**
 * A kind's own relations, fanned beside its disc.
 *
 * These used to march out along the outward ray, indexed per kind-set — so
 * two relations that shared the disc but not the key took the same index and
 * landed on exactly the same point. Every stacked chip on the vocabulary was
 * one of those. The fan indexes per disc instead, and lays rows across the
 * ray rather than stations along it: a chip joins the row it fits on, or
 * starts the next tier out, in declaration order. Rows are centred on the ray
 * and stepped by measured chip width, so neighbours clear by the gap; tiers
 * clear by each tier's projected chip extent along the march plus the gap,
 * which is what keeps wide chips apart on a horizontal ray as well as a
 * vertical one. One satellite sits exactly where the march put it.
 */
function fanSatellites(
  hanging: Satellite[],
  params: MarkParams,
  arcHalf: number,
): Array<[Satellite, Point]> {
  if (!hanging.length) return [];
  const disc = hanging[0].disc;
  const radius = Math.hypot(disc.x, disc.y);
  // The ray away from the middle of the ring. A disc at the middle has no
  // such ray; straight up keeps its relations off it rather than on it.
  const outward =
    radius > 1
      ? { x: disc.x / radius, y: disc.y / radius }
      : { x: 0, y: -1 };
  const across = { x: -outward.y, y: outward.x };

  const rows: Satellite[][] = [[]];
  let used = 0;
  for (const satellite of hanging) {
    const width = chipWidth(satellite.relation.name, params);
    const row = rows[rows.length - 1];
    const claim = width + (row.length ? SATELLITE_LATERAL_GAP : 0);
    if (row.length && used + claim > arcHalf * 2) {
      rows.push([satellite]);
      used = width;
    } else {
      row.push(satellite);
      used += claim;
    }
  }

  // How far a chip reaches along the march: its half width and half throw
  // (chip plus furniture) projected onto the ray — exact for an
  // axis-aligned rect, which a chip is.
  const halfThrow =
    params.chipHeight / 2 + params.shelfGap + params.shelfLine;
  const reach = (width: number) =>
    (width / 2) * Math.abs(outward.x) + halfThrow * Math.abs(outward.y);
  const widthsByRow = rows.map((row) =>
    row.map((satellite) => chipWidth(satellite.relation.name, params)),
  );
  // Each tier starts where the last tier's chips end, plus air. The first
  // tier keeps the disc clearance it always had.
  const distances: number[] = [
    params.discDiameter / 2 + SATELLITE_GAP,
  ];
  for (let tier = 1; tier < rows.length; tier += 1) {
    const before = Math.max(...widthsByRow[tier - 1].map(reach));
    const after = Math.max(...widthsByRow[tier].map(reach));
    distances.push(distances[tier - 1] + before + after + SATELLITE_TIER_GAP);
  }

  const placed: Array<[Satellite, Point]> = [];
  rows.forEach((row, tier) => {
    const widths = widthsByRow[tier];
    const span =
      widths.reduce((sum, width) => sum + width, 0) +
      SATELLITE_LATERAL_GAP * (row.length - 1);
    const distance = distances[tier];
    let lateral = -span / 2;
    row.forEach((satellite, index) => {
      const centre = lateral + widths[index] / 2;
      lateral += widths[index] + SATELLITE_LATERAL_GAP;
      placed.push([
        satellite,
        {
          x: Math.round(
            disc.x + outward.x * distance + across.x * centre,
          ),
          y: Math.round(
            disc.y + outward.y * distance + across.y * centre,
          ),
        },
      ]);
    });
  });
  return placed;
}

export function schemaLayout(
  relations: WorldRelation[],
  paint: Paint,
  stalePaint: Paint,
  params: MarkParams,
  options: {
    namedAtRest: boolean;
    focused: string | null;
    /**
     * Relations to name because a person is looking at something they are on.
     *
     * Bonds need none of it: a binary relation is drawn as its name on a
     * filament and nothing else, so its name is permanent — an unnamed bond
     * would be an invisible claim. What this lights is the role plates on the
     * spokes: hovering a kind names the roles of the relations that stand on
     * it, which is what the field has always done for a disc and its claims.
     */
    lit?: ReadonlySet<string>;
  },
): SchemaLayout {
  const kinds = kindsIn(relations);
  const positions = ringPositions(kinds);
  const nodes: unknown[] = [];
  const edges: unknown[] = [];
  /**
   * Strokes below plates: every line paints a layer under every name, so no
   * stroke ever crosses a label — see `PAINT_LAYER_STROKE`. Collected during
   * the loop, prepended at the return, so the born order stays layered too.
   */
  const strokes: unknown[] = [];
  const fields = new Map<string, WorldRelation[]>();

  for (const kind of kinds) {
    const at = positions.get(kind)!;
    nodes.push(discNode(`kind:${kind}`, at.x, at.y, kind, paint, params));
  }

  // Parallel bonds share one filament, so their plates stack at its
  // midpoint — in declaration order, centred on the proven-vertical step.
  // Counted before the loop, so each seat knows the stack's middle.
  const bondSeats = new Map<string, number>();
  for (const relation of relations) {
    const key = filamentPairKey(relation);
    if (key) bondSeats.set(key, (bondSeats.get(key) ?? 0) + 1);
  }
  const bondPlaced = new Map<string, number>();
  // Relations that connect the same kinds get pushed apart along the
  // perpendicular of the line between them, in the order they are declared.
  const occupancy = new Map<string, number>();
  // Relations hung off one disc alone wait for the fan: a satellite's slot
  // depends on its neighbours' widths, so they are placed together, per disc,
  // after the loop — in declaration order, like everything else here.
  const satellites = new Map<string, Satellite[]>();

  for (const relation of relations) {
    const owner = fieldOwner(relation);
    if (owner !== null) {
      // Still reported, so the panel can list what a kind carries — dropping
      // it silently would make the canvas look like the whole vocabulary.
      fields.set(owner, [...(fields.get(owner) ?? []), relation]);
      continue;
    }

    const referentRoles = relation.roles.filter((role) => role.referent);
    const projection = projectionOf(relation.arity, relation.referent_arity);
    const roleKinds = referentRoles
      .map((role) => kindOf(role))
      .filter((kind): kind is string => Boolean(kind));

    const anchors = roleKinds.map((kind) => positions.get(kind)!).filter(Boolean);
    const base = centroid(anchors);

    // Two *distinct* anchors make a line to hang the chip on. One anchor — or
    // two that resolve to the same disc, which is what `candidate_replacement`
    // (part→part) does — has no line, and placing the chip at the centroid puts
    // it inside the disc. Those hang outside it instead, gathered by the fan
    // below, so a kind's own relations sit beside it rather than on it.
    const [first, second] = anchors;
    const spread = anchors.length >= 2 ? { x: second.x - first.x, y: second.y - first.y } : null;
    const distinct = spread && Math.hypot(spread.x, spread.y) > 1;

    if (!distinct || !spread) {
      const anchor = roleKinds[0];
      const disc = positions.get(anchor);
      if (disc) {
        const hanging = satellites.get(anchor) ?? [];
        hanging.push({ relation, referentRoles, roleKinds, projection, disc });
        satellites.set(anchor, hanging);
      }
      continue;
    }

    const key = [...roleKinds].sort().join("|");
    const index = occupancy.get(key) ?? 0;
    occupancy.set(key, index + 1);
    const length = Math.hypot(spread.x, spread.y);
    // Alternate sides so a pair with several relations fans rather than
    // marching off in one direction.
    const step = Math.ceil(index / 2) * SIBLING_SPREAD * (index % 2 === 0 ? 1 : -1);
    emit(
      relation,
      referentRoles,
      roleKinds,
      projection,
      true,
      {
        x: Math.round(base.x + (-spread.y / length) * step),
        y: Math.round(base.y + (spread.x / length) * step),
      },
    );
  }

  // Wider rows on a degenerate ring: tiers march along the axis there, so
  // fewer tiers is a less elongated picture. A true ring keeps its rows.
  const arcHalf =
    kinds.length <= 2 ? SATELLITE_ARC_HALF_SMALL : SATELLITE_ARC_HALF;
  for (const hanging of satellites.values()) {
    for (const [satellite, at] of fanSatellites(hanging, params, arcHalf)) {
      emit(
        satellite.relation,
        satellite.referentRoles,
        satellite.roleKinds,
        satellite.projection,
        false,
        at,
      );
    }
  }

  return { fields, data: { nodes, edges: [...strokes, ...edges] } };

  function emit(
    relation: WorldRelation,
    referentRoles: WorldRole[],
    roleKinds: string[],
    projection: ReturnType<typeof projectionOf>,
    distinct: boolean,
    at: Point,
  ): void {
    const chipPaint = unsettled(
      relation.stale,
      relation.completeness?.status ?? null,
    )
      ? stalePaint
      : paint;
    const kind = chipKind(relation);

    if (projection === "bond" && distinct) {
      // The name rides the filament — unless the relation carries furniture,
      // because neither a shelf nor a crown can sit against an edge label.
      // That is the one exception, and it is the only binary drawn detached.
      if (relation.mode === "DERIVED" || kind === "adjudicated") {
        nodes.push(
          chipNode(
            `rel:${relation.name}`,
            at.x,
            at.y,
            relation.name,
            kind,
            chipPaint,
            params,
          ),
          ...furniture(relation, kind, at, chipPaint, params),
        );
        strokes.push(
          bondFilament(
            `${relation.name}:in`,
            `kind:${roleKinds[0]}`,
            `rel:${relation.name}`,
            chipPaint,
            params,
          ),
          bondFilament(
            `${relation.name}:out`,
            `rel:${relation.name}`,
            `kind:${roleKinds[1]}`,
            chipPaint,
            params,
          ),
        );
        return;
      }
      // Permanent, because the name is the only drawing of the claim — and
      // stacked, because parallel bonds share the one filament. The stroke
      // lives on its own edge, drawn before every plate; the first seat
      // names it.
      const key = filamentPairKey(relation);
      const total = key ? (bondSeats.get(key) ?? 1) : 1;
      const seat = key ? (bondPlaced.get(key) ?? 0) : 0;
      if (key) bondPlaced.set(key, seat + 1);
      if (seat === 0) {
        strokes.push(
          bondFilament(
            `filament:${relation.name}`,
            `kind:${roleKinds[0]}`,
            `kind:${roleKinds[1]}`,
            chipPaint,
            params,
          ),
        );
      }
      const middle = (total - 1) / 2;
      const step = bondLabelStep(params);
      edges.push(
        filamentEdge(
          `${relation.name}`,
          `kind:${roleKinds[0]}`,
          `kind:${roleKinds[1]}`,
          chipPaint,
          params,
          {
            label: relation.name,
            named: true,
            kind,
            labelOffsetX: step.x * (seat - middle),
            labelOffsetY: step.y * (seat - middle),
          },
        ),
      );
      return;
    }

    // Three or more referents meeting, or one referent carrying a compound
    // value: either way the plate stands on the field with a spoke per role.
    nodes.push(
      chipNode(
        `rel:${relation.name}`,
        at.x,
        at.y,
        relation.name,
        kind,
        chipPaint,
        params,
      ),
    );
    nodes.push(...furniture(relation, kind, at, chipPaint, params));
    /**
     * Two roles filled by the same kind run the same route, so they stack.
     *
     * `serial_comparison_pair` takes `earlier_action` and `later_action` from
     * the same disc to the same chip. One station puts both names on the same
     * point, and what a reader saw was two of four role names — the other two
     * exactly underneath. This is the stack a filament already gives parallel
     * claims, centred the same way, for the same reason.
     */
    const sharing = new Map<string, number>();
    for (const role of referentRoles) {
      const kind = kindOf(role);
      if (kind) sharing.set(kind, (sharing.get(kind) ?? 0) + 1);
    }
    const step = bondLabelStep(params);
    const placed = new Map<string, number>();
    referentRoles.forEach((role, roleIndex) => {
      const kind = kindOf(role);
      if (!kind) return;
      const disc = positions.get(kind);
      const seat = placed.get(kind) ?? 0;
      placed.set(kind, seat + 1);
      const middle = ((sharing.get(kind) ?? 1) - 1) / 2;
      /**
       * The station, which this canvas was not asking for at all.
       *
       * With no `labelPlacement` every role name fell to `roleLabelAt` — the
       * midpoint — which is the ratio `SPOKE_LABEL_ALONG_PX` exists to avoid:
       * a name that slides along its own spoke as the marks it names move.
       * The far rim is the chip's, because a spoke ends on a plate.
       */
      const station = disc
        ? bondLabelLayout(
            disc,
            at,
            "source",
            { x: step.x * (seat - middle), y: step.y * (seat - middle) },
            params,
            discRim(params),
            plateRim(relation.name, params),
            SPOKE_LABEL_ALONG_PX,
            spokeLabelStation(role.name, params).halfPlate,
            spokeLabelStation(role.name, params).air,
          )
        : null;
      strokes.push(
        spokeFilament(
          `filament:${relation.name}:${role.name}:${roleIndex}`,
          `kind:${kind}`,
          `rel:${relation.name}`,
          chipPaint,
          params,
          {},
        ),
      );
      edges.push(
        spokeEdge(
          `${relation.name}:${role.name}:${roleIndex}`,
          `kind:${kind}`,
          `rel:${relation.name}`,
          chipPaint,
          params,
          {
            role: role.name,
            // The names toggle survived the bonds going permanent: it keeps
            // the role plates, which focus or a looked-at kind also names.
            showRole:
              options.namedAtRest ||
              options.focused === relation.name ||
              Boolean(options.lit?.has(relation.name)),
            labelPlacement: station?.placement,
            labelOffsetX: station?.offsetX,
            labelOffsetY: station?.offsetY,
            bondAlong: station?.along,
          },
        ),
      );
    });
  }
}
