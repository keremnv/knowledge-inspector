/**
 * The graph's design DNA — one source for how graph matter looks.
 *
 * These values are the Graph DNA workbench's defaults. They live here rather
 * than inside that page so a second surface cannot quietly ship a *stale* copy
 * of the look, which is exactly how the ambient canvas and the workbench
 * drifted apart. Anything drawing graph matter should read from here.
 *
 * The language, briefly: a gray field, nodes as solid discs of the
 * darkest ink with their label set *inside* them in the field colour, and edges
 * as thin filaments of the same ink. Weight comes from fill, not from stroke.
 *
 * The workbench is where this language is *authored*, and it reads these
 * exports rather than keeping its own copy — the two were byte-identical and
 * staying in sync only by luck, which is the drift this module exists to stop.
 * The workbench still owns the knobs that are its own: focus tokens, motion,
 * gravity, drag and selection.
 */

import * as radixColors from "@radix-ui/colors";

export type RadixScaleId = keyof typeof radixColors | "black";
export type RadixToken = { scale: RadixScaleId; step: number };
export type ThemeMode = "light" | "dark";

/** Shorthand for a scale+step pair. Exported so no surface re-declares it. */
export const token = (scale: RadixScaleId, step: number): RadixToken => ({
  scale,
  step,
});

export type GraphDnaTheme = {
  /** Page chrome behind the canvas. */
  surface: RadixToken;
  /** The field the graph sits on. */
  canvas: RadixToken;
  /** Edge filaments. */
  filament: RadixToken;
  /** Node fill. */
  node: RadixToken;
  /** Node label, set inside the node. */
  nodeLabel: RadixToken;
  /** Chip / label backing. */
  chip: RadixToken;
  /** Secondary label ink. */
  lensLabel: RadixToken;
  /** Emphasised label ink. */
  bondLabel: RadixToken;
};

export type GraphDnaFocusTheme = {
  field: RadixToken;
  lit: RadixToken;
  dimNode: RadixToken;
  dimEdge: RadixToken;
  litLabel: RadixToken;
  dimLabel: RadixToken;
  chip: RadixToken;
  lensLabel: RadixToken;
  bondLabel: RadixToken;
};

export const GRAPH_DNA_THEME: Record<ThemeMode, GraphDnaTheme> = {
  light: {
    // Step 2, not step 3. A mark that reflects light has to rest below full
    // strength, and what it rests *against* sets how much of that reading
    // survives: on a step 3 ground a disc at 0.78 and the same disc at 0.84
    // were four levels apart, which is nothing. A lighter field is not a
    // lighter look — it is the room the third law needs to be seen at all.
    surface: token("gray", 2),
    canvas: token("gray", 2),
    filament: token("gray", 12),
    node: token("gray", 12),
    nodeLabel: token("gray", 2),
    chip: token("gray", 2),
    lensLabel: token("gray", 9),
    bondLabel: token("gray", 12),
  },
  dark: {
    surface: token("slateDark", 1),
    canvas: token("slateDark", 1),
    filament: token("slateDark", 11),
    node: token("slateDark", 11),
    nodeLabel: token("slateDark", 1),
    // The chip is a *knockout*, not a card: it exists so a label reads over the
    // filaments crossing under it, which means it has to be the field exactly.
    // Shipping step 3 against a step 1 canvas drew a visible plate behind every
    // edge label — chips stay the field colour in both rooms.
    chip: token("slateDark", 1),
    lensLabel: token("slateDark", 9),
    bondLabel: token("slateDark", 12),
  },
};

/**
 * Muted matter — semantic material that is not yet settled.
 *
 * Unsettled material still has to stay legible; what it must never do is read
 * as settled. The move is
 * therefore *within* the scale rather than out of it: the field comes up one
 * step, matter comes down one or two, and the gap between them narrows.
 * Everything is still the same gray in the same room — the graph just has less
 * presence in it.
 *
 * Matter sat two to three steps down at first and read as fog rather than as a
 * state: legibility is the whole reason to open this surface, so the mute has
 * to be the smallest one that still cannot be mistaken for settled material.
 * It is a step gentler than it was.
 *
 * Done as a palette rather than as `opacity` on the stage, which is what this
 * replaced. Opacity fades a whole subtree including its labels and any focus
 * state drawn over it, so a lit answer on a construction came out fainter than
 * unlit matter on a settled World — the emphasis inverted. A palette moves
 * the resting look and leaves every state that is drawn *on top* at full
 * strength.
 */
