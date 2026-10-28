/**
 * World — the read-side explorer.
 *
 * Two modes over one design language. You land on the **vocabulary**: the
 * schema graph, the only whole-World view rule 9 allows, answering *what kind
 * of world is this?* before you have anything to search for. Finding a referent
 * moves you to the **field**, where a neighborhood is grown one expansion at a
 * time and never rendered whole.
 *
 * Search is client-side against every referent, loaded once. At the largest
 * world we have that is 3,118 rows in about three milliseconds, so a request
 * per keystroke would be slower than holding the list — and a search that
 * cannot be out of date is one less thing to reason about.
 *
 * The inspector reads durable semantic state; construction and interpretation
 * remain in the coding-agent conversation.
 */

import {
  useCallback,
  useEffect,
  useId,
  useMemo,
  useReducer,
  useRef,
  useState,
} from "react";
import {
  worldApi,
  type WorldAssertion,
  type WorldCandidate,
  type WorldDemand,
  type WorldGrounding,
  type WorldObligation,
  type WorldObligationInspection,
  type WorldObligationSummary,
  type WorldOverview,
  type WorldReading,
  type WorldResolutionStatus,
  type WorldReferent,
  type WorldRelation,
  type WorldRole,
  type WorldTuple,
} from "../api/world";
import { ReadingBadge, ReadingQualifier, RelationAttribution, shownMode, shownRevision, verifiedReading } from "./ReadingAttribution";
import { Scalar, scalarKind, scalarText } from "./scalar";
import { ReferentOccurrences } from "./ReferentOccurrences";
import { type ThemeMode } from "../styles/graphDna";
import { useWorldIcon } from "./useWorldIcon";
import { useBrowserTheme } from "./useBrowserTheme";
import {
  DEFAULT_MOTION_PLANS,
  still,
} from "../styles/motion";
import { ShowBand } from "./ShowBand";
import { useFrames } from "./useFrames";
import { ProblemNotice } from "./ProblemNotice";
import {
  TABLES_HANDLE_RESERVE,
  TABLES_WIDTH_DEFAULT,
  worldCameraInsets,
  worldChromeDockVars,
  worldShellStyle,
} from "./worldChrome";
import { DerivationView } from "./DerivationView";
import {
  expansionRequestReducer,
  expansionViewState,
  type ExpansionRequests,
} from "./expansionMachine";
import {
  FrontierTable,
  GovernedObligationTable,
  type GovernedObligation,
  type Obligation,
} from "./FrontierTable";
import { MARK_DEFAULTS } from "./marks";
import { RelationTable } from "./RelationTable";
import { SchemaCanvas } from "./SchemaCanvas";
import { holdsField, readField, writeField } from "./fieldMemory";
import { readShow, writeShow } from "./showMemory";
import { chipKind } from "./schemaGraph";
import { TableBar, type TableChrome } from "./tableChrome";
import { WorldTable } from "./WorldTable";
import {
  WorldCanvas,
  type CanvasSelection,
} from "./WorldCanvas";
import type { CameraInsets } from "./canvasFocus";
import {
  arrange,
  collapse,
  retractExpansion,
  dropMark,
  emptySet,
  expand,
  expansionKey,
  expansionMaterial,
  fieldSize,
  foldingOf,
  open as openBond,
  place,
  placeAll,
  placeDemand,
  restack,
  seed,
  type Arrangement,
  type FieldBond,
  type Point,
  type WorkingSet,
} from "./workingSet";
import { OverlayPanel } from "./WorldOverlay";
import { ReaderAction, ReaderActions, ReaderContent, ReaderHeader } from "./ReaderChrome";
import { ReaderDisclosure } from "./ReaderDisclosure";
import { Instrument } from "./Instrument";
import { chromeClass, useOverlayChrome } from "./worldOverlayChrome";
import { Swap } from "../styles/Swap";
import { useHeld, usePresence } from "../styles/usePresence";
import { useSequencedSwap } from "../styles/useSequencedSwap";
import { useLagging } from "../styles/useLagging";
import { readStoredPanelSize, storePanelSize } from "./WorldResize";
import { useNavigationFocus } from "./useNavigationFocus";
import "../styles/presence.css";
import {
  SHOW_DEFAULT,
  SHOW_LAYERS,
  assertionShown,
  originsLabel,
  relationShown,
  reveal,
  revealSet,
  type ShowLayer,
  type ShowState,
  worldHasClassification,
  worldHasDerivedMode,
} from "./show";
import { occurrenceChip, occurrenceLabel } from "./occurrence";
import "./WorldPage.css";
import "./WorldShell.css";
import "./WorldFinder.css";
import "./WorldReader.css";
import "./WorldCanvas.css";
import "./WorldOverlay.css";
import "./worldOverlayChrome.css";

export function conditionOf(
  stale: boolean,
  completeness: { status: string; universe: string | null } | null,
): string {
  const bits: string[] = [];
  if (stale) bits.push("stale");
  if (completeness && completeness.status !== "COMPLETE") {
    bits.push(
      completeness.universe
        ? `${completeness.status.toLowerCase()} over ${completeness.universe}`
        : completeness.status.toLowerCase(),
    );
  }
  return bits.length ? ` · ${bits.join(" · ")}` : "";
}

export type Directory = { id: string; label: string | null }[];

export function Find({
  directory,
  ask,
  onPick,
}: {
  directory: Directory;
  /**
   * Where to look when the directory is not the whole world.
   *
   * Absent, this box is a filter over an array it can see all of, and an
   * exact miss is a fact. Present, the directory is short and the same
   * question has to go to the plane — the box has not become cleverer, it has
   * stopped answering from a list it was never given in full.
   */
  ask?: (query: string) => Promise<Directory>;
  onPick: (id: string, label: string) => void;
}) {
  const [query, setQuery] = useState("");
  const [focused, setFocused] = useState(false);
  const [active, setActive] = useState(0);
  const [asked, setAsked] = useState<Directory>([]);
  const [searchProblem, setSearchProblem] = useState<string | null>(null);
  const rootRef = useRef<HTMLDivElement | null>(null);
  const listId = useId();
  const local = useMemo(() => {
    const needle = query.trim().toLowerCase();
    if (!needle) return [];
    return directory
      .filter(
        (item) =>
          item.id.toLowerCase().includes(needle) ||
          (item.label ?? "").toLowerCase().includes(needle),
      )
      .slice(0, 10);
  }, [directory, query]);
  /**
   * The plane's answer to the same substring, when there is one to ask.
   *
   * Held back by a beat, because this fires on the keystroke rather than on a
   * submit and nobody means the third letter of a word as a question. The
   * generation guard is the ordinary one: an answer to a query nobody is
   * typing any more is not an answer.
   */
  useEffect(() => {
    if (!ask) return;
    const needle = query.trim();
    setSearchProblem(null);
    if (!needle) {
      setAsked([]);
      return;
    }
    let cancelled = false;
    const timer = window.setTimeout(() => {
      void ask(needle)
        .then((found) => {
          if (!cancelled) setAsked(found.slice(0, 10));
        })
        .catch((failure: Error) => {
          if (!cancelled) {
            setAsked([]);
            setSearchProblem(failure.message);
          }
        });
    }, 160);
    return () => {
      cancelled = true;
      window.clearTimeout(timer);
    };
  }, [ask, query]);
  const matches = useMemo(() => {
    if (!ask) return local;
    // What is already in hand, then what the plane added — one list, no
    // duplicates, and the marks the reader could already see stay on top.
    const seen = new Set(local.map((item) => item.id));
    return [...local, ...asked.filter((item) => !seen.has(item.id))].slice(0, 10);
  }, [ask, local, asked]);
  const open = focused && Boolean(query.trim());
  const presence = usePresence(open);

  useEffect(() => setActive(0), [query]);

  useEffect(() => {
    if (!open) return;
    const closeOutside = (event: PointerEvent) => {
      if (rootRef.current?.contains(event.target as Node)) return;
      setFocused(false);
      rootRef.current?.querySelector("input")?.blur();
    };
    document.addEventListener("pointerdown", closeOutside, true);
    return () => document.removeEventListener("pointerdown", closeOutside, true);
  }, [open]);

  const pick = (item: Directory[number]) => {
    onPick(item.id, item.label || item.id);
    setQuery("");
    setFocused(false);
  };

  return (
    <div className="nodefind" ref={rootRef}>
      <input
        className="nodefind__input"
        type="text"
        role="combobox"
        aria-label="Find a referent or field occurrence"
        aria-expanded={open}
        aria-controls={listId}
        aria-autocomplete="list"
        aria-activedescendant={
          open && !searchProblem && matches[active] ? `${listId}-${active}` : undefined
        }
        value={query}
        placeholder="find..."
        onChange={(event) => {
          setQuery(event.target.value);
          setFocused(true);
        }}
        onFocus={() => setFocused(true)}
        onBlur={() => setFocused(false)}
        onKeyDown={(event) => {
          if (event.key === "Escape") {
            event.preventDefault();
            event.stopPropagation();
            setQuery("");
            setFocused(false);
            return;
          }
          if (searchProblem || !matches.length) return;
          if (event.key === "ArrowDown") {
            event.preventDefault();
            setActive((index) => (index + 1) % matches.length);
          } else if (event.key === "ArrowUp") {
            event.preventDefault();
            setActive(
              (index) => (index - 1 + matches.length) % matches.length,
            );
          } else if (event.key === "Enter") {
            event.preventDefault();
            const item = matches[active];
            if (item) pick(item);
          }
        }}
      />
      {presence.mounted ? (
        <ul
          id={listId}
          role="listbox"
          className={`nodefind__list motion-layer motion-layer--fade${presence.shown ? " is-in" : ""}`}
        >
          {/* The list arrives and departs; what is *in* it does not tween.
              Typing another character is a new answer, and animating between
              two answers draws a continuity retrieval does not claim. */}
          {searchProblem ? <li role="presentation"><ProblemNotice message={searchProblem} title="Search unavailable" /></li> : matches.length ? (
            matches.map((item, index) => (
              <li
                key={item.id}
                id={`${listId}-${index}`}
                role="option"
                aria-selected={index === active}
                {...still("answersDoNotTween")}
                className={
                  index === active
                    ? "nodefind__row nodefind__row--active"
                    : "nodefind__row"
                }
                onMouseDown={(event) => {
                  event.preventDefault();
                  pick(item);
                }}
                onMouseEnter={() => setActive(index)}
              >
                <span className="nodefind__label">{item.label || item.id}</span>
                <span className="nodefind__anchor">{item.id}</span>
              </li>
            ))
          ) : (
            <li className="nodefind__row nodefind__row--empty">
              no matches in this search
            </li>
          )}
        </ul>
      ) : null}
    </div>
  );
}

/** Text is supplied metadata, not markup. Preserve explicit empty values. */
function metadataText(value: unknown): string {
  return typeof value === "string" && value !== ""
    ? value
    : JSON.stringify(value, null, 2) ?? String(value);
}

function SourceMetadata({ source }: { source: WorldGrounding }) {
  const fields = [
    ["reference", source.reference],
    ["provider", source.provider],
    ["source revision", source.source_revision],
    ["construction method", source.construction_method],
    ["construction origin", source.construction_origin],
    ["detail text", source.detail_text],
  ] as const;
  return (
    <ReaderDisclosure className="world__source-metadata" label="Source metadata">
      <dl className="reader-metadata">
        {fields.filter(([, value]) => value !== undefined).map(([label, value]) => (
          <div key={label}>
            <dt>{label}</dt>
            <dd><pre>{metadataText(value)}</pre></dd>
          </div>
        ))}
        {source.detail !== undefined ? (
          Object.keys(source.detail).length ? Object.entries(source.detail).map(([key, value]) => (
            <div key={`detail:${key}`}>
              <dt>{key === "derivation_definition" ? "SQL definition" : key === "lineage" ? "lineage (source-reported)" : key}</dt>
              <dd>
                {key === "derivation_definition" && typeof value === "string" ? (
                  <pre><code>{metadataText(value)}</code></pre>
                ) : <pre>{metadataText(value)}</pre>}
              </dd>
            </div>
          )) : <div><dt>detail</dt><dd><pre>{metadataText(source.detail)}</pre></dd></div>
        ) : null}
      </dl>
    </ReaderDisclosure>
  );
}

/** The SOURCE groundings of one subject: a stored row, or a view's definition. */
function SourceList({ sources }: { sources: WorldGrounding[] }) {
  return (
    <ul className="world__grounding">
      {sources.map((item) => (
        <li key={item.reference}>
          {item.native_handle !== undefined ? <b>{metadataText(item.native_handle)}</b> : null}
          {item.native_location !== undefined ? <span>{metadataText(item.native_location)}</span> : null}
          <SourceMetadata source={item} />
        </li>
      ))}
    </ul>
  );
}

/**
 * A referent's own source row, when the producer grounds it. The referent's
 * grounding says where its identity and label were read; it says nothing
 * about the occurrences that mention it, and it is absent (not "none
 * recorded") where the producer supplies none.
 */
function ReferentGrounding({ grounding }: { grounding: WorldGrounding[] }) {
  const sources = grounding.filter((item) => item.kind === "SOURCE");
  if (!sources.length) return null;
  return (
    <section className="world-reader__source" aria-label="Source of this referent">
      <SourceList sources={sources} />
    </section>
  );
}

export function Grounding({ assertion }: { assertion: WorldAssertion }) {
  const sources = assertion.grounding.filter((item) => item.kind === "SOURCE");
  const methods = assertion.grounding
    .filter((item) => item.kind === "WORLD" && item.construction_method)
    .map((item) => item.construction_method as string)
    .filter((method, index, all) => all.indexOf(method) === index);
  const origins = assertion.origins ?? [assertion.origin];
  return (
    <>
      <h3>grounded by</h3>
      {sources.length ? (
        <SourceList sources={sources} />
      ) : (
        <p className="world__note">No source grounding recorded.</p>
      )}
      {methods.length ? (
        <p className="world__note">methods · {methods.join(" · ")}</p>
      ) : null}
      <p className="world__note">origins · {originsLabel(origins)}</p>
    </>
  );
}