export const GRAPH_DNA_PROVISIONAL_THEME: Record<ThemeMode, GraphDnaTheme> = {
  light: {
    surface: token("gray", 4),
    canvas: token("gray", 4),
    filament: token("gray", 10),
    node: token("gray", 11),
    // The label sits inside the disc, so it tracks the field, not the ink.
    nodeLabel: token("gray", 4),
    chip: token("gray", 4),
    lensLabel: token("gray", 9),
    bondLabel: token("gray", 11),
  },
  dark: {
    surface: token("slateDark", 2),
    canvas: token("slateDark", 2),
    filament: token("slateDark", 9),
    node: token("slateDark", 10),
    nodeLabel: token("slateDark", 2),
    chip: token("slateDark", 2),
    lensLabel: token("slateDark", 9),
    bondLabel: token("slateDark", 11),
  },
};

/**
 * Ledger focus is a separate reading state, not the ambient dark theme. The
 * field inverts so a subject set can be read as one bounded object while the
 * rest of the committed graph remains present as quiet context.
 *
 * Greyscale on purpose, even though ambient dark is slate: if both rooms used
 * the same family, asking a question would look like dimming the lights. The
 * field is off-scale black rather than grayDark 1, so it cannot share a colour
 * with slateDark 1. Lit matter and dim context stay on grayDark; only the
 * paper leaves the scale.
 */
export const GRAPH_DNA_FOCUS: GraphDnaFocusTheme = {
  field: token("black", 1),
  lit: token("grayDark", 12),
  dimNode: token("grayDark", 3),
  dimEdge: token("grayDark", 4),
  litLabel: token("grayDark", 1),
  dimLabel: token("grayDark", 10),
  chip: token("black", 1),
  lensLabel: token("grayDark", 8),
  bondLabel: token("grayDark", 9),
};

/**
 * Product chrome — shell, panels, rules, type.
 *
 * Here rather than beside individual components because the World canvas is
 * the visual source:
 * chrome is the same ink and the same paper as node matter, one step apart on
 * the same Radix scale, and that relationship is the thing worth keeping. The
 * shell reads these on every render, so one palette controls what actually
 * ships.
 *
 * This used to be stated twice — as hex in shell styles and as separate tokens
 * — and the two had already drifted. Keeping the palette here gives the
 * inspector one source for chrome contrast and status colour.
 */
export type GraphDnaChrome = {
  canvas: RadixToken;
  panel: RadixToken;
  ink: RadixToken;
  inkMuted: RadixToken;
  rule: RadixToken;
};

/** Shell chrome tokens — kept in step with graph matter on the same Radix scales. */
export const GRAPH_DNA_CHROME: Record<ThemeMode, GraphDnaChrome> = {
  light: {
    // Moved with the field above, and for the same reason. Chrome that stayed
    // at step 3/4 would have been darker than the canvas it frames.
    canvas: token("gray", 2),
    panel: token("gray", 3),
    ink: token("gray", 12),
    inkMuted: token("gray", 9),
    rule: token("gray", 6),
  },
  dark: {
    canvas: token("slateDark", 1),
    panel: token("slateDark", 2),
    ink: token("slateDark", 12),
    inkMuted: token("slateDark", 9),
    rule: token("slateDark", 6),
  },
};

/**
 * Muted chrome — the shell around unsettled semantic material.
 *
 * Same move as the matter palette and it has to be applied together: chrome
 * one step quieter under an unchanged map would read as a rendering fault
 * rather than as a state. Ink drops from the scale's text step to its readable
 * step, and the field rises, so the whole surface loses contrast without
 * anything becoming hard to read.
 */
export const GRAPH_DNA_PROVISIONAL_CHROME: Record<ThemeMode, GraphDnaChrome> = {
  light: {
    canvas: token("gray", 4),
    panel: token("gray", 5),
    ink: token("gray", 11),
    inkMuted: token("gray", 8),
    rule: token("gray", 5),
  },
  dark: {
    canvas: token("slateDark", 2),
    panel: token("slateDark", 3),
    ink: token("slateDark", 11),
    inkMuted: token("slateDark", 8),
    rule: token("slateDark", 5),
  },
};

/**
 * The three things colour is allowed to mean.
 *
 * The map is monochrome because geometry and weight carry meaning there, so
 * colour would be decoration. A queue is not a map: which decisions are on fire
 * is the first thing an operator needs, and colour earns its place by encoding
 * a state that changes what you do. Three states, and adding a fourth is a
 * design decision that has to be made here.
 *
 * These lived as six hex literals inside an older review stylesheet, from when
 * Review was the only surface with status to report. Two things broke that:
 *
 *   The nav now reports the same "waiting for you" in the top bar. A value that
 *   means one thing in two places has to *be* one value, or it drifts into two
 *   — which is the failure `GRAPH_DNA_CHROME` was written for, after
 *   `--ink-muted` was declared as hex in one place and a Radix token in
 *   another and the workbench spent a release tuning a value nothing used.
 *
 *   Hand-mixed hex has no theme. The literals were picked against a light
 *   panel and never changed for dark, so a correction that runs one way ran the
 *   wrong way on half the product. Radix's step 11 is the readable-text step of
 *   its scale in both modes, which is exactly the guarantee that was missing.
 *
 * One step for fill and text alike. The old pair — a fill and a darkened form
 * of it for small type — existed because the two were mixed by hand and the
 * fill was unreadable at 0.6rem; a step engineered for text is legible as both,
 * and one token cannot disagree with itself.
 */
export type GraphDnaStatus = {
  /** Waiting on this operator. */
  attention: RadixToken;
  /** Something failed and is blocking. */
  alarm: RadixToken;
  /** Decided; no longer demanding. */
  settled: RadixToken;
};

export const GRAPH_DNA_STATUS: Record<ThemeMode, GraphDnaStatus> = {
  light: {
    attention: token("orange", 11),
    alarm: token("tomato", 11),
    settled: token("jade", 11),
  },
  dark: {
    attention: token("orangeDark", 11),
    alarm: token("tomatoDark", 11),
    settled: token("jadeDark", 11),
  },
};

/** The status tokens as CSS custom properties, ready to spread onto a root. */
export function statusCssVariables(
  status: GraphDnaStatus,
): Record<string, string> {
  return {
    "--attention": radixValue(status.attention),
    "--alarm": radixValue(status.alarm),
    "--settled": radixValue(status.settled),
  };
}

/** The chrome tokens as CSS custom properties, ready to spread onto a root. */
export function chromeCssVariables(
  chrome: GraphDnaChrome,
): Record<string, string> {
  return {
    "--canvas": radixValue(chrome.canvas),
    "--panel": radixValue(chrome.panel),
    "--ink": radixValue(chrome.ink),
    "--ink-muted": radixValue(chrome.inkMuted),
    "--rule": radixValue(chrome.rule),
  };
}

/**
 * The focus palette as CSS, for the canvas's inverted reading state.
 *
 * Named `--focus-*` and never spelled as hex in a stylesheet, for the reason
 * `GRAPH_DNA_CHROME` exists. The inspector does not read these directly: it
 * uses the shell's `--canvas` / `--ink`, which the World shell remaps onto this
 * palette when the map inverts. Wiring the inspector at `--focus-*` while the map was still
 * light put dark-room ink on a light field.
 */
export function focusCssVariables(
  focus: GraphDnaFocusTheme,
): Record<string, string> {
  return {
    "--focus-field": radixValue(focus.field),
    "--focus-ink": radixValue(focus.lit),
    "--focus-ink-muted": radixValue(focus.dimLabel),
    "--focus-rule": radixValue(focus.dimEdge),
    "--focus-on-ink": radixValue(focus.litLabel),
  };
}

/**
 * Geometry and weight. Defaults match the Graph DNA workbench shipping look:
 * ~90px discs, 11px node type at 80% width, quieter filaments and spokes.
 */
export const GRAPH_DNA_GEOMETRY = {
  nodeDiameter: 90,
  nodeLine: 1,
  labelSize: 11,
  /** Percentage of the node diameter the label may occupy. */
  labelMaxWidth: 80,
  /** Optical centring correction for a label inside a node, in pixels. */
  labelBaselineNudge: 2,
  /** Multiple of the label size between wrapped lines. */
  labelLineHeight: 1.15,
  /** Lines a node label may wrap to before it is elided. */
  labelMaxLines: 2,
  /** The disc itself. Below 1 the field shows through node matter. */
  nodeFillOpacity: 1,
  /**
   * What a mark rests at, so that light has somewhere to take it.
   *
   * A disc used to be drawn at full strength, which meant the light law could
   * not touch it: `reflected` adds a share of what is *left*, and nothing was
   * left. Every visible lift was happening on the filaments, which are one
   * pixel wide.
   *
   * Lower than it sounds, because a mark is an area and a filament is a line.
   * A disc moving four levels of grey reads louder than a hairline moving
   * twelve, so equal numbers here would not be equal to a person.
   */
  nodeAlbedo: 0.78,
  /** The name inside the disc, independent of the disc. */
  nodeLabelOpacity: 1,
  edgeWidth: 1,
  edgeOpacity: 0.5,
  edgeLabelSize: 9,
  /** The relation chip on a lit edge, independent of the line under it. */
  edgeLabelOpacity: 1,
  /**
   * What a spoke keeps at rest, as a fraction of the opacity it would have had.
   * See `spokeDimOf` in the product canvas for why spokes are a class at all.
   */
  spokeRestOpacity: 0.05,
  dottedGap: 6.5,
};