export function AssertionPanel({
  assertion,
  reading,
  classified = true,
  problem,
  set,
  folding,
  onFold,
  onTable,
  onDerivation,
  onRemove,
  onClose,
  onBack,
  onSelect,
}: {
  assertion: WorldAssertion | null;
  reading?: WorldReading;
  /** False where no construction origin is recorded: no origin chip. */
  classified?: boolean;
  /** Why the read failed, when it did — the panel owns its failure. */
  problem: string | null;
  /** The field, for the filament roster — fellow claims are field data. */
  set: WorkingSet;
  /** Which way this tuple's second drawing lies, or null if it has none. */
  folding: "open" | "collapse" | null;
  onFold: () => void;
  onTable: (relation: string) => void;
  onDerivation: (relation: string, assertion: string | null) => void;
  /** Null when the shown tuple is not on the field — nothing to take off. */
  onRemove: (() => void) | null;
  onClose: () => void;
  onBack: (() => void) | null;
  onSelect: (next: CanvasSelection) => void;
}) {
  if (!assertion) {
    return (
      <article className="world-reader__article">
        <ReaderHeader
          title={problem ? "Unable to read" : "Reading assertion"}
          onClose={onClose}
          onBack={onBack}
        />
        <ReaderContent>
          {problem ? (
            <ProblemNotice message={problem} title="Unable to read assertion" />
          ) : (
            <p className="world__hint">Reading its roles and grounding…</p>
          )}
        </ReaderContent>
      </article>
    );
  }
  const state = conditionOf(
    assertion.relation_stale,
    assertion.completeness,
  ).replace(/^ · /, "");
  const assessments = new Map(
    assertion.candidate_assessments.map((item) => [item.obligation_id, item]),
  );
  const filament = filamentSiblings(set, assertion.assertion_id);
  return (
    <article className="world-reader__article">
      <ReaderHeader
        title={assertion.relation}
        kind={classified ? originsLabel(assertion.origins ?? assertion.origin).toLowerCase() : undefined}
        stance={occurrenceChip(assertion.occurrence_state)}
        meta={[
          // The generic bridge's BASE and revision 1 are its defaults, not
          // something the database's producer recorded; see ReadingAttribution.
          shownMode(reading, assertion.mode),
          shownRevision(reading, assertion.created_revision) === null
            ? null
            : `revision ${assertion.created_revision}`,
          state || null,
        ].filter(Boolean).join(" · ")}
        onClose={onClose}
        onBack={onBack}
      >
        <ReadingQualifier reading={reading} />
      </ReaderHeader>
      <ReaderContent>
        <RelationAttribution reading={reading} name={assertion.relation} />
        <ol className="world__roles">
          {assertion.roles.map((role) => {
            const value = assertion.values[role.name];
            // A role naming a referent on the field goes back to its disc,
            // the way a link row goes to its claim: same selection, same
            // lookup, so button-ness and disc identity can never disagree
            // about what "on the field" means. Anything else stays a span.
            const target =
              role.referent && typeof value === "string" ? value : null;
            const home = target ? set.referents.get(target) : undefined;
            return (
              <li key={role.name}>
                <b>{role.name}</b>
                {target && home ? (
                  <button
                    type="button"
                    title={target}
                    onClick={() =>
                      onSelect({ kind: "referent", id: target })
                    }
                  >
                    {home.label || target}
                  </button>
                ) : (
                  <span data-value-kind={scalarKind(value)}>
                    <Scalar value={value} />
                  </span>
                )}
              </li>
            );
          })}
        </ol>
        {filament.length ? (
          <section className="world-reader__section world-reader__section--list">
            <h3>On this filament</h3>
            <ul className="gm__list">
              {filament.slice(0, LINK_ROSTER_CAP).map((bond) => (
                <li key={bond.assertion_id}>
                  <button
                    type="button"
                    className={
                      bond.assertion_id === assertion.assertion_id
                        ? "is-selected"
                        : undefined
                    }
                    title={bond.assertion_id}
                    onClick={() =>
                      onSelect({ kind: "assertion", id: bond.assertion_id })
                    }
                  >
                    <span className="gm__list-name">
                      {bond.relation}
                      {bond.scalars.length
                        ? ` · ${summarizeScalars(bond.scalars)}`
                        : ""}
                    </span>
                    <span className="gm__list-meta">
                      {bond.origin.toLowerCase()}
                      {occurrenceLabel(bond.occurrence_state) ? ` · ${occurrenceLabel(bond.occurrence_state)}` : ""}
                      {bond.stale ? " · stale" : ""}
                    </span>
                  </button>
                </li>
              ))}
              {filament.length > LINK_ROSTER_CAP ? (
                <li key="__more">
                  <button
                    type="button"
                    onClick={() => onTable(assertion.relation)}
                  >
                    <span className="gm__list-name">
                      {filament.length - LINK_ROSTER_CAP} more
                    </span>
                    <span className="gm__list-meta">table</span>
                  </button>
                </li>
              ) : null}
            </ul>
          </section>
        ) : null}
        {assertion.derivation?.inputs?.length ? (
          <section className="world-reader__section">
            <h3>Rests on</h3>
            <ul className="world__inputs">
              {assertion.derivation.inputs.map((input) => (
                <li key={input}>{input}</li>
              ))}
            </ul>
          </section>
        ) : null}
        <section className="world-reader__section">
          <Grounding assertion={assertion} />
        </section>
        {assertion.candidate_for.length ? (
          <section className="world-reader__section">
            <h3>Candidate for</h3>
            <ol className="world__roles">
              {assertion.candidate_for.map((obligationId) => {
                const assessment = assessments.get(obligationId);
                const governing = assertion.governing_obligations.includes(obligationId);
                return (
                  <li key={obligationId}>
                    <b>{obligationId}</b>
                    <span>
                      {governing
                        ? "governing"
                        : assessment
                          ? `${assessment.status.toLowerCase()} · ${assessment.warrant_authorities.join(", ") || "authority not recorded"}`
                          : "candidate; not assessed"}
                    </span>
                  </li>
                );
              })}
            </ol>
            {assertion.candidate_assessments.some((item) => item.authority_basis.length) ? (
              <p className="world__note">
                authority basis · {assertion.candidate_assessments
                  .flatMap((item) => item.authority_basis)
                  .map((item) => String(item.source_id || item.authority || "recorded binding"))
                  .filter((item, index, all) => all.indexOf(item) === index)
                  .join(", ")}
              </p>
            ) : null}
          </section>
        ) : null}
      </ReaderContent>
      <ReaderActions>
        {folding ? (
          <ReaderAction onClick={onFold}>
            {folding === "open" ? "Open on the field" : "Fold onto the line"}
          </ReaderAction>
        ) : null}
        {/* Only the backward direction survives here.

            This footer used to carry the derivation table under two names:
            "Why this tuple" for a DERIVED assertion, and "What depends on
            this" for an asserted one. They are not the same offer. The first
            answers a question the tuple itself raises — the machine says this
            holds, on what — and there is nowhere else on the surface to ask
            it. The second is a search for consequences, which is a question
            about the *relation*, is already one click away as `Dependencies`
            on the relation reader, and on an asserted tuple usually answers
            with nothing at all. A bar that offers it on every edge spends its
            width claiming there is something to see. */}
        {assertion.mode === "DERIVED" ? (
          <ReaderAction
            onClick={() =>
              onDerivation(assertion.relation, assertion.assertion_id)
            }
          >
            Why this tuple
          </ReaderAction>
        ) : null}
        <ReaderAction
          onClick={() => onTable(assertion.relation)}
        >
          Open extension
        </ReaderAction>
        {onRemove ? (
          <ReaderAction onClick={onRemove}>
            Take off the field
          </ReaderAction>
        ) : null}
      </ReaderActions>
    </article>
  );
}

/**
 * §8.7, the unresolved inspector.
 *
 * The one thing this panel must never do is read as a denial. A missing
 * positive assertion is not a false one — the world has not been asked, or has
 * been asked and could not answer — so the state line says what is absent, the
 * evidence line says what is not recorded, and neither is dressed as a result.
 *
 * §16 holds here without qualification: no path from this panel to a world
 * tuple, no "resolve this", and nothing to fill in. **The reader reads.**
 *
 * It deliberately has no write controls: semantic interpretation and
 * resolution happen in the conversation and enter a later rebuild.
 */
export function DemandPanel({
  obligation,
  demand,
  problem,
  settled,
  roles,
  onTable,
  onRemove,
  onClose,
  onBack,
}: {
  obligation: Obligation | null;
  demand: WorldDemand | null;
  /** Why the frontier read failed, when it did. */
  problem: string | null;
  /** The frontier read has answered — content, null, or failure. */
  settled: boolean;
  /** Role order, since an obligation's values are a JSON object. */
  roles: string[];
  onTable: (relation: string) => void;
  /** Null when the shown demand is not on the field — nothing to take off. */
  onRemove: (() => void) | null;
  onClose: () => void;
  onBack: (() => void) | null;
}) {
  if (!obligation) {
    return (
      <article className="world-reader__article">
        <ReaderHeader
          title={
            problem
              ? "Unable to read"
              : settled
                ? "Unknown demand"
                : "Reading obligation"
          }
          onClose={onClose}
          onBack={onBack}
        />
        <ReaderContent>
          {problem ? (
            <ProblemNotice message={problem} title="Unable to read demand" />
          ) : settled ? (
            <p className="world__hint">
              This world has no demand with that id.
            </p>
          ) : (
            <p className="world__hint">Reading the demanded tuple…</p>
          )}
        </ReaderContent>
      </article>
    );
  }
  const by = obligation.demanded_by as { name?: string; revision?: number };
  return (
    <article className="world-reader__article">
      <ReaderHeader
        title={obligation.relation}
        kind={obligation.state.toLowerCase()}
        meta="Demanded tuple"
        onClose={onClose}
        onBack={onBack}
      />
      <ReaderContent>
        {/*
          * One fact list, not four headed sections.
          *
          * What this panel is for is a *specific* open question, and the four
          * `<h3>` sections it used to carry printed the same three sentences
          * on every one of them — the epistemology of unresolvedness, the
          * whole purpose statement, the generation rule already standing at
          * the foot of the frontier. A sentence that is identical on every
          * obligation carries no information about the obligation, and the
          * front-end rules call a mark that carries nothing decoration.
          *
          * So the constants are gone: `unresolved` is in the header where the
          * state belongs, and the purpose lives once, on the frontier, where
          * it is a property of the whole demand rather than of this row. What
          * is left is what differs between one obligation and the next — the
          * roles it names, who asked for it, and what it rests on — in the
          * same two-column grid the assertion reader states its facts in.
          */}
        <ol className="world__roles">
          {[
            ...roles.filter((role) => role in obligation.values),
            ...Object.keys(obligation.values).filter(
              (key) => !roles.includes(key),
            ),
          ].map((role) => (
            <li key={role}>
              <b>{role}</b>
              <span><Scalar value={obligation.values[role]} /></span>
            </li>
          ))}
          <li>
            <b>asked by</b>
            <span>
              {by.name ?? demand?.purpose.id ?? "—"}
              {by.revision ? ` · rev ${by.revision}` : ""}
            </span>
          </li>
          {/*
            * The source the requirement failure cites. Kept beside the roles
            * rather than under a heading of its own: it is one more fact about
            * this obligation, and it is the thing a person opens before
            * deciding — a verdict recorded without looking at the evidence is
            * what ADJUDICATED must not become.
            */}
          {obligation.grounding_ref ? (
            <li>
              <b>grounded by</b>
              <span>{obligation.grounding_ref}</span>
            </li>
          ) : null}
        </ol>

        {/*
          * The constructor's own sentence about why this is unresolved, and
          * the only prose on the panel — because it is the only prose that is
          * different for each obligation. It is the difference between
          * "missing" and "the sources do not define PENDING".
          */}
        {obligation.reason ? (
          <p className="world__reason">{obligation.reason}</p>
        ) : null}
      </ReaderContent>
      <ReaderActions>
        <ReaderAction
          onClick={() => onTable(obligation.relation)}
        >
          Open extension
        </ReaderAction>
        {onRemove ? (
          <ReaderAction onClick={onRemove}>
            Take off the field
          </ReaderAction>
        ) : null}
      </ReaderActions>
    </article>
  );
}

function isObligationInspection(
  obligation: WorldObligation | WorldObligationInspection,
): obligation is WorldObligationInspection {
  return "context" in obligation;
}

function obligationStatus(
  obligation: WorldObligation | WorldObligationInspection,
): WorldResolutionStatus | null {
  return obligation.resolution?.status ?? null;
}

function readableStatus(status: WorldResolutionStatus): string {
  return status.toLowerCase().replaceAll("_", " ");
}

function commitmentText(candidate: WorldCandidate): string {
  const roles = candidate.commitment.roles
    .map((role) => `${role.name} = ${scalarText(candidate.commitment.values[role.name])}`)
    .join(", ");
  return `${candidate.commitment.relation}(${roles})`;
}

function CandidateInspection({ candidate }: { candidate: WorldCandidate }) {
  const assessment = candidate.assessment;
  const authorities = assessment?.warrant_authorities ?? [];
  return (
    <article className="world-reader__section">
      <h3>
        {candidate.commitment.commitment_id}
        {candidate.governing ? " · governing" : " · candidate"}
      </h3>
      <p className="world__code">{commitmentText(candidate)}</p>
      <ol className="world__roles">
        <li>
          <b>source grounding</b>
          {candidate.grounding.length ? (
            <ul className="world__grounding">
              {candidate.grounding.map((item, index) => (
                <li key={`${item.reference}:${index}`}>
                  <b>{item.reference}</b>
                  <span>
                    {[item.kind, item.native_handle, item.native_location, item.provider]
                      .filter(Boolean)
                      .join(" · ") || "no further source detail recorded"}
                  </span>
                </li>
              ))}
            </ul>
          ) : (
            <span>No source grounding recorded.</span>
          )}
        </li>
        <li>
          <b>warrant bases</b>
          {candidate.warrant.bases.length ? (
            <ul className="world__grounding">
              {candidate.warrant.bases.map((basis, index) => (
                <li key={`${String(basis.reference ?? basis.kind ?? index)}`}>
                  <span>
                    {basis.kind && basis.reference
                      ? `${String(basis.kind)} · ${String(basis.reference)}`
                      : basis.reference || basis.kind
                        ? String(basis.reference || basis.kind)
                        : "warrant basis without recorded kind or reference"}
                  </span>
                </li>
              ))}
            </ul>
          ) : (
            <span>No warrant basis recorded.</span>
          )}
        </li>
        <li>
          <b>authority</b>
          <span>{authorities.length ? authorities.join(", ") : "not recorded"}</span>
        </li>
        <li>
          <b>origin</b>
          <span>{originsLabel(candidate.warrant.construction_origins)}</span>
        </li>
        <li>
          <b>assessment</b>
          <span>
            {assessment
              ? `${assessment.status.toLowerCase()} · ${assessment.reason}`
              : "not assessed in the persisted resolution"}
          </span>
        </li>
      </ol>
      {assessment?.authority_basis.length ? (
        <p className="world__note">
          authority basis · {assessment.authority_basis
            .map((basis) => String(basis.source_id || basis.authority || "recorded binding"))
            .join(", ")}
        </p>
      ) : null}
    </article>
  );
}