/**
 * The assertion chip — how a relation tuple is drawn.
 *
 * The map has two marks now. A **disc** is a referent: a thing the world can
 * name. A **chip** is an assertion: one tuple of one named relation. Those are
 * different kinds of claim and they must not share a shape, or a ternary
 * `acceptable_replacement` reads as a fourth part.
 *
 * The chip is not new matter. It is the relation label that already appears on
 * a lit filament, promoted to something that can stand on its own. A binary
 * tuple keeps its chip on the line; a tuple with three or more roles cannot,
 * so the chip steps off and each role becomes its own spoke. Same word, same
 * plate, two positions — which is what makes "a binary edge is shorthand for an
 * assertion" a thing the reader watches happen rather than a rule they are
 * told. `chipPadding` therefore matches the edge label's, and moving one
 * without the other is how the two stop being the same object.
 *
 * Construction origin is geometry here, not colour. The map is monochrome
 * because weight and shape carry meaning on it; `GRAPH_DNA_STATUS` is spent on
 * an operator queue, and a World has no queue. So:
 *
 *   MECHANICAL   knockout chip — the field colour, ink text, quiet
 *   SEMANTIC     ink-filled chip, text knocked out — weight comes from fill,
 *                and an authored assertion is the expensive one
 *   DERIVED      a shelf under the chip: it visibly rests on its inputs, and
 *                the shelf is the handle that opens them
 *   UNRESOLVED   the chip's outline with nothing in it, and dotted spokes —
 *                the shape of the assertion exists, the content does not
 *
 * Staleness is deliberately absent from this list. It is a property of a whole
 * relation in the World storage layer (`is_stale(relation)`), not of one tuple, so a per-chip
 * mark would claim a precision the store does not have. A stale relation's
 * matter renders in `GRAPH_DNA_PROVISIONAL_THEME` instead — the palette that
 * already means "present, legible, not to be treated as settled".
 */
export const GRAPH_DNA_CHIP = {
  /** Chip plate height. Sized from the label, not the disc. */
  chipHeight: 10,
  /** Horizontal breathing room inside the plate, per side. */
  chipPaddingX: 4,
  /**
   * Vertical padding — none.
   *
   * The plate's height is stated outright rather than grown from the label, so
   * padding here would be counted twice. At this size the chip is a rule with a
   * word in it, which is the register the map wants: quieter than the disc it
   * names a bond between.
   */
  chipPaddingY: 0,
  /**
   * Corner radius — zero, and the zero is the point.
   *
   * Nothing on this map is rounded. The disc is a circle because a referent is
   * a mass; every straight edge in the product, from the panel rules to the
   * shell, is square. A chip with a radius reads as a *tag* — a decoration
   * applied to something — where a square plate reads as a piece of the same
   * drawing. The knob stays because a lab that cannot try the other answer is
   * not a lab, but the answer is 0.
   */
  chipRadius: 0,
  /**
   * Relation name inside the chip.
   *
   * Below the edge label's 9, not above it. Relation names in this world are
   * long — `acceptable_replacement` is 22 characters — and a plate wide enough
   * to hold one at 10px starts competing with the discs for the field.
   */
  chipLabelSize: 7,
  /**
   * Label weight, matching the map's.
   *
   * The product canvas draws node labels at 400 — regular, not semibold — and
   * Jost at 400 is already a sharp geometric face. A chip set heavier than the
   * discs around it would claim the assertion is louder than the things it
   * relates, which is exactly backwards: the referents are the matter.
   */
  chipLabelWeight: 400,
  /** The plate's own outline, when it has one (mechanical, unresolved). */
  chipLine: 1,
  /**
   * Optical centring for the word inside the plate, in pixels, added to the
   * measured correction.
   *
   * The plate is centred on the glyphs' own ink box rather than on the font's
   * em square — an underscore descends and a cap does not, so a relation name
   * centred by the box sits high. `chipLabelNudge` is the residue a human can
   * still see after that, and it should stay near zero; a large value here
   * means the measurement is wrong, not the type.
   */
  chipLabelNudge: 0,
  /**
   * The shelf under a derived chip.
   *
   * Measured from the *word*, not from the plate: the shelf says "this rests on
   * something", and it reads as support for the name rather than as a second
   * edge of the box when it runs the length of the text plus a little air.
   * `shelfOverhang` is that air, per side.
   */
  shelfGap: 2,
  shelfLine: 0.5,
  shelfOverhang: 2,
  /**
   * A role spoke: the filament from a referent to the assertion it fills a
   * role in.
   *
   * Not the same class as `spokeRestOpacity`, which holds back structural
   * noise at 0.05. A role spoke is the opposite of noise — it is the assertion's
   * own anatomy, and an n-ary tuple drawn at 5% would be an unreadable claim.
   * It is quieter than a filament at rest and no quieter than that.
   */
  roleSpokeWidth: 1,
  roleSpokeOpacity: 0.5,
  /**
   * The role name on a focused spoke.
   *
   * The same size as the relation name: no hierarchy by size. The kind
   * distinction is the face — roles are set in the mono while relations
   * stay in the sans — and nothing else. See `roleWidth`.
   */
  roleLabelSize: 7,
  /**
   * The loaded mono face. Only 400 ships for the monos, so this is not the
   * place to order roles below relations by thinning them.
   */
  roleLabelWeight: 400,
  /**
   * Where the role name sits along its spoke, 0 at the referent and 1 at the
   * chip.
   *
   * A role is a slot in the assertion, which argues for the chip end. Three
   * names converging there collide, which argues for the middle. Left at the
   * middle until a real neighborhood says otherwise — this is the kind of value
   * that only a crowded canvas can settle.
   */
  roleLabelAt: 0.5,
  /**
   * Whether a collapsed binary chip is legible before you touch anything.
   *
   * The ambient map hides relation names until focus, which is what keeps it a
   * field rather than a diagram. A schema view is a dozen chips and naming
   * them is the entire point. So this is decided by zoom level, not by a
   * preference: false at referent zoom, true at schema zoom.
   */
  namedAtRest: false,
};

/** Approved physical/interaction defaults shared by lab and product canvas. */
export const GRAPH_DNA_INTERACTION = {
  hoverRadius: 140,
  hoverResponse: 180,
  gravityStrength: 220,
  gravityTravel: 8.6,
  absorbPull: 2.18,
  gripScale: 0.9,
  dragNodeRelief: 0.25,
  dragEdgeLoad: 0.3,
  dragEdgePresence: 0.08,
  selectionSpeed: 8,
  /**
   * The air between a disc and the beads that ring it.
   *
   * A disc only. There is no plate equivalent, and the absence is the point:
   * a plate has a border of its own, so its ants take it over rather than
   * standing off it. Any number here would be a second rectangle around the
   * first, which is what the pair of them used to look like.
   */
  selectionClearance: 11,
  selectionDotGap: 4.5,
  selectionLine: 1.5,
  /**
   * Whether the selection ring arrives and leaves, rather than appearing.
   *
   * The product ran with motion off wholesale, and one flag covered two things
   * that are not alike. Animating *canvas elements* means G6 interpolating
   * every element that differs — measured at 2000 nodes as a **2.09 second
   * block with no frame painted**, and that stays off.
   *
   * The ring is not a canvas element. It is a single screen-space SVG driven
   * by the Web Animations API, so its cost is one element's opacity and scale
   * and does not move when the graph grows. It is also the one piece of motion
   * that carries meaning: a selection that fades in is a thing that *became*
   * selected, where one that blinks into place is indistinguishable from a
   * redraw.
   *
   * Timings come from the same `MotionPlans` as everything else — emit on the
   * way in, absorb on the way out — so it is tunable on the DNA motion lab
   * beside the parameters it shares.
   */
  selectionMotion: true,
} as const;

export function radixValue(value: RadixToken): string {
  // Not a Radix step. Focus's paper sits off the scale so it cannot share a
  // colour with slateDark 1, which is the ambient dark field.
  if (value.scale === "black") return "#000000";
  const palette = radixColors[value.scale] as unknown as Record<string, string>;
  const stem = String(value.scale).replace("Dark", "");
  return (
    palette[`${stem}${value.step}`] ??
    (radixColors.gray as Record<string, string>).gray12
  );
}