export function GovernedObligationPanel({
  obligation,
  problem,
  onClose,
  onBack,
}: {
  obligation: WorldObligation | WorldObligationInspection;
  problem: string | null;
  onClose: () => void;
  onBack: (() => void) | null;
}) {
  const status = obligationStatus(obligation);
  const detailed = isObligationInspection(obligation);
  const law = obligation.law_provenance;
  const resolution = obligation.resolution;
  const basis = resolution?.resolution_basis ?? [];
  const adjudicated = basis.filter((item) => item.kind === "ADJUDICATION");
  return (
    <article className="world-reader__article">
      <ReaderHeader
        title={obligation.question}
        kind={status ? readableStatus(status) : "resolution not recorded"}
        meta={`${obligation.obligation_id}${obligation.dimension ? ` · ${obligation.dimension}` : ""}`}
        onClose={onClose}
        onBack={onBack}
      />
      <ReaderContent>
        {problem ? <ProblemNotice message={problem} title="Unable to read Obligation" /> : null}
        <section className="world-reader__section">
          <h3>Question</h3>
          <p>{obligation.question}</p>
        </section>

        <section className="world-reader__section">
          <h3>Required by</h3>
          <ol className="world__roles">
            <li>
              <b>law rule</b>
              <span>{obligation.generated_by_rule || "—"}</span>
            </li>
            <li>
              <b>source</b>
              <span>
                {law?.source_id || "—"}
                {law?.source_location ? ` · ${law.source_location}` : ""}
              </span>
            </li>
            {law?.source_excerpt ? (
              <li>
                <b>statement</b>
                <span>{law.source_excerpt}</span>
              </li>
            ) : null}
          </ol>
        </section>

        {obligation.structural_bindings && Object.keys(obligation.structural_bindings).length ? (
          <section className="world-reader__section">
            <h3>Bindings</h3>
            <ol className="world__roles">
              {Object.entries(obligation.structural_bindings).map(([name, value]) => (
                <li key={name}>
                  <b>{name}</b>
                  <span><Scalar value={value} /></span>
                </li>
              ))}
            </ol>
          </section>
        ) : null}

        <section className="world-reader__section">
          <h3>Resolution</h3>
          <p>
            {status === null
              ? "Resolution not recorded."
              : status === "RESOLVED"
                ? resolution?.selected_commitment_id
                  ? `Resolved → ${resolution.selected_commitment_id}`
                  : "Resolved; no selected commitment recorded."
                : status === "NO_CANDIDATE"
                  ? "No candidate answer has been recorded."
                  : status === "INSUFFICIENT_WARRANT"
                    ? "Candidates exist, but none has evidence sufficient to govern."
                    : status === "CONFLICT"
                      ? "Sufficient candidates disagree; no winner is selected."
                      : "More than one compatible sufficient answer remains."}
          </p>
          {resolution?.reason ? <p className="world__reason">{resolution.reason}</p> : null}
          {adjudicated.length ? (
            <p className="world__note">
              Selected by authorized adjudication · {adjudicated
                .map((item) => String(item.adjudication_id || "recorded decision"))
                .join(", ")}
            </p>
          ) : null}
        </section>

        <section className="world-reader__section">
          <h3>Candidates</h3>
          {detailed ? (
            obligation.candidates.length ? (
              obligation.candidates.map((candidate) => (
                <CandidateInspection key={candidate.association_id} candidate={candidate} />
              ))
            ) : (
              <p className="world__note">No candidate Commitment is recorded.</p>
            )
          ) : (
            <ul className="world__inputs">
              {obligation.candidates.length ? obligation.candidates.map((candidate) => (
                <li key={candidate.association_id}>{candidate.commitment_id}</li>
              )) : <li>No candidate Commitment is recorded.</li>}
            </ul>
          )}
        </section>

        {detailed && obligation.adjudications.length ? (
          <section className="world-reader__section">
            <h3>Adjudication</h3>
            {obligation.adjudications.map(({ record, assessment }) => (
              <ol className="world__roles" key={record.adjudication_id}>
                <li>
                  <b>{record.adjudication_id}</b>
                  <span>selected {record.selected_commitment_id}</span>
                </li>
                <li>
                  <b>authority</b>
                  <span>
                    {assessment?.adjudicative_authorities?.join(", ") || "not recorded"}
                  </span>
                </li>
                <li>
                  <b>assessment</b>
                  <span>{assessment ? assessment.status.toLowerCase() : "not assessed"}</span>
                </li>
              </ol>
            ))}
          </section>
        ) : null}

        {detailed ? (
          <section className="world-reader__section">
            <h3>Governing context</h3>
            <ol className="world__roles">
              {Object.entries(obligation.context).map(([name, identity]) => (
                <li key={name}>
                  <b>{name.replaceAll("_", " ")}</b>
                  <span>
                    {identity
                      ? Object.values(identity).join(" @ ")
                      : "not recorded"}
                  </span>
                </li>
              ))}
            </ol>
          </section>
        ) : null}
      </ReaderContent>
    </article>
  );
}

/**
 * How a scalar role's column is typed, without claiming more than the
 * producer said. For SQLite affinity the declared column type comes first:
 * affinity is how SQLite coerces what is stored there, not what any row
 * holds, and a DATETIME column is not a guarantee of dates.
 */
function scalarRoleType(role: WorldRole): string {
  if (role.type_basis !== "sqlite_affinity") return role.type.toLowerCase();
  const declared = role.declared_type ? `declared ${role.declared_type}` : "no declared type";
  return `${declared} · ${role.type.toLowerCase()} affinity`;
}

/**
 * The namespace an id carries, or nothing.
 *
 * This was `id.split(":", 1)[0]`, which returns the *whole string* when there
 * is no colon — so a world that does not namespace its referents put
 * `FDA_RECALL_Z-1814-2024` in a chip sized for the word `part`, printed the id
 * again on the line below, and shouldered `close` out of the header.
 *
 * A referent is thin and carries no type, so `part:C300` saying `part` is the
 * id's own claim and nothing more. Where the id makes no such claim there is
 * nothing to show, and the chip is absent rather than filled with a guess —
 * the same restraint `scope` uses in reporting `null`.
 */
function namespaceOf(id: string): string | undefined {
  const colon = id.indexOf(":");
  return colon > 0 ? id.slice(0, colon) : undefined;
}

export function ReferentPanel({
  detail,
  reading,
  problem,
  set,
  requests,
  onExpand,
  onRetract,
  onTable,
  onDrop,
  onGather,
  onClose,
  onBack,
  onSelect,
}: {
  detail: WorldReferent | null;
  reading?: WorldReading;
  /** Why the read failed, when it did — the panel owns its failure. */
  problem: string | null;
  set: WorkingSet;
  requests: ExpansionRequests;
  onExpand: (relation: string) => void;
  onRetract: (relation: string) => void;
  onTable: (relation: string) => void;
  onDrop: () => void;
  /** Null when nothing on the field is joined to this referent yet. */
  onGather: (() => void) | null;
  onClose: () => void;
  onBack: (() => void) | null;
  onSelect: (next: CanvasSelection) => void;
}) {
  if (!detail) {
    return (
      <article className="world-reader__article">
        <ReaderHeader
          title={problem ? "Unable to read" : "Reading referent"}
          onClose={onClose}
          onBack={onBack}
        />
        <ReaderContent>
          {problem ? (
            <ProblemNotice message={problem} title="Unable to read referent" />
          ) : (
            <p className="world__hint">Reading fields and possible expansions…</p>
          )}
        </ReaderContent>
      </article>
    );
  }
  const groups = referentLinkGroups(set, detail.id);
  // Zero is a count in this reading, not an expansion: nothing to place.
  const present = detail.relations.filter((relation) => relation.count > 0);
  const absent = detail.relations.filter((relation) => relation.count === 0);
  const source = (detail.grounding ?? []).some((item) => item.kind === "SOURCE");
  const qualified = verifiedReading(reading);
  return (
    <article className="world-reader__article">
      <ReaderHeader
        title={detail.label || detail.id}
        kind={namespaceOf(detail.id)}
        // Only when it says something the title does not. An unlabelled
        // referent is its own id, and printing it twice is not identity.
        meta={detail.label ? detail.id : undefined}
        onClose={onClose}
        onBack={onBack}
      >
        {/* Above the rule only what the referent itself is: its identity
            and its own source row. What occurrences say about it, and the
            scalars they state, are listed below as theirs. */}
        {source || qualified ? (
          <div className="world-reader__facts">
            <ReferentGrounding grounding={detail.grounding ?? []} />
            <ReadingQualifier reading={reading} />
          </div>
        ) : null}
      </ReaderHeader>
      <ReaderContent>
        {/* Expand through leads: acting on the field comes before reading it. */}
        <section className="world-reader__section world-reader__section--list">
          <h3>expand through</h3>
          {present.length ? (
          <ul className="gm__list">
            {present.map((relation) => {
              const key = expansionKey(detail.id, relation.name);
              const state = expansionViewState({
                set,
                referentId: detail.id,
                relation: relation.name,
                count: relation.count,
                request: requests.get(key),
              });
              const already = state.value === "on-field";
              const loading = state.value === "loading";
              return (
                <li key={relation.name}>
                  <button
                    type="button"
                    className={already ? "is-selected" : undefined}
                    disabled={loading}
                    aria-busy={loading || undefined}
                    onClick={() =>
                      already
                        ? onRetract(relation.name)
                        : onExpand(relation.name)
                    }
                  >
                    <span className="gm__list-name">{relation.name}</span>
                    <span className="gm__list-meta">
                      {already
                        ? "take off"
                        : loading
                          ? "loading"
                          : state.value === "failed"
                            ? "retry"
                            : relation.count}
                    </span>
                  </button>
                </li>
              );
            })}
          </ul>
          ) : null}
          {absent.length ? (
            <p className="world__note world-reader__absent">
              No recorded occurrences in this reading mention this referent:{" "}
              {absent.map((relation) => relation.name).join(", ")}.
            </p>
          ) : null}
        </section>
        {groups.length ? (
          <section className="world-reader__section world-reader__section--list">
            <h3>on this disc</h3>
            <ul className="gm__list">
              {groups.flatMap((group) => [
                ...group.links.slice(0, LINK_ROSTER_CAP).map((link) => (
                  <li key={link.key}>
                    <button
                      type="button"
                      title={link.occurrence}
                      onClick={() => onSelect(link.select)}
                    >
                      <span className="gm__list-name">
                        {group.relation}
                        {link.occurrence ? <em>{link.occurrence}</em> : null}
                      </span>
                      <span className="gm__list-meta">
                        {link.role} · {link.far || "—"} ·{" "}
                        {link.origin.toLowerCase()}
                        {occurrenceLabel(link.occurrence_state) ? ` · ${occurrenceLabel(link.occurrence_state)}` : ""}
                        {link.stale ? " · stale" : ""}
                      </span>
                    </button>
                  </li>
                )),
                ...(group.links.length > LINK_ROSTER_CAP
                  ? [
                      <li key={`__more:${group.relation}`}>
                        <button
                          type="button"
                          onClick={() => onTable(group.relation)}
                        >
                          <span className="gm__list-name">
                            {group.links.length - LINK_ROSTER_CAP} more
                          </span>
                          <span className="gm__list-meta">
                            table · {group.relation}
                          </span>
                        </button>
                      </li>,
                    ]
                  : []),
              ])}
            </ul>
          </section>
        ) : null}
        <ReferentOccurrences
          detail={detail}
          onOpen={(id) => onSelect({ kind: "assertion", id })}
        />
      </ReaderContent>
      <ReaderActions>
        {onGather ? (
          <ReaderAction onClick={onGather}>
            Gather its neighbours
          </ReaderAction>
        ) : null}
        <ReaderAction onClick={onDrop}>
          Take off the field
        </ReaderAction>
      </ReaderActions>
    </article>
  );
}

const READER_WIDTH_KEY = "ontology-author.worldReaderWidth";
const TABLES_WIDTH_KEY = "ontology-author.worldFrontierWidth";

type TableView =
  | { kind: "world" }
  | { kind: "frontier" }
  | { kind: "governed" }
  | {
      kind: "relation";
      relation: string;
      subject: { id: string; label: string } | null;
    }
  | { kind: "derivation"; relation: string; assertion: string | null };

/** A link from a relation in the vocabulary to its extension. */
function linkedRelationFromHash(): string | null {
  const hash = window.location.hash;
  const query = hash.includes("?") ? hash.slice(hash.indexOf("?") + 1) : "";
  return new URLSearchParams(query).get("relation");
}

/**
 * Whether the selection is still on the field after a removal landed.
 *
 * A referent takes everything that only existed because of it, so the
 * question is not whether the selection *was* the mark but whether it
 * survived it. Asked by every removal — one mark or one relation — so the
 * reader goes exactly when what it was reading went.
 */
function selectionSurvived(
  selection: NonNullable<CanvasSelection>,
  set: WorkingSet,
): boolean {
  return selection.kind === "referent"
    ? set.referents.has(selection.id)
    : selection.kind === "demand"
      ? set.demands.has(selection.id)
      : set.assertions.has(selection.id) ||
        set.bonds.some((bond) => bond.assertion_id === selection.id);
}

function sameSelection(a: CanvasSelection, b: CanvasSelection): boolean {
  if (a === b) return true;
  if (!a || !b) return false;
  return a.kind === b.kind && a.id === b.id;
}

/** Rows shown per link group before the rest collapse into the table. */
const LINK_ROSTER_CAP = 8;

/**
 * How far back the reader's trail reaches.
 *
 * Fifty arrivals is a long session of looking; past that the oldest steps
 * fall off rather than the trail growing without bound. Falling off the
 * front, never refusing the next push — a cap that stopped travel from
 * recording would strand back at a stale mark.
 */
const READER_TRAIL_CAP = 50;

/** Scalar values as one short line, for roster rows. */
function summarizeScalars(scalars: { role: string; value: unknown }[]): string {
  const parts = scalars.map((item) => scalarText(item.value));
  return parts.length > 3
    ? `${parts.slice(0, 3).join(" · ")} · …`
    : parts.join(" · ");
}

/**
 * The parallel claims on one filament, in canvas order.
 *
 * Mirrors the bundle grouping in WorldCanvas — endpoints sorted and joined,
 * claims sorted by relation then id — so the roster and the filament agree on
 * what the filament holds. Empty unless the shown tuple is folded onto a
 * shared line.
 */
function filamentSiblings(
  set: WorkingSet,
  assertionId: string,
): FieldBond[] {
  const shown = set.bonds.find((bond) => bond.assertion_id === assertionId);
  if (!shown) return [];
  const key = [shown.source, shown.target].sort().join("\u0000");
  const group = set.bonds.filter(
    (bond) => [bond.source, bond.target].sort().join("\u0000") === key,
  );
  if (group.length < 2) return [];
  return [...group].sort((a, b) =>
    `${a.relation}\u0000${a.assertion_id}`.localeCompare(
      `${b.relation}\u0000${b.assertion_id}`,
    ),
  );
}

/** One thing joined to a referent: the plate, bond, or demand at a spoke. */
type ReferentLink = {
  key: string;
  relation: string;
  /** The occurrence this row opens — absent for a demanded, unrecorded tuple. */
  occurrence?: string;
  /** This referent's role in that occurrence. */
  role: string;
  /** What the far end shows: plate scalars, or the other referent's label. */
  far: string;
  origin: string;
  occurrence_state?: string;
  stale: boolean;
  select: NonNullable<CanvasSelection>;
};

type ReferentLinkGroup = {
  relation: string;
  links: ReferentLink[];
};