export type ResolvedGraphDna = Record<keyof GraphDnaTheme, string>;
export type ResolvedGraphDnaFocus = Record<keyof GraphDnaFocusTheme, string>;

export function resolveGraphDna(mode: ThemeMode = "light"): ResolvedGraphDna {
  return Object.fromEntries(
    Object.entries(GRAPH_DNA_THEME[mode]).map(([key, value]) => [
      key,
      radixValue(value as RadixToken),
    ]),
  ) as ResolvedGraphDna;
}

/** The provisional matter palette, resolved. Never a workbench knob: the
 * workbench authors the shipping look, and a construction is a state of a
 * graph rather than a second look to tune. */
export function resolveGraphDnaProvisional(
  mode: ThemeMode = "light",
): ResolvedGraphDna {
  return Object.fromEntries(
    Object.entries(GRAPH_DNA_PROVISIONAL_THEME[mode]).map(([key, value]) => [
      key,
      radixValue(value as RadixToken),
    ]),
  ) as ResolvedGraphDna;
}

export function resolveGraphDnaFocus(): ResolvedGraphDnaFocus {
  return Object.fromEntries(
    Object.entries(GRAPH_DNA_FOCUS).map(([key, value]) => [
      key,
      radixValue(value as RadixToken),
    ]),
  ) as ResolvedGraphDnaFocus;
}

/**
 * Read a colour this module may have produced, not only one it was given.
 *
 * `mixHex` returns `rgb(r, g, b)`, and the graph styles legitimately nest it —
 * "the resting stroke, then tinted towards the bond ink". A hex-only reader
 * cannot read its own output: `hexToRgb("rgb(238, 238, 238)")` took `"rg"` and
 * `"b("` as hex digits and returned `[NaN, 11, …]`, so the mix came out as
 * `rgb(NaN, 11, 35)`.
 *
 * That failure was invisible in the worst way. Assigning an invalid colour to
 * a canvas `strokeStyle` is *silently ignored* — the context keeps whatever it
 * was last set to — so focus-mode edges were drawn in a stale near-black on a
 * near-black field rather than in `dimEdge`. Nothing threw, nothing warned, and
 * the map simply lost its filaments.
 *
 * Returns null rather than a guess: a colour we cannot read must not be
 * silently replaced by one we invented.
 */
function readColor(value: string): [number, number, number] | null {
  const text = value.trim();

  const rgb = text.match(
    /^rgba?\(\s*([\d.]+)[\s,]+([\d.]+)[\s,]+([\d.]+)/i,
  );
  if (rgb) {
    const channels = [Number(rgb[1]), Number(rgb[2]), Number(rgb[3])];
    if (channels.every(Number.isFinite)) {
      return channels as [number, number, number];
    }
    return null;
  }

  if (!text.startsWith("#")) return null;
  const digits = text.slice(1);
  // #rgb, #rgba, #rrggbb, #rrggbbaa — alpha is dropped: these mixes are about
  // ink, and opacity is carried separately by the renderer.
  const full =
    digits.length === 3 || digits.length === 4
      ? digits
          .slice(0, 3)
          .split("")
          .map((c) => c + c)
          .join("")
      : digits.slice(0, 6);
  if (full.length !== 6 || !/^[0-9a-f]{6}$/i.test(full)) return null;
  return [
    parseInt(full.slice(0, 2), 16),
    parseInt(full.slice(2, 4), 16),
    parseInt(full.slice(4, 6), 16),
  ];
}

/**
 * Blend two colours. Used to tint node matter without leaving the language.
 *
 * Named `mixHex` for its callers' sake, but it accepts anything `readColor`
 * reads — including its own `rgb(...)` output, which is what nested mixes hand
 * it. An unreadable input yields that input unchanged rather than a fabricated
 * colour, so a mistake shows up as "this did not tint" instead of as matter
 * drawn in a colour nobody chose.
 */
export function mixHex(from: string, to: string, amount: number): string {
  const a = readColor(from);
  const b = readColor(to);
  if (!a || !b) return from;
  const t = Math.max(0, Math.min(1, amount));
  return `rgb(${Math.round(a[0] + (b[0] - a[0]) * t)}, ${Math.round(
    a[1] + (b[1] - a[1]) * t,
  )}, ${Math.round(a[2] + (b[2] - a[2]) * t)})`;
}