/**
 * Everything joined to a referent, as relation runs in one flat roster.
 *
 * Plates, bonds, and demands alike: what is ON the field now, as opposed to
 * "Expand through", which is what could be. Runs sort alphabetically by
 * relation — the grouping survives only as ordering and per-relation
 * overflow, not as headers, since a header per relation spent more space
 * than the rows it introduced.
 */
function referentLinkGroups(
  set: WorkingSet,
  referentId: string,
): ReferentLinkGroup[] {
  const links: ReferentLink[] = [];
  for (const item of set.assertions.values()) {
    for (const spoke of item.spokes) {
      if (spoke.id !== referentId) continue;
      links.push({
        key: `${item.assertion_id}\u0000${spoke.role}`,
        relation: item.relation,
        occurrence: item.assertion_id,
        role: spoke.role,
        far: summarizeScalars(item.scalars),
        origin: item.origin,
        occurrence_state: item.occurrence_state,
        stale: item.stale,
        select: { kind: "assertion", id: item.assertion_id },
      });
    }
  }
  for (const bond of set.bonds) {
    if (bond.source !== referentId && bond.target !== referentId) continue;
    const other = bond.source === referentId ? bond.target : bond.source;
    const role =
      bond.spokes.find((spoke) => spoke.id === referentId)?.role ??
      bond.relation;
    links.push({
      key: `${bond.assertion_id}\u0000${role}`,
      relation: bond.relation,
      occurrence: bond.assertion_id,
      role,
      far: set.referents.get(other)?.label || other,
      origin: bond.origin,
      occurrence_state: bond.occurrence_state,
      stale: bond.stale,
      select: { kind: "assertion", id: bond.assertion_id },
    });
  }
  for (const demand of set.demands.values()) {
    for (const spoke of demand.spokes) {
      if (spoke.id !== referentId) continue;
      links.push({
        key: `${demand.key}\u0000${spoke.role}`,
        relation: demand.relation,
        role: spoke.role,
        far: summarizeScalars(demand.scalars),
        origin: "unresolved",
        stale: false,
        select: { kind: "demand", id: demand.key },
      });
    }
  }
  const byRelation = new Map<string, ReferentLink[]>();
  for (const link of links) {
    const group = byRelation.get(link.relation) ?? [];
    group.push(link);
    byRelation.set(link.relation, group);
  }
  return [...byRelation]
    .map(([relation, unsorted]) => ({
      relation,
      links: [...unsorted].sort((a, b) =>
        `${a.role}\u0000${a.far}`.localeCompare(`${b.role}\u0000${b.far}`),
      ),
    }))
    .sort((a, b) => a.relation.localeCompare(b.relation));
}

/**
 * Details already read this session, so a subject read twice is rendered
 * twice, not fetched twice.
 *
 * Capped, because the plane holds worlds too large to hold: the cache keeps
 * the recent subjects someone is moving between, and the oldest goes when it
 * is full. Insertion order is the eviction order, which a `Map` already is.
 */
const DETAIL_CACHE_CAP = 200;

/**
 * A neighborhood this large arrives as one field admission, drawn still.
 *
 * The canvas's `still` exists for exactly this: fifty staggered nucleations
 * are not fifty announcements, they are one laggy one, and the loading state
 * lives on the expand control rather than on each mark. Measured on the hub
 * fixture under ordinary motion, staggered births cost the main thread more
 * than their count — about 0.2 s of long tasks for twenty, 0.6 s for fifty,
 * 4.4 s for two hundred and 6.9 s for two hundred and fifty — where the same
 * marks drawn still cost what reduced motion costs. Below this a neighborhood
 * keeps its births: the motion a single read has.
 */
const EXPANSION_STILL_AT = 50;

/** Every claim on the field, whichever drawing it stands in. */
function claimIds(set: WorkingSet): Set<string> {
  return new Set([
    ...set.assertions.keys(),
    ...set.bonds.map((bond) => bond.assertion_id),
  ]);
}

function keepDetail<T>(map: Map<string, T>, key: string, value: T): void {
  if (!map.has(key) && map.size >= DETAIL_CACHE_CAP) {
    const oldest = map.keys().next();
    if (!oldest.done) map.delete(oldest.value);
  }
  map.set(key, value);
}

export function WorldPage() {
  const { hidden } = useOverlayChrome();
  const motion = DEFAULT_MOTION_PLANS;
  const browserMode = useBrowserTheme();
  const [localMode, setLocalMode] = useState<ThemeMode | null>(null);
  const mode = localMode ?? browserMode;
  const [motionReady, setMotionReady] = useState(false);
  const [overview, setOverview] = useState<WorldOverview | null>(null);
  useWorldIcon(overview?.world_id);
  const [relations, setRelations] = useState<WorldRelation[]>([]);
  const [directory, setDirectory] = useState<Directory>([]);
  /**
   * Whether the directory in hand is the whole of the world's referents.
   *
   * A short directory is not a smaller world, it is a world the front end was
   * not handed all of — so find must stop pretending the array in front of it
   * is the answer and ask the plane. Exact misses stay exact misses either
   * way; what changes is who is being asked.
   */
  const [directoryShort, setDirectoryShort] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const [set, setSet] = useState<WorkingSet>(emptySet);
  /**
   * Whether anything is on the field.
   *
   * Declared here rather than beside its one-time reader, because it is the
   * condition the whole surface turns on: the vocabulary, the dock in focus,
   * which instruments are offered. `onField` below is this, named for the
   * places that read it as a sentence.
   */
  const hasField = fieldSize(set) > 0;
  /**
   * What the last arrangement displaced, so it can be put back.
   *
   * One level, and only until the field itself changes. Arrangement is the one
   * action that overwrites placement a person may have made by hand, so it does
   * not get to be silent; but once matter has arrived or left, the positions it
   * displaced are no longer a state the field was ever in, and offering to
   * restore them would be offering a lie.
   */
  const [arrangeUndo, setArrangeUndo] = useState<{
    label: string;
    positions: Map<string, Point>;
  } | null>(null);
  const [arrangeToken, setArrangeToken] = useState(0);
  const [expansionRequests, dispatchExpansion] = useReducer(
    expansionRequestReducer,
    new Map(),
  );
  const [selection, setSelection] = useState<CanvasSelection>(null);
  /**
   * The reader's trail: the marks it showed before this one, oldest first.
   *
   * Travel is every arrival through `chooseFieldMark` — a canvas pick, a role
   * or roster link, a table row, the finder — and each pushes the mark being
   * left, so back walks the session in reverse. Deselecting pushes nothing:
   * leaving is not arriving, and the chip stays offered where the trail led.
   * Removal does not prune it either: taking a mark off the field does not
   * take it out of the world, so every entry still reads — the panel simply
   * shows a mark with no canvas presence, the same as a fact's off-field
   * tuple. Only clearing the field ends the trail.
   */
  const [past, setPast] = useState<NonNullable<CanvasSelection>[]>([]);
  const [hovered, setHovered] = useState<string | null>(null);
  const [hoveredRelation, setHoveredRelation] = useState<string | null>(null);
  const [focusedRelation, setFocusedRelation] = useState<string | null>(null);
  const [namedAtRest, setNamedAtRest] = useState(false);
  /**
   * Whether a selected mark spreads its strokes apart — see `spread.ts`.
   *
   * On, because selecting a mark is what reveals every name it carries at
   * once, and at rest those names are all stationed the same distance out from
   * the same rim: two neighbours a few degrees apart hand the reader one plate
   * on top of another. Offered as a setting because it is the one place this
   * canvas draws a filament off the line between its two ends, and that is a
   * reader's call to make.
   */
  const [spreadOnSelect, setSpreadOnSelect] = useState(true);
  const [framing, setFraming] = useState(false);
  /** Claims framing made binary that a person has opened back into plates. */
  const [framedOpen, setFramedOpen] = useState<ReadonlySet<string>>(() => new Set());
  const [foldSeed, setFoldSeed] = useState<{ id: string } | null>(null);
  const [show, setShow] = useState<ShowState>(SHOW_DEFAULT);
  /**
   * Neutral presentation: a world that supplies no DERIVED mode and no
   * recorded construction origin has nothing for the SHOW layers to
   * classify. Its controls are absent, so visibility ignores the saved
   * layer state entirely — a stored preference must not hide material
   * behind a control that is not there. The saved record itself is
   * left exactly as stored.
   */
  const classified = worldHasClassification(relations);
  const derivedMode = worldHasDerivedMode(relations);
  /** Fully neutral: no recorded origin and no DERIVED mode supplied. */
  const neutral = !classified && !derivedMode;
  /** Governance is independent of construction metadata. */
  const hasDemand = Boolean(overview?.demand);
  const showLayers: ShowLayer[] = classified
    ? SHOW_LAYERS
    : [
        ...(derivedMode ? ["derived" as ShowLayer] : []),
        ...(hasDemand ? ["unresolved" as ShowLayer] : []),
      ];
  // Memoized: this object feeds expensive graph memoization, so its
  // identity must change only when its effective values change.
  const effectiveShow = useMemo<ShowState>(() => {
    if (classified) return show;
    return {
      semantic: true,
      adjudicated: true,
      mechanical: true,
      unstated: true,
      derived: derivedMode ? show.derived : true,
      unresolved: hasDemand ? show.unresolved : true,
    };
  }, [classified, derivedMode, hasDemand, show]);
  const [readerOpen, setReaderOpen] = useState(false);
  const [readerWidth, setReaderWidth] = useState(() =>
    readStoredPanelSize(READER_WIDTH_KEY, 320),
  );
  /**
   * The TABLES dock starts out, because an empty field has nothing else.
   *
   * What is on screen at rest is the vocabulary, and a vocabulary is a list of
   * what this world *could* say — you read it, you do not put anything on the
   * field from it. The table is where a subject comes from. Closed by default,
   * the surface opened on a canvas of relations with no visible way to reach a
   * row, and the handle on the edge was the whole instruction.
   */
  const [tablesOpen, setTablesOpen] = useState(true);
  const [tablesWidth, setTablesWidth] = useState(() =>
    readStoredPanelSize(TABLES_WIDTH_KEY, TABLES_WIDTH_DEFAULT),
  );
  const [assertion, setAssertion] = useState<WorldAssertion | null>(null);
  const [referent, setReferent] = useState<WorldReferent | null>(null);
  const detailCache = useRef({
    assertions: new Map<string, WorldAssertion>(),
    referents: new Map<string, WorldReferent>(),
  });
  /**
   * `kind:id` reads that failed, with why. State rather than a ref, because
   * the failure is drawn: the reader stops holding for it, and the panel owns
   * it — it names the subject the read was for, where the notice strip could
   * only name the message.
   */
  const [detailProblems, setDetailProblems] = useState(
    () => new Map<string, string>(),
  );
  const [notice, setNotice] = useState<string | null>(null);
  /**
   * What is open on the left overlay. World is the idle catalogue; the legacy
   * Purpose frontier, governed Obligations, and relations are subjects you
   * switch to. Closing the handle parks it; opening it again is the same
   * reading.
   */
  const [table, setTable] = useState<TableView>({ kind: "world" });
  const [legacyDemand, setLegacyDemand] = useState<WorldDemand | null>(null);
  const [demandProblem, setDemandProblem] = useState<string | null>(null);
  /**
   * The frontier read has answered — landed, failed, or answered null. A null
   * demand is a settled answer ("no Purpose demand is loaded"), not an
   * outstanding read, so settled-ness is tracked and never inferred.
   */
  const [demandSettled, setDemandSettled] = useState(false);
  const [governedObligations, setGovernedObligations] =
    useState<WorldObligationSummary[] | null>(null);
  const [governedProblem, setGovernedProblem] = useState<string | null>(null);
  const [frontierRequested, setFrontierRequested] = useState(false);
  const [selectedObligation, setSelectedObligation] =
    useState<WorldObligation | null>(null);
  const [obligationInspection, setObligationInspection] =
    useState<WorldObligationInspection | null>(null);
  const [obligationProblem, setObligationProblem] = useState<string | null>(null);
  /**
   * Ownership of the governed detail request. Every governed selection
   * and every navigation away from it advances the generation; a
   * response may commit only while its generation is still current,
   * so completion order can never resurrect an older subject.
   */
  const governedRequest = useRef(0);
  const clearGoverned = useCallback(() => {
    governedRequest.current += 1;
    setSelectedObligation(null);
    setObligationInspection(null);
    setObligationProblem(null);
  }, []);
  useEffect(() => () => {
    governedRequest.current += 1;
  }, []);
  /**
   * The vocabulary, inverted — and with an empty field, the whole screen.
   *
   * Two things at once, and the second is the one that is easy to lose.
   *
   * With a field, this is a focus room: the field stays, parked, until Clear,
   * because the product's focus mode is being used for a different subject —
   * the schema rather than a lit node — and the neighbourhood should still be
   * there when you come back.
   *
   * With no field, it is not a mode at all. It is the screen: there is nothing
   * to park and nothing to come back to, so an "unfocused empty field" is a
   * blank page nobody asked for. `true` at rest, and the pair of them is one
   * rule — **the vocabulary is showing exactly when the field is empty** — kept
   * by the effect below rather than by each caller remembering to.
   *
   * The initial value is a *guess*, and deliberately one: which screen is right
   * cannot be known until the world's revision has arrived and the field has
   * been restored, and painting the wrong one until then is the surface
   * visibly flipping while a person watches — the ground going dark and light
   * again half a second in. `holdsField` answers the only question the first
   * paint needs, and the effect below settles it for real a moment later.
   */
  const [vocabularyFocus, setVocabularyFocus] = useState(() => !holdsField());
  /**
   * What is *drawn*, which lags the intent by one absorb.
   *
   * Vocabulary focus inverts the whole surface, so the field and the
   * vocabulary have no shared ground to cross over — see `useSequencedSwap`.
   * `vocabularyFocus` stays the thing a person asked for; `focusView.value` is
   * what is on screen, and every visual read below uses it.
   */
  const focusView = useSequencedSwap(vocabularyFocus, motion);
  const focusDrawn = focusView.value;
  /**
   * A mark a table named, distinct from canvas selection.
   *
   * Clicking the field already has the mark under the pointer. A row does not.
   * The camera reveals rather than recenters, so a row whose mark is already
   * showing holds still — and the token still changes when the id does not,
   * so a mark that left the view flies back on the second click.
   */
  const [focus, setFocus] = useState<{
    id: string;
    token: number;
    /** Marks the reveal brings with `id`: an expansion's new neighbours. */
    with?: readonly string[];
  } | null>(null);
  const revealMark = useCallback((id: string, withIds?: readonly string[]) => {
    setFocus({ id, token: performance.now(), with: withIds });
  }, []);

  const labels = useRef(new Map<string, string | null>());
  const linkedRelation = useRef(linkedRelationFromHash());
  /**
   * Whether the stored field has been looked for yet.
   *
   * The world arrives one render after the page does, so there is a window in
   * which the field is legitimately empty and not yet known to be. Writing
   * during it would store that emptiness over the field someone left behind —
   * so nothing is written until the restore has been attempted.
   */
  const restored = useRef(false);
  /**
   * Whether the restore has been attempted — state, not the ref beside it,
   * because a rule that must not fire before it has to be able to re-run after.
   */
  const [restoredField, setRestored] = useState(false);
  /** Synchronous duplicate guard; reducer state becomes visible next render. */
  const expansionsInFlight = useRef(new Map<string, number>());
  /** Invalidates a response that lands after its field has been cleared. */
  const expansionGeneration = useRef(0);
  useEffect(() => {
    const frame = requestAnimationFrame(() => setMotionReady(true));
    return () => cancelAnimationFrame(frame);
  }, []);

  /**
   * Put back the field this browser last held for this world.
   *
   * Only onto an empty canvas, and only once: someone who arrived through a
   * link and has already started building keeps what they built. A revision
   * this browser has no field for restores nothing, which is the intended
   * answer after a rebuild.
   */
  useEffect(() => {
    if (!overview || restored.current) return;
    restored.current = true;
    const stored = readField(overview.world_id, overview.revision);
    const incoming = stored && fieldSize(stored) ? stored : null;
    setSet((current) => {
      if (fieldSize(current)) return current;
      if (incoming) return incoming;
      return current;
    });
    /**
     * The filter menu comes back as left — see `showMemory` — whether or not
     * a field came back with it. A stored menu wins over the reveal below: it
     * was written alongside the field it filters, so re-revealing would switch
     * back on a layer the person turned off after the last restore.
     */
    const storedShow = readShow(overview.world_id);
    if (storedShow) {
      setShow(storedShow.show);
      setNamedAtRest(storedShow.namedAtRest);
      setSpreadOnSelect(storedShow.spreadOnSelect);
      setFraming(storedShow.framing);
    } else if (incoming && !fieldSize(set)) {
      /**
       * The restore places marks, and placing reveals — see `revealSet` — so
       * a restored mechanical field comes back standing instead of filtered
       * out. Only when the restore actually placed, and only for a menu this
       * browser never put away: a field built through a link keeps what its
       * builder revealed.
       */
      setShow((current) => revealSet(incoming, current));
    }
    // Both in one commit, so the rule below never sees a field that has not
    // arrived yet and flips the surface on its way there.
    setRestored(true);
  }, [overview, set]);

  /**
   * The one rule: the vocabulary is showing exactly when the field is empty.
   *
   * Both directions, because a person can cross that line either way — the
   * first row focused, the last mark taken off, Clear. Getting one direction
   * only is how `clear the field` left an empty light canvas that was neither
   * the field nor the default screen.
   *
   * Keyed on the *crossing*, not on the state: entering the vocabulary later
   * with a field on it does not run this, because `hasField` did not change.
   * And gated on the restore having happened, so a browser putting a field
   * back does not show the default screen on the way.
   */
  useEffect(() => {
    if (!restoredField) return;
    setVocabularyFocus(!hasField);
  }, [hasField, restoredField]);

  /** Keep the stored field level with the one on screen. */
  useEffect(() => {
    if (!overview || !restored.current) return;
    writeField(overview.world_id, overview.revision, set);
  }, [overview, set]);

  /**
   * Keep the stored filter menu level with the one on screen.
   *
   * Gated on the restore having landed, not just started: this runs in the
   * same commit as the restore scheduling, and writing the defaults over a
   * stored menu before the restored one arrives would forget it between
   * renders.
   */
  useEffect(() => {
    if (!overview || !restoredField) return;
    writeShow(overview.world_id, { show, namedAtRest, spreadOnSelect, framing });
  }, [overview, restoredField, show, namedAtRest, spreadOnSelect, framing]);

  const onReaderWidth = useCallback((width: number) => {
    setReaderWidth(width);
    storePanelSize(READER_WIDTH_KEY, width);
  }, []);

  const showTable = useCallback((view: TableView) => {
    setTable(view);
    setTablesOpen(true);
  }, []);

  const collapseTables = useCallback(() => {
    setTablesOpen(false);
  }, []);

  const onTablesWidth = useCallback((width: number) => {
    setTablesWidth(width);
    storePanelSize(TABLES_WIDTH_KEY, width);
  }, []);

  const tableChrome = useMemo<TableChrome>(
    () => ({
      current:
        table.kind === "world"
          ? table.kind
          : table.kind === "frontier"
            ? "frontier"
            : table.kind === "governed"
              ? "governed"
              : "other",
      hasFrontier: Boolean(overview?.demand),
      hasGovernedObligations: Boolean(overview?.governed_obligations),
      onWorld: () => showTable({ kind: "world" }),
      onFrontier: () => showTable({ kind: "frontier" }),
      onGoverned: () => showTable({ kind: "governed" }),
      onClose: collapseTables,
    }),
    [
      collapseTables,
      overview?.demand,
      overview?.governed_obligations,
      showTable,
      table.kind,
    ],
  );

  useEffect(() => {
    let cancelled = false;
    Promise.all([worldApi.overview(), worldApi.schema(), worldApi.referents()])
      .then(([summary, schema, all]) => {
        if (cancelled) return;
        setError(null);
        setOverview(summary);
        setRelations(schema);
        setDirectory(all.referents);
        setDirectoryShort(all.truncated);
        labels.current = new Map(
          all.referents.map((item) => [item.id, item.label]),
        );
      })
      .catch((problem: Error) => {
        if (!cancelled) setError(problem.message);
      });
    return () => {
      cancelled = true;
    };
    // Once per mount: a refresh re-runs the load, which is the retry.
  }, []);

  useEffect(() => {
    const name = linkedRelation.current;
    if (!name || !relations.length) return;
    linkedRelation.current = null;
    if (!relations.some((relation) => relation.name === name)) {
      // The notice lives inside the reader, and this effect runs on arrival
      // with the reader shut — so the miss has to open it or the seam fails
      // silently. A link from construction naming a relation this world does
      // not have is the normal case when the run and the world are different
      // domains, not an edge one.
      setNotice(`${name} is not in this world's vocabulary.`);
      setReaderOpen(true);
      return;
    }
    setFocusedRelation(name);
    setReaderOpen(true);
    setTable({ kind: "relation", relation: name, subject: null });
    setTablesOpen(true);
  }, [relations]);

  // Selection drives one fetch, and only one: a chip reads its assertion, a
  // disc reads its neighborhood costs.
  useEffect(() => {
    setNotice(null);
    if (!selection) {
      setAssertion(null);
      setReferent(null);
      return;
    }
    if (selection.kind === "demand") {
      // Nothing to read: an obligation is not in the world, so there is no
      // record of it to fetch. The frontier document already holds it.
      setAssertion(null);
      setReferent(null);
      return;
    }
    const failedKey = `${selection.kind}:${selection.id}`;
    setDetailProblems((current) => {
      if (!current.has(failedKey)) return current;
      const next = new Map(current);
      next.delete(failedKey);
      return next;
    });
    let cancelled = false;
    if (selection.kind === "assertion") {
      const cached = detailCache.current.assertions.get(selection.id);
      if (cached) {
        setAssertion(cached);
        return;
      }
      setAssertion(null);
      worldApi
        .assertion(selection.id)
        .then((found) => {
          if (cancelled) return;
          keepDetail(detailCache.current.assertions, selection.id, found);
          setAssertion(found);
        })
        .catch((problem: Error) => {
          if (cancelled) return;
          setDetailProblems((current) =>
            new Map(current).set(failedKey, problem.message),
          );
        });
    } else {
      const cached = detailCache.current.referents.get(selection.id);
      if (cached) {
        setReferent(cached);
        return;
      }
      setReferent(null);
      worldApi
        .referent(selection.id)
        .then((found) => {
          if (cancelled) return;
          keepDetail(detailCache.current.referents, selection.id, found);
          setReferent(found);
        })
        .catch((problem: Error) => {
          if (cancelled) return;
          setDetailProblems((current) =>
            new Map(current).set(failedKey, problem.message),
          );
        });
    }
    return () => {
      cancelled = true;
    };
  }, [selection]);

  const showMark = useCallback((next: NonNullable<CanvasSelection>) => {
    clearGoverned();
    setSelection(next);
    setReaderOpen(true);
  }, [clearGoverned]);

  const chooseFieldMark = useCallback((next: CanvasSelection) => {
    if (!next) {
      clearGoverned();
      setSelection(null);
      setReaderOpen(false);
      return;
    }
    // Travel pushes: the mark being left is where back returns to. A
    // re-press of the mark already shown pushes nothing — back past a
    // no-op is a loop, not a trail.
    if (selection && !sameSelection(next, selection)) {
      setPast((prev) => [...prev.slice(-(READER_TRAIL_CAP - 1)), selection]);
    }
    showMark(next);
  }, [selection, showMark]);

  /**
   * One step down the trail, without pushing: back is travel whose arrival
   * must not become its own return.
   */
  const goBack = useCallback(() => {
    const next = past[past.length - 1];
    if (!next) return;
    setPast(past.slice(0, -1));
    showMark(next);
    revealMark(next.id);
  }, [past, showMark, revealMark]);

  /**
   * Travel from the reader — a role, a roster row, a fellow claim — is a
   * person asking to see that mark, so the camera reveals it the way a table
   * row does: only as far as it needs to, and not at all when it shows. It
   * is also how the part of a large neighbourhood the camera could not hold
   * is reached, one named mark at a time. A canvas pick is not routed here:
   * the mark is already under the pointer.
   */
  const travelTo = useCallback((next: CanvasSelection) => {
    chooseFieldMark(next);
    if (next) revealMark(next.id);
  }, [chooseFieldMark, revealMark]);

  const chooseSchemaRelation = useCallback(
    (name: string | null) => {
      // Selecting a relation as the reader subject ends governed
      // ownership: the governed reader must not keep precedence over
      // it, and a pending governed detail must never land on it.
      if (name) clearGoverned();
      setFocusedRelation(name);
      // The vocabulary room opens no panels: with a field behind it the
      // reader would surface the stale field selection instead of the
      // relation just named — measured opening program_entity's panel from
      // an enters_flow click. The room implies a field, so its absence is
      // the default screen, where no stale selection exists and the reader
      // legitimately reads the focused relation.
      if (!hasField) setReaderOpen(Boolean(name));
    },
    [hasField, clearGoverned],
  );

  const onSeed = useCallback((id: string, label: string) => {
    setSet((current) => seed(current, id, label));
    chooseFieldMark({ kind: "referent", id });
    revealMark(id);
  }, [chooseFieldMark, revealMark]);

  // Canvas find operates on the visible working field. An empty field still
  // needs a seed; only that initial search uses the world's directory.
  const fieldDirectory = useMemo<Directory>(() => [
    ...Array.from(set.referents.values(), ({ id, label }) => ({ id, label })),
    ...Array.from(set.assertions.values())
      .filter((item) => assertionShown(item.origins ?? item.origin, item.mode, effectiveShow))
      .map((item) => ({ id: item.assertion_id, label: item.relation })),
    ...set.bonds
      .filter((item) => set.referents.has(item.source) &&
        set.referents.has(item.target) &&
        assertionShown(item.origins ?? item.origin, item.mode, effectiveShow))
      .map((item) => ({ id: item.assertion_id, label: item.relation })),
    ...(effectiveShow.unresolved
      ? Array.from(set.demands.values(), (item) => ({ id: item.key, label: item.relation }))
      : []),
  ], [set, effectiveShow]);

  /** The plane's own referent search, for a world too large to hold. */
  const askWorld = useCallback(
    async (query: string): Promise<Directory> =>
      (await worldApi.search(query, 10))
        .filter((item) => item.kind === "referent")
        .map((item) => ({ id: item.id, label: item.label })),
    [],
  );

  const onFind = useCallback((id: string, label: string) => {
    if (!set.referents.size && !set.assertions.size && !set.demands.size && !set.bonds.length) {
      onSeed(id, label);
      return;
    }
    chooseFieldMark({
      kind: set.referents.has(id) ? "referent" : set.demands.has(id) ? "demand" : "assertion",
      id,
    });
    revealMark(id);
  }, [onSeed, chooseFieldMark, revealMark, set]);

  /**
   * Bulk admissions and withdrawals the canvas draws still, beyond the
   * table's own add-all — see `EXPANSION_STILL_AT`.
   *
   * A count rather than a flag: two expansions, or an expansion and a
   * retraction, can be in flight together, and one ending must not un-still
   * the other.
   *
   * A hold is let go on evidence, not on time. Its data reaches the canvas in
   * whichever render React gets to — under load, seconds after the request
   * loop has finished — and a release queued for "a task later" can land in
   * that same render, so the frame it was for goes out animated. Released
   * instead once a committed field shows what the hold was for: this page's
   * effects run after the canvas's own, so by then that commit's frame has
   * already been taken still.
   */
  const [stillHolds, setStillHolds] = useState(0);
  const committedSet = useRef(set);
  const stillLandings = useRef<
    { landed: (field: WorkingSet) => boolean; release: () => void }[]
  >([]);
  useEffect(() => {
    committedSet.current = set;
    stillLandings.current = stillLandings.current.filter((hold) => {
      if (!hold.landed(set)) return true;
      hold.release();
      return false;
    });
  }, [set]);
  const holdStill = useCallback(() => {
    setStillHolds((count) => count + 1);
    let held = true;
    return (landed: (field: WorkingSet) => boolean) => {
      if (!held) return;
      held = false;
      const release = () => setStillHolds((count) => count - 1);
      if (landed(committedSet.current)) release();
      else stillLandings.current.push({ landed, release });
    };
  }, []);

  const onExpand = useCallback(
    async (anchor: string, relation: string) => {
      const key = expansionKey(anchor, relation);
      if (expansionsInFlight.current.has(key)) return;
      const schema = relations.find((item) => item.name === relation);
      // No `reveal` here. Expanding through a filtered-out relation is allowed
      // — the neighbours arrive and referents draw under every filter — but it
      // does not turn the filter off behind the person who set it. The bonds
      // are in the working set and appear the moment the layer comes back.
      const generation = expansionGeneration.current;
      expansionsInFlight.current.set(key, generation);
      dispatchExpansion({ type: "start", key });
      let release: ((landed: (field: WorkingSet) => boolean) => void) | null =
        null;
      // The newest claims this run has folded that the committed field did
      // not hold yet. Folds commit in order, so the first of them standing is
      // every fold up to theirs, committed. Kept from the last page that
      // brought any: a later page of claims already standing brings nothing to
      // wait for, and must not stand in for the pages that did.
      let folded: string[] = [];
      // Neighbours this run brought that were not standing before it: what
      // the camera reveals around the anchor once the run has landed.
      const introduced = new Set<string>();
      try {
        let offset = 0;
        while (true) {
          // The expansion endpoint returns only one bounded batch. Rows can
          // page the same referent's neighborhood without losing its tail.
          const page = await worldApi.rows(relation, {
            subject: anchor,
            limit: 200,
            offset,
          });
          if (generation !== expansionGeneration.current) return;
          // Decided on the first page, from the neighborhood's own total, and
          // held to the last: every page of a large expansion is one
          // admission, so the tail does not stagger in after a still head.
          if (!release && page.total >= EXPANSION_STILL_AT) release = holdStill();
          /**
           * Names for the neighbours the directory did not carry.
           *
           * Only when it is short: a complete directory already holds every
           * label, and a request per expansion for an answer already in hand is
           * the plane being asked to repeat itself. A neighbour with no name
           * still draws — `workingSet` falls back to the id — so this failing is
           * a field of ids, not a field of nothing.
           */
          if (directoryShort) {
            const missing = [
              ...new Set(
                page.rows.flatMap((tuple) =>
                  page.roles
                    .filter((role) => role.referent)
                    .map((role) => String(tuple.values[role.name] ?? ""))
                    .filter((id) => id && !labels.current.has(id)),
                ),
              ),
            ];
            if (missing.length) {
              try {
                const found = await worldApi.labels(missing);
                for (const [id, label] of Object.entries(found)) {
                  labels.current.set(id, label);
                }
              } catch {
                // A name is not the claim. The expansion stands either way.
              }
              if (generation !== expansionGeneration.current) return;
            }
          }
          for (const tuple of page.rows) {
            for (const role of page.roles) {
              if (!role.referent) continue;
              const id = String(tuple.values[role.name] ?? "");
              if (id && id !== anchor && !committedSet.current.referents.has(id)) {
                introduced.add(id);
              }
            }
          }
          const standing = claimIds(committedSet.current);
          const fresh = page.rows
            .map((tuple) => tuple.assertion_id)
            .filter((id) => !standing.has(id));
          if (fresh.length) folded = fresh;
          setSet((current) =>
            current.referents.has(anchor)
              ? expand(current, {
                  anchor,
                  relation,
                  mode: schema?.mode ?? "BASE",
                  stale: schema?.stale ?? false,
                  completeness: schema?.completeness?.status ?? null,
                  roles: page.roles,
                  tuples: page.rows,
                  labels: labels.current,
                })
              : current,
          );
          offset += page.rows.length;
          if (offset >= page.total) break;
          if (!page.rows.length) {
            throw new Error("The neighborhood read ended before all tuples arrived. Try again.");
          }
        }
        dispatchExpansion({ type: "succeed", key });
        // The person asked for the neighbourhood, so it is brought into view —
        // by the shortest pan that shows it, the anchor kept in sight, and no
        // zoom. Nothing new, nothing to reveal.
        if (introduced.size) revealMark(anchor, [...introduced]);
      } catch (problem) {
        if (generation === expansionGeneration.current) {
          const message = (problem as Error).message;
          setNotice(message);
          dispatchExpansion({ type: "fail", key, message });
        }
      } finally {
        // Landed once the newest folded claims stand, or the anchor they were
        // folded onto does not — then nothing is left to draw still. None at
        // all means every claim was already standing: nothing to wait for.
        release?.((field) => {
          if (!folded.length || !field.referents.has(anchor)) return true;
          const standing = claimIds(field);
          return folded.some((id) => standing.has(id));
        });
        if (expansionsInFlight.current.get(key) === generation) {
          expansionsInFlight.current.delete(key);
        }
      }
    },
    [directoryShort, holdStill, relations, revealMark],
  );

  const onRetract = useCallback(
    (anchor: string, relation: string) => {
      // Taking a large neighborhood off is one withdrawal, as bringing it on
      // was one admission.
      const release =
        expansionMaterial(set, anchor, relation).size >= EXPANSION_STILL_AT
          ? holdStill()
          : null;
      setSet((current) => retractExpansion(current, anchor, relation));
      release?.(
        (field) => expansionMaterial(field, anchor, relation).size === 0,
      );
    },
    [holdStill, set],
  );

  /**
   * Where the renderer put everything, and what was dropped to put it there.
   *
   * The dropped mark restacks to the front — but only when its place actually
   * changed. A press that went nowhere is a click, not a drop, and restacking
   * it would reorder the depth stack for an action that moved nothing. One
   * set either way, so positions and depth land in a single frame.
   */
  const onPositions = useCallback(
    (
      positions: Map<string, { x: number; y: number }>,
      droppedId?: string,
    ) => {
      setSet((current) => {
        const merged = new Map([...current.positions, ...positions]);
        const at = droppedId ? merged.get(droppedId) : undefined;
        const was = droppedId ? current.positions.get(droppedId) : undefined;
        if (
          !droppedId ||
          !at ||
          (was && at.x === was.x && at.y === was.y)
        ) {
          return { ...current, positions: merged };
        }
        return restack({ ...current, positions: merged }, droppedId);
      });
    },
    [],
  );

  /**
   * A row focuses its graph projection (§11).
   *
   * The tuple lands beside whichever of its referents is already on the field,
   * and the assertion it belongs to becomes the selection — so picking a row
   * out of a ten-thousand-row extension answers *where does this sit* on the
   * canvas and *what is it made of* in the panel at once. From the vocabulary
   * this is also how a field starts: the first row placed seeds it.
   */
  /**
   * A row, onto the field. The seam of §11, and it is the same seam wherever
   * the row came from — an extension, or an input tuple offered as candidate
   * support for a derived one — so the relation is passed rather than read off
   * whichever table happens to be open.
   */
  const placeTuple = useCallback(
    (relation: string, roles: WorldRole[], tuple: WorldTuple) => {
      const schema = relations.find((item) => item.name === relation);
      if (schema) setShow((current) => reveal(schema, current));
      setSet((current) =>
        place(current, {
          relation,
          mode: schema?.mode ?? "BASE",
          stale: schema?.stale ?? false,
          completeness: schema?.completeness?.status ?? null,
          roles,
          tuple,
          labels: labels.current,
        }),
      );
      chooseFieldMark({ kind: "assertion", id: tuple.assertion_id });
      revealMark(tuple.assertion_id);
    },
    [chooseFieldMark, relations, revealMark],
  );

  const onFocusRow = useCallback((roles: WorldRole[], tuple: WorldTuple) => {
    if (table?.kind !== "relation") return;
    placeTuple(table.relation, roles, tuple);
  }, [placeTuple, table]);

  /**
   * A bulk arrival is in flight, so frames draw still — no per-mark births.
   *
   * Set by the table running the add-all, cleared by it when the run ends. The
   * release lands after the last page's render (the table defers it a task),
   * so the final frame is already enqueued still before the flag falls.
   */
  const [bulkActive, setBulkActive] = useState(false);

  /**
   * A page of rows, onto the field — the bulk half of the §11 seam.
   *
   * One `setSet` folds the whole page through the same `place` a single row
   * takes, so a page costs one render no matter how many tuples it holds.
   * Deliberately not `placeTuple` in a loop: that would fly the camera once
   * per row and re-decide the selection per row, and a bulk add is neither a
   * focus nor a choice. The camera stays where it was, the selection is
   * untouched, and the rows say they arrived by ticking into the margin.
   */
  const placeMany = useCallback(
    (relation: string, roles: WorldRole[], tuples: WorldTuple[]) => {
      const schema = relations.find((item) => item.name === relation);
      if (schema) setShow((current) => reveal(schema, current));
      setSet((current) =>
        placeAll(current, {
          relation,
          mode: schema?.mode ?? "BASE",
          stale: schema?.stale ?? false,
          completeness: schema?.completeness?.status ?? null,
          roles,
          tuples,
          labels: labels.current,
        }),
      );
    },
    [relations],
  );

  /**
   * Load the two read contracts together when either obligation surface is
   * opened — or a demand is read. The values remain separate: `/world/demand`
   * is legacy Purpose demand, while `/world/obligations` is the durable
   * governed set. Reading on selection as well as on open is what keeps a
   * field demand from showing its loading frame forever: without it the
   * document nobody asked for never arrives.
   */
  useEffect(() => {
    const wantsFrontier =
      table?.kind === "frontier" ||
      table?.kind === "governed" ||
      selection?.kind === "demand";
    if (wantsFrontier) setFrontierRequested(true);
  }, [table?.kind, selection]);

  // Once requested, these reads belong to the mounted World, not to the
  // selection that opened them. Navigation must not discard their answers.
  useEffect(() => {
    if (!frontierRequested) return;
    let cancelled = false;
    worldApi
      .demand()
      .then((found) => {
        if (cancelled) return;
        setLegacyDemand(found);
        setDemandSettled(true);
      })
      .catch((problem: Error) => {
        if (cancelled) return;
        setDemandProblem(problem.message);
        setDemandSettled(true);
      });
    worldApi
      .obligations()
      .then((read) => !cancelled && setGovernedObligations(read.obligations))
      .catch((problem: Error) => !cancelled && setGovernedProblem(problem.message));
    return () => {
      cancelled = true;
    };
  }, [frontierRequested]);

  /** Obligations by the key the field knows them under. */
  const obligations = useMemo(() => {
    const out = new Map<string, Obligation>();
    (legacyDemand?.obligations ?? []).forEach((obligation, index) =>
      out.set(`demand#${index}`, { ...obligation, key: `demand#${index}` }),
    );
    return out;
  }, [legacyDemand]);

  const governed = useMemo(
    () => (governedObligations ?? []).map((obligation) => ({
      ...obligation,
      key: obligation.obligation_id,
    })),
    [governedObligations],
  );

  /** Read a durable governed Obligation in its semantic inspection panel. */
  const onFocusGovernedObligation = useCallback(
    async (obligation: GovernedObligation) => {
      const request = ++governedRequest.current;
      setSelectedObligation(obligation);
      setObligationInspection(null);
      setObligationProblem(null);
      setReaderOpen(true);
      setSelection(null);
      try {
        const found = await worldApi.obligation(obligation.obligation_id);
        if (governedRequest.current !== request) return;
        if (found) setObligationInspection(found);
        else setObligationProblem("This Obligation is not present in the sealed World.");
      } catch (problem) {
        if (governedRequest.current !== request) return;
        setObligationProblem((problem as Error).message);
      }
    },
    [],
  );

  /**
   * A legacy Purpose demand is put on the field (§8.7).
   *
   * Unresolved, it lands as a hollow chip: there is no assertion to read, so
   * the mark *is* the demand. Resolved, it is an ordinary assertion and is
   * drawn as one. Governed Obligations use the inspection panel above and do
   * not enter this legacy field state.
   */
  const onFocusLegacyObligation = useCallback(
    async (obligation: Obligation) => {
      const request = ++governedRequest.current;
      setSelectedObligation(null);
      setObligationInspection(null);
      const schema = relations.find((item) => item.name === obligation.relation);
      if (!schema) {
        setNotice(`${obligation.relation} is not in this world's vocabulary.`);
        return;
      }
      if (obligation.state === "ASSERTED" && obligation.assertion_id) {
        try {
          const found = await worldApi.assertion(obligation.assertion_id);
          if (governedRequest.current !== request) return;
          setShow((current) => reveal(schema, current));
          setSet((current) =>
            place(current, {
              relation: found.relation,
              mode: found.mode,
              stale: found.relation_stale,
              completeness: found.completeness?.status ?? null,
              roles: found.roles,
              tuple: {
                assertion_id: obligation.assertion_id as string,
                origin: found.origin,
                origins: found.origins,
                values: found.values,
              },
              labels: labels.current,
            }),
          );
          chooseFieldMark({
            kind: "assertion",
            id: obligation.assertion_id,
          });
          revealMark(obligation.assertion_id);
        } catch (problem) {
          if (governedRequest.current !== request) return;
          setNotice((problem as Error).message);
        }
        return;
      }
      setShow((current) => ({ ...current, unresolved: true }));
      setSet((current) =>
        placeDemand(current, {
          key: obligation.key,
          relation: obligation.relation,
          roles: schema.roles,
          values: obligation.values,
          labels: labels.current,
        }),
      );
      chooseFieldMark({ kind: "demand", id: obligation.key });
      revealMark(obligation.key);
    },
    [chooseFieldMark, relations, revealMark],
  );

  /** What is already on the field, so a row can say so — see §11. */
  const present = useMemo(() => {
    const ids = new Set<string>(set.assertions.keys());
    for (const bond of set.bonds) ids.add(bond.assertion_id);
    for (const key of set.demands.keys()) ids.add(key);
    return ids;
  }, [set]);

  /**
   * Relations standing on the field in full — `present` at relation grain.
   *
   * The catalogue row carries the same margin rule as an extension row, but
   * only for full coverage: a relation with half its tuples placed is not
   * present, it is half read. Obligations are not world tuples, so demands
   * never count toward their relation's fullness.
   */
  const complete = useMemo(() => {
    const counts = new Map<string, number>();
    const tally = (relation: string) =>
      counts.set(relation, (counts.get(relation) ?? 0) + 1);
    for (const assertion of set.assertions.values()) tally(assertion.relation);
    for (const bond of set.bonds) tally(bond.relation);
    return new Set(
      relations
        .filter(
          (item) => item.count > 0 && (counts.get(item.name) ?? 0) >= item.count,
        )
        .map((item) => item.name),
    );
  }, [relations, set]);

  /**
   * Relations with anything on the field — the grain the footer's clear
   * disables at. Demands never count: they are not world tuples, so no
   * extension table can clear them.
   */
  const relationsOnField = useMemo(() => {
    const names = new Set<string>();
    for (const assertion of set.assertions.values()) names.add(assertion.relation);
    for (const bond of set.bonds) names.add(bond.relation);
    return names;
  }, [set]);

  /**
   * The selection the reader is showing — the first reading law. It lags
   * `selection` while the new subject's detail is still in flight, so a
   * subject change is one exchange and never the loading frame between them.
   *
   * A demand's detail is the frontier document, not a per-subject read, so it
   * is ready when that document has settled — landed or failed — rather than
   * at once. And the first read advances at once: the loading frame inside an
   * opening drawer names the subject being read, which is honest, while
   * holding it would open on the empty column, which claims nothing is
   * selected while a mark is.
   */
  const readerSelection = useLagging(
    selection,
    (next, shown) =>
      next === null ||
      shown === null ||
      !selectionSurvived(shown, set) ||
      (next.kind === "demand"
        ? demandSettled
        : detailProblems.has(`${next.kind}:${next.id}`) ||
          (next.kind === "referent" && referent?.id === next.id) ||
          (next.kind === "assertion" &&
            assertion?.assertion_id === next.id)),
    sameSelection,
  );
  // A retained subject reads its own cached detail. The in-flight detail
  // states below only say whether the target has answered; they may be null
  // or already belong to a different subject.
  const readerAssertion = readerSelection?.kind === "assertion"
    ? detailCache.current.assertions.get(readerSelection.id) ?? null
    : null;
  const readerReferent = readerSelection?.kind === "referent"
    ? detailCache.current.referents.get(readerSelection.id) ?? null
    : null;

  /**
   * Whether the open assertion has a second drawing, and which way.
   *
   * Asked of the field rather than of the tuple: the same assertion is
   * foldable when it is standing on the field and nothing at all when it is
   * only a row in a table, because there is no line to open.
   */
  const framed = useFrames(
    set,
    relations,
    overview?.revision ?? null,
    overview?.world_id ?? null,
    framing,
    framedOpen,
  );
  /**
   * Read off what is drawn, so the offer matches the mark: under framing a
   * claim's binary reading can exist only in the view.
   */
  const folding = useMemo(
    () =>
      readerSelection?.kind === "assertion"
        ? foldingOf(framed.view, readerSelection.id)
        : null,
    [framed.view, readerSelection],
  );

  /**
   * Redraw one tuple in its other form.
   *
   * No refetch and no re-layout: both forms are already on the field, and the
   * plate lands on the line's own midpoint. The reader does not change either
   * — it was showing the tuple's roles all along, which is the argument for
   * the feature: opening puts on the field what the panel already knew.
   */
  const onFold = useCallback((id: string) => {
    if (framed.reprojected.has(id)) {
      // Toggling toward the plate seeds the canvas with where the bond's
      // name stood; toggling back onto the line needs no seat.
      setFoldSeed(framedOpen.has(id) ? null : { id });
      setFramedOpen((current) => {
        const next = new Set(current);
        if (next.has(id)) next.delete(id);
        else next.add(id);
        return next;
      });
      return;
    }
    // An opening seeds the canvas; a collapse draws the line it always drew.
    setFoldSeed(foldingOf(set, id) === "open" ? { id } : null);
    setSet((current) =>
      foldingOf(current, id) === "open" ? openBond(current, id) : collapse(current, id),
    );
  }, [framed.reprojected, framedOpen, set]);

  /**
   * Take a mark off the field, the moment it is asked for.
   *
   * Removal begins on the press, not the release: the set changes in the same
   * tick, the ring stands down with its mark, and the collapse plays from the
   * set change. There is nothing to stage and no second phase — a tap, a
   * click, a hold, Delete and take-off all land here, so they all remove the
   * same way. A press on what is already gone (a fading element mid-collapse,
   * a repeated delivery) is ignored.
   */
  const removeMark = useCallback(
    (mark: NonNullable<CanvasSelection>) => {
      const onField =
        mark.kind === "referent"
          ? set.referents.has(mark.id)
          : mark.kind === "demand"
            ? set.demands.has(mark.id)
            : set.assertions.has(mark.id) ||
              set.bonds.some((bond) => bond.assertion_id === mark.id);
      if (!onField) return;
      if (mark.kind === "referent") {
        expansionGeneration.current += 1;
        expansionsInFlight.current.clear();
        dispatchExpansion({ type: "reset" });
      }
      const next = dropMark(set, mark.id);
      setSet(next);
      // If it went down with the mark — directly or in the cascade — it and
      // its reader go too; otherwise both stay where they were.
      const survived = selection ? selectionSurvived(selection, next) : false;
      if (selection && !survived) {
        setSelection(null);
        setReaderOpen(false);
      }
    },
    [selection, set],
  );

  const onRemove = useCallback(() => {
    if (!selection) return;
    removeMark(selection);
  }, [removeMark, selection]);

  /**
   * Everything of one relation, off the field — the footer's inverse of add
   * all. Assertions and bonds go, and so do referents nothing references
   * anymore: a clear promises the relation is gone from the field, not that
   * its discs stand around empty. A disc another relation still names stays.
   *
   * Bulk only. A single take-off deliberately leaves its context standing;
   * clearing is the action that says the whole neighborhood went with it.
   */
  const clearRelation = useCallback(
    (relation: string) => {
      const ids = new Set<string>();
      for (const [id, assertion] of set.assertions) {
        if (assertion.relation === relation) ids.add(id);
      }
      for (const bond of set.bonds) {
        if (bond.relation === relation) ids.add(bond.assertion_id);
      }
      if (!ids.size) return;
      let next = set;
      for (const id of ids) next = dropMark(next, id);
      const used = new Set<string>();
      for (const assertion of next.assertions.values()) {
        for (const spoke of assertion.spokes) used.add(spoke.id);
      }
      for (const demand of next.demands.values()) {
        for (const spoke of demand.spokes) used.add(spoke.id);
      }
      for (const bond of next.bonds) {
        used.add(bond.source);
        used.add(bond.target);
      }
      let pruned = false;
      for (const id of [...next.referents.keys()]) {
        if (!used.has(id)) {
          next = dropMark(next, id);
          pruned = true;
        }
      }
      if (pruned) {
        expansionGeneration.current += 1;
        expansionsInFlight.current.clear();
        dispatchExpansion({ type: "reset" });
      }
      setSet(next);
      const survived = selection ? selectionSurvived(selection, next) : false;
      if (selection && !survived) {
        setSelection(null);
        setReaderOpen(false);
      }
    },
    [selection, set],
  );

  /**
   * One row off the field — the extension's per-row inverse of place. A
   * single take-off, so its context stays standing; see `clearRelation`.
   */
  const takeOffTuple = useCallback(
    (assertionId: string) => {
      removeMark({ kind: "assertion", id: assertionId });
    },
    [removeMark],
  );

  /**
   * The whole field, emptied — the catalogue footer's clear.
   *
   * The counterpart to clearing one relation: where that leaves referents
   * standing the way a take-off does, this leaves nothing at all, which is
   * what the top level is for.
   */
  const clearField = useCallback(() => {
    expansionGeneration.current += 1;
    expansionsInFlight.current.clear();
    dispatchExpansion({ type: "reset" });
    setSet(emptySet());
    setSelection(null);
    setPast([]);
    setHovered(null);
    setReaderOpen(false);
    // Back to the state the surface starts in. The vocabulary follows from the
    // field being empty and is not set here; the dock is, because a person
    // asked for an empty field and the catalogue is what refills it.
    setTablesOpen(true);
  }, []);

  /**
   * Arrangement: the two ways a person may re-place matter already standing.
   *
   * Both suspend `existing marks never move`, so both are things someone
   * clicked, both record what they displaced, and neither happens on its own.
   * `arrangeToken` is what tells the canvas this frame is the exception, so
   * the marks that move do it with `settle` — a body finding a new rest —
   * rather than the pointer-direct `hold` every other standing update uses.
   */
  const applyArrange = useCallback(
    (request: Arrangement, label: string) => {
      const next = arrange(set, request);
      if (next === set) return;
      const displaced = new Map<string, Point>();
      for (const [id, was] of set.positions) {
        const now = next.positions.get(id);
        if (now && (now.x !== was.x || now.y !== was.y)) displaced.set(id, was);
      }
      if (!displaced.size) return;
      setArrangeUndo({ label, positions: displaced });
      setArrangeToken((token) => token + 1);
      setSet(next);
    },
    [set],
  );

  // No `gather` here while the reader withholds it. The arrangement itself is
  // intact in `workingSet`, so restoring the control is restoring these three
  // lines and the button, not rebuilding a behaviour.
  const onSeparate = useCallback(
    () => applyArrange({ kind: "separate" }, "separate"),
    [applyArrange],
  );
  const onUndoArrange = useCallback(() => {
    if (!arrangeUndo) return;
    const restore = arrangeUndo.positions;
    setArrangeToken((token) => token + 1);
    setSet((current) => ({
      ...current,
      positions: new Map([...current.positions, ...restore]),
    }));
    setArrangeUndo(null);
  }, [arrangeUndo]);

  /**
   * An undo survives only while the field it belongs to does.
   *
   * Keyed on membership rather than on positions, because an arrangement
   * changes positions and must not clear its own undo the moment it lands.
   */
  const fieldMembership = `${set.referents.size}:${set.assertions.size}:${set.demands.size}:${set.bonds.length}`;
  useEffect(() => {
    setArrangeUndo(null);
  }, [fieldMembership]);

  const enterVocabulary = useCallback(() => {
    setVocabularyFocus(true);
    setReaderOpen(false);
  }, []);

  const leaveVocabulary = useCallback(() => {
    setVocabularyFocus(false);
    setReaderOpen(Boolean(selection));
  }, [selection]);

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      // Escape leaves the vocabulary *room*. On the default screen there is no
      // room to leave — behind it is an empty field, which is not a place.
      if (event.key === "Escape" && vocabularyFocus && fieldSize(set)) {
        event.preventDefault();
        leaveVocabulary();
        return;
      }
      if (event.key !== "Backspace" && event.key !== "Delete") return;
      const target = event.target as HTMLElement | null;
      if (target?.closest("input, textarea, [contenteditable='true']")) return;
      if (!selection || vocabularyFocus) return;
      event.preventDefault();
      onRemove();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [leaveVocabulary, onRemove, selection, set, vocabularyFocus]);

  const visibleRelations = useMemo(
    () => relations.filter((item) => relationShown(item, effectiveShow)),
    [relations, effectiveShow],
  );
  /**
   * Chrome, matter, focus and the motion spine, on the one element everything
   * below inherits from. `worldChrome.ts` owns the composition so the inspector
   * uses one coherent visual vocabulary.
   */
  const style = {
    ...worldShellStyle(mode, { focus: focusDrawn, motion }),
    ...worldChromeDockVars({ tablesWidth, readerWidth }),
  };
  const onField = hasField;
  const relation = relations.find((item) => item.name === focusedRelation) ?? null;
  /**
   * The reader's subject, as one token.
   *
   * A subject change while the dock is already out is a REPLACED, not an
   * arrival: the column stays where it is and its contents are exchanged. The
   * token is what `Swap` compares, so it has to name the *subject* rather than
   * the panel — two referents in a row are two subjects through one panel.
   */
  const readerSubject = selectedObligation
    ? `obligation:${selectedObligation.obligation_id}`
    : onField && readerSelection
    ? `${readerSelection.kind}:${readerSelection.id}`
    : relation
      ? `relation:${relation.name}`
      : "reader:empty";
  /**
   * What the header's back chip is offered on, everywhere it appears.
   *
   * One step down the trail, or nothing while the trail is empty — every
   * panel shares the header, so every panel shares the offer, including the
   * empty column, where back is the way to the last thing read.
   */
  const onBack = past.length ? goBack : null;
  /**
   * Whether the shown subject stands on the field, for the footer that would
   * take it off. The same question `removeMark` asks before acting, so a
   * mark the footer cannot remove is a mark the footer does not offer to.
   */
  const shownOnField = readerSelection
    ? selectionSurvived(readerSelection, set)
    : false;
  /**
   * The notice is a thing that arrives and leaves, so it does both.
   *
   * `useHeld` keeps the text while the absorb runs — without it the strip
   * empties on the frame it is told to go, and what you see is a blank bar
   * fading rather than the message leaving.
   */
  const noticePresence = usePresence(Boolean(notice));
  const noticeHeld = useHeld(notice, noticePresence.mounted);
  const activeRelation = hoveredRelation ?? focusedRelation;
  const extension =
    table?.kind === "relation"
      ? relations.find((item) => item.name === table.relation) ?? null
      : null;
  /** The same, for the TABLES dock. A derivation is keyed by what it is of. */
  const tableSubject =
    table.kind === "relation"
      ? `relation:${table.relation}`
      : table.kind === "derivation"
        ? `derivation:${table.relation}\u0000${table.assertion ?? ""}`
        : table.kind;
  const navigationFocus = useNavigationFocus({
    reader: readerSubject, table: tableSubject, readerOpen, tablesOpen,
  });
  const cameraInsets = useMemo<CameraInsets>(
    () =>
      worldCameraInsets({
        focus: focusDrawn,
        // Whether the field is really empty — the same boolean the shell
        // class uses — not the drawn view. A fielded vocabulary hides its
        // dock like every other focus room, so insets that reserved it
        // would frame the schema for a panel that is not there. The flip
        // lands with the value swap, past the gap, which is when the
        // unparked camera reads it.
        unfielded: !onField,
        tablesOpen,
        tablesWidth,
        readerOpen,
        readerWidth,
      }),
    [readerOpen, readerWidth, tablesOpen, tablesWidth, focusDrawn, onField],
  );

  return (
    <main
      className={`product-shell world${hidden ? " is-chrome-hidden" : ""}${mode === "dark" ? " is-dark" : ""}${focusDrawn ? " is-focus" : ""}${onField ? "" : " is-unfielded"}${motionReady ? " is-motion-ready" : ""}`}
      {...navigationFocus}
      style={style}
      data-mode={mode}
    >
      <header className={chromeClass("product-shell__top")}>
        <div className="product-shell__bar">
          <span
            className="product-shell__workspace"
            title={
              overview && shownRevision(overview.reading, overview.revision) === null
                ? "World identifier. The revision is the generic adapter's default, not one the database's producer recorded: it is not shown here (see Reading attribution)."
                : "World identifier and current revision"
            }
            aria-label={
              overview
                ? shownRevision(overview.reading, overview.revision) === null
                  ? `World ${overview.world_id}`
                  : `World ${overview.world_id}, revision ${overview.revision}`
                : "World"
            }
          >
            {overview
              ? shownRevision(overview.reading, overview.revision) === null
                ? overview.world_id
                : `${overview.world_id} · rev ${overview.revision}`
              : "world"}
          </span>
          <ReadingBadge reading={overview?.reading} />
          <div className="product-shell__utils">
            <button
              type="button"
              className="product-shell__theme"
              onClick={() => {
                const next = mode === "light" ? "dark" : "light";
                setLocalMode(next);
              }}
              aria-label={`Use ${mode === "light" ? "dark" : "light"} appearance`}
            >
              {mode === "light" ? "dark" : "light"}
            </button>
          </div>
          {onField ? (
            <span className="product-shell__local world__occupancy">
              {fieldSize(set)} on field
            </span>
          ) : null}
          {onField
            ? framed.frames.map((frame) => (
                <button
                  key={frame.id}
                  type="button"
                  className="product-shell__local world__frame"
                  title={`The field is framed by ${frame.label}${
                    frame.held ? `; ${frame.held} claims are about it alone` : ""
                  }`}
                  aria-label={`Open frame ${frame.label}`}
                  onClick={() => chooseFieldMark({ kind: "referent", id: frame.id })}
                >
                  <span className="world__frame-name">in {frame.label}</span>
                  <span className="world__frame-open" aria-hidden="true">
                    open
                  </span>
                </button>
              ))
            : null}
        </div>
      </header>

      <div className="product-shell__body">
        <div className="product-shell__scenes">
          <div className="product-shell__scene is-in">
            <div className="gm gm--product">
            <div className="gm__main">
              <OverlayPanel
                id="world-tables"
                side="left"
                title="Tables"
                open={tablesOpen}
                onToggle={setTablesOpen}
                handleWhen="closed"
                width={tablesWidth}
                onWidthChange={onTablesWidth}
                minWidth={280}
                maxWidth={640}
                reserve={focusDrawn ? 0 : readerOpen ? readerWidth : 0}
                flush
              >
                <Swap id={tableSubject} className="motion-swap--fill">
                  {table.kind === "world" ? (
                    <WorldTable
                      neutral={neutral}
                      overview={overview}
                      relations={relations}
                      complete={complete}
                      chrome={tableChrome}
                      onClearField={clearField}
                      clearable={fieldSize(set) > 0}
                      onField={relationsOnField}
                      onTakeOffRelation={clearRelation}
                      onOpen={(name) => {
                        const schema = relations.find(
                          (item) => item.name === name,
                        );
                        if (schema) setShow((current) => reveal(schema, current));
                        setFocusedRelation(name);
                        revealMark(name);
                        showTable({
                          kind: "relation",
                          relation: name,
                          subject: null,
                        });
                      }}
                    />
                  ) : table.kind === "governed" ? (
                    <GovernedObligationTable
                      obligations={governed}
                      problem={governedProblem}
                      settled={
                        governedObligations !== null ||
                        governedProblem !== null
                      }
                      chrome={tableChrome}
                      onFocus={onFocusGovernedObligation}
                    />
                  ) : table.kind === "frontier" ? (
                    <FrontierTable
                      demand={legacyDemand}
                      relations={relations}
                      problem={demandProblem}
                      settled={demandSettled}
                      present={present}
                      chrome={tableChrome}
                      onFocus={onFocusLegacyObligation}
                    />
                  ) : table.kind === "relation" && !extension ? (
                    // A subject with nothing behind it still keeps its bar.
                    // Rendering nothing at all is how the change subject used
                    // to strand a reader: the panel emptied, and with it went
                    // the way back to world and frontier.
                    <section className="table" aria-label={table.relation}>
                      <TableBar chrome={tableChrome} title={table.relation} />
                      <p className="table__rule">
                        This world has no relation by that name.
                      </p>
                    </section>
                  ) : extension && table.kind === "relation" ? (
                    <RelationTable
                      key={extension.name}
                      relation={extension}
                      subject={table.subject}
                      reading={overview?.reading}
                      present={present}
                      onFocus={onFocusRow}
                      onTakeOff={takeOffTuple}
                      onPlaceMany={placeMany}
                      onBulkActive={setBulkActive}
                      onClearRelation={clearRelation}
                      clearable={relationsOnField.has(extension.name)}
                      onWiden={() =>
                        showTable({
                          kind: "relation",
                          relation: extension.name,
                          subject: null,
                        })
                      }
                      onDerivation={() =>
                        showTable({
                          kind: "derivation",
                          relation: extension.name,
                          assertion: null,
                        })
                      }
                      chrome={tableChrome}
                    />
                  ) : table.kind === "derivation" ? (
                    <DerivationView
                      key={`${table.relation}\u0000${table.assertion ?? ""}`}
                      reading={overview?.reading}
                      relation={table.relation}
                      assertionId={table.assertion}
                      present={present}
                      onOpen={(name) =>
                        showTable({
                          kind: "derivation",
                          relation: name,
                          assertion: null,
                        })
                      }
                      onTable={(name) =>
                        showTable({
                          kind: "relation",
                          relation: name,
                          subject: null,
                        })
                      }
                      onFocus={placeTuple}
                      chrome={tableChrome}
                    />
                  ) : null}
                </Swap>
              </OverlayPanel>
              {/* The plane is the slot the two views share. It absorbs the
                  one that is leaving, the palette flips while it is dark, and
                  it emits the one that arrives — `useSequencedSwap`. */}
              <div
                className={`gm__stage world__plane motion-layer motion-layer--fade${
                  focusView.shown ? " is-in" : ""
                }`}
              >
                {error ? (
                  <div className="world__error">
                    <ProblemNotice message={error} />
                  </div>
                ) : (
                  <>
                    {/* The drawn view, not the field state: during the absorb
                        gap the old view is still mounted and fading, and the
                        swap lands with the palette under darkness. Keyed on
                        the field instead, the canvas hard-cut to the new view
                        in the old palette, then dipped it out and in. Focus
                        with a field behind it keeps the world mounted but
                        parked, so toggling back never rebuilds it. */}
                    {!focusDrawn || (onField && vocabularyFocus) ? (
                      <div
                        className={`world__layer${focusDrawn ? " is-parked" : ""}`}
                        inert={focusDrawn || undefined}
                      >
                        <WorldCanvas
                          set={framed.view}
                          mode={mode}
                          params={MARK_DEFAULTS}
                          hovered={hovered}
                          selection={selection}
                          show={effectiveShow}
                          focusId={focus?.id ?? null}
                          focusToken={focus?.token ?? 0}
                          focusWith={focus?.with}
                          arrangeToken={arrangeToken}
                          foldSeed={foldSeed}
                          animateInitial={Boolean(selection)}
                          still={bulkActive || stillHolds > 0}
                          insets={cameraInsets}
                          motion={motion}
                          spreadOnSelect={spreadOnSelect}
                          light={undefined}
                          world={overview?.world_id ?? null}
                          revision={overview?.revision ?? null}
                          onHover={setHovered}
                          onSelect={chooseFieldMark}
                          onPositions={onPositions}
                          onRemove={removeMark}
                        />
                      </div>
                    ) : null}
                    {/* Both canvases stay mounted, and the one that is not in
                        view is parked rather than unmounted. Unmounting it
                        destroyed a G6 graph on every focus toggle, which
                        raced its own in-flight draw ("the graph instance has
                        been destroyed") and meant the vocabulary had to be
                        rebuilt before it could be shown — during the gap the
                        swap leaves for exactly that. A vocabulary is bounded
                        by the world's relations, not its field, so the
                        second graph is cheap to simply keep. */}
                    <div
                      className={`world__layer${!focusDrawn ? " is-parked" : ""}`}
                      inert={!focusDrawn || undefined}
                    >
                        <SchemaCanvas
                          relations={visibleRelations}
                          mode={mode}
                          namedAtRest={namedAtRest}
                          inverted={focusDrawn}
                          active={activeRelation}
                          selected={focusedRelation}
                          focusId={focus?.id ?? null}
                          focusToken={focus?.token ?? 0}
                          insets={cameraInsets}
                          world={overview?.world_id ?? null}
                          revision={overview?.revision ?? null}
                          onHover={setHoveredRelation}
                          onSelect={chooseSchemaRelation}
                        />
                    </div>
                  </>
                )}
              </div>

            <OverlayPanel
              id="world-reader"
              side="right"
              title="World reader"
              open={readerOpen}
              onToggle={setReaderOpen}
              handle={false}
              width={readerWidth}
              onWidthChange={onReaderWidth}
              reserve={
                focusDrawn
                  ? 0
                  : tablesOpen
                    ? tablesWidth
                    : TABLES_HANDLE_RESERVE
              }
              flush
            >
              <div className="node-reader">
                {noticePresence.mounted ? (
                  <div
                    className={`world__notice motion-layer motion-layer--rise${
                      noticePresence.shown ? " is-in" : ""
                    }`}
                  >
                    {noticeHeld?.includes("\n") ? <ProblemNotice message={noticeHeld} /> : <span role="status">{noticeHeld}</span>}
                  </div>
                ) : null}
                <Swap id={readerSubject} className="motion-swap--fill">
                  {selectedObligation ? (
                    <GovernedObligationPanel
                      obligation={
                        (obligationInspection?.obligation_id ===
                        selectedObligation.obligation_id
                          ? obligationInspection
                          : null) ?? selectedObligation
                      }
                      problem={obligationProblem}
                      onClose={() => {
                        setReaderOpen(false);
                        clearGoverned();
                      }}
                      onBack={onBack}
                    />
                  ) : onField && readerSelection?.kind === "demand" ? (
                    <DemandPanel
                      obligation={obligations.get(readerSelection.id) ?? null}
                      demand={legacyDemand}
                      problem={demandProblem}
                      settled={demandSettled}
                      roles={
                        relations
                          .find(
                            (item) =>
                              item.name ===
                              obligations.get(readerSelection.id)?.relation,
                          )
                          ?.roles.map((role) => role.name) ?? []
                      }
                      onTable={(name) =>
                        showTable({
                          kind: "relation",
                          relation: name,
                          subject: null,
                        })
                      }
                      onRemove={
                        shownOnField ? () => removeMark(readerSelection) : null
                      }
                      onClose={() => setReaderOpen(false)}
                      onBack={onBack}
                    />
                  ) : onField && readerSelection?.kind === "assertion" ? (
                    <AssertionPanel
                      reading={overview?.reading}
                      classified={classified}
                      assertion={readerAssertion}
                      problem={
                        detailProblems.get(
                          `assertion:${readerSelection.id}`,
                        ) ?? null
                      }
                      set={set}
                      folding={folding}
                      onSelect={travelTo}
                      onFold={() => onFold(readerSelection.id)}
                      onTable={(name) =>
                        showTable({
                          kind: "relation",
                          relation: name,
                          subject: null,
                        })
                      }
                      onDerivation={(name, id) =>
                        showTable({
                          kind: "derivation",
                          relation: name,
                          assertion: id,
                        })
                      }
                      onRemove={
                        shownOnField ? () => removeMark(readerSelection) : null
                      }
                      onClose={() => setReaderOpen(false)}
                      onBack={onBack}
                    />
                  ) : onField && readerSelection?.kind === "referent" ? (
                    <ReferentPanel
                      detail={readerReferent}
                      reading={overview?.reading}
                      problem={
                        detailProblems.get(`referent:${readerSelection.id}`) ??
                        null
                      }
                      set={set}
                      onSelect={travelTo}
                      requests={expansionRequests}
                      onExpand={(name) => onExpand(readerSelection.id, name)}
                      onRetract={(name) => onRetract(readerSelection.id, name)}
                      onTable={(name) =>
                        showTable({
                          kind: "relation",
                          relation: name,
                          subject: readerReferent
                            ? {
                                id: readerReferent.id,
                                label: readerReferent.label || readerReferent.id,
                              }
                            : null,
                        })
                      }
                      onDrop={() => removeMark(readerSelection)}
                      // Withheld for now. `separate` stays: it answers a
                      // question a reader actually has — two marks are sitting
                      // on top of each other — where gather re-places matter
                      // nobody asked about. The arrangement itself is kept
                      // whole in `workingSet`, so this is a surface decision
                      // and not a deletion.
                      onGather={null}
                      onClose={() => setReaderOpen(false)}
                      onBack={onBack}
                    />
                  ) : relation ? (
                    <article className="world-reader__article">
                      <ReaderHeader
                        title={relation.name}
                        kind={
                          !classified
                            ? undefined
                            : // Mode and construction absence remain separate.
                              chipKind(relation) === "unstated" && relation.mode === "DERIVED"
                              ? "derived · unstated"
                              : chipKind(relation) === "mechanical"
                                ? (shownMode(overview?.reading, relation.mode) ?? "mechanical")
                                : chipKind(relation)
                        }
                        meta={`${classified || shownMode(overview?.reading, relation.mode) === null ? "" : `${relation.mode.toLowerCase()} · `}${relation.count} tuple${relation.count === 1 ? "" : "s"} · ${relation.arity} roles${conditionOf(relation.stale, relation.completeness)}`}
                        onClose={() => setReaderOpen(false)}
                        onBack={onBack}
                      >
                        <ReadingQualifier reading={overview?.reading} />
                      </ReaderHeader>
                      <ReaderContent>
                        <RelationAttribution reading={overview?.reading} name={relation.name} />
                        {relation.description ? (
                          <p className="world-reader__description">
                            {relation.description}
                          </p>
                        ) : null}
                        <ol className="world__roles">
                          {relation.roles.map((role) => (
                            <li key={role.name}>
                              <b>{role.name}</b>
                              <span>
                                {role.referent
                                  ? role.kinds?.join(", ") || "referent"
                                  : scalarRoleType(role)}
                              </span>
                            </li>
                          ))}
                        </ol>
                        {relation.derivation?.inputs?.length ? (
                          <section className="world-reader__section">
                            <h3>Rests on</h3>
                            <ul className="world__inputs">
                              {relation.derivation.inputs.map((input) => (
                                <li key={input}>{input}</li>
                              ))}
                            </ul>
                          </section>
                        ) : null}
                      </ReaderContent>
                      <ReaderActions>
                        <ReaderAction
                          onClick={() =>
                            showTable({
                              kind: "relation",
                              relation: relation.name,
                              subject: null,
                            })
                          }
                        >
                          Open extension
                        </ReaderAction>
                        <ReaderAction
                          onClick={() =>
                            showTable({
                              kind: "derivation",
                              relation: relation.name,
                              assertion: null,
                            })
                          }
                        >
                          Dependencies
                        </ReaderAction>
                      </ReaderActions>
                    </article>
                  ) : (
                    <article className="world-reader__article">
                      <ReaderHeader
                        title="Reader"
                        meta="Select a mark on the field"
                        onClose={() => setReaderOpen(false)}
                        onBack={onBack}
                      />
                      <ReaderContent>
                        <p className="world__hint">
                          A referent, assertion, or relation names what this
                          column is about. The world catalogue, Purpose
                          frontier, and governed Obligations live in Tables.
                        </p>
                      </ReaderContent>
                    </article>
                  )}
                </Swap>
              </div>
            </OverlayPanel>
            </div>
            </div>
          </div>
        </div>
      </div>

      <Instrument>
          <div className="gm__choosing">
            <div className="instrument__group" role="group" aria-label="find">
              <Find
                directory={set.referents.size || set.assertions.size || set.demands.size || set.bonds.length ? fieldDirectory : directory}
                // Only for the seeding search, and only when the directory in
                // hand is short. Once there is a field, find is a question
                // about what is on it, and the plane has nothing to add.
                ask={
                  directoryShort &&
                  !(set.referents.size || set.assertions.size || set.demands.size || set.bonds.length)
                    ? askWorld
                    : undefined
                }
                onPick={onFind}
              />
            </div>
          </div>
          <ShowBand
            show={show}
            onShow={setShow}
            layers={showLayers}
            names={
              !onField || focusDrawn
                ? { on: namedAtRest, onToggle: () => setNamedAtRest((on) => !on) }
                : undefined
            }
            spread={
              onField && !focusDrawn
                ? {
                    on: spreadOnSelect,
                    onToggle: () => setSpreadOnSelect((on) => !on),
                  }
                : undefined
            }
            frame={
              onField && !focusDrawn
                ? { on: framing, onToggle: () => setFraming((on) => !on) }
                : undefined
            }
          />
          {!focusDrawn && onField ? (
            <div
              className="instrument__group"
              role="group"
              aria-label="Arrange the field"
            >
              {/* Withheld for now; retain the control and arrangement handler. */}
              {false && <button
                type="button"
                onClick={onSeparate}
                title="Push apart only what is sitting on top of something else"
              >
                separate
              </button>}
              {arrangeUndo ? (
                <button
                  type="button"
                  onClick={onUndoArrange}
                  title={`Put back what ${arrangeUndo.label} displaced`}
                >
                  undo {arrangeUndo.label}
                </button>
              ) : null}
            </div>
          ) : null}
          {/*
            * `clear` leaves the vocabulary for the field, so it is offered only
            * when there is a field to leave for. On the default screen the
            * vocabulary is not a mode someone entered; it is the screen.
            */}
          {focusDrawn && onField ? (
            <div className="instrument__group" role="group" aria-label="Clear focus">
              <button type="button" onClick={leaveVocabulary}>
                clear
              </button>
            </div>
          ) : onField ? (
            <div className="instrument__group" role="group" aria-label="Field">
              <button type="button" onClick={enterVocabulary}>
                vocabulary
              </button>
            </div>
          ) : null}
        </Instrument>
    </main>
  );
}
