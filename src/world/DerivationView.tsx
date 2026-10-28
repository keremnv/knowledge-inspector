/**
 * §8.6, the derivation explorer — and §21's unanswered question.
 *
 * Everywhere else the product has said `rests on: lifecycle,
 * temperature_compatible, voltage_compatible` and stopped, which is one hop of
 * an answer to "why is this here" and no answer at all to "what depends on
 * this". Both are the same edge table read from opposite ends, so this surface
 * draws both, transitively, from wherever you opened it.
 *
 * Three things sit here and they are deliberately different in kind:
 *
 * - **The closure** is structure the world declares. It is exact.
 * - **The run** is history the world recorded: the version and cardinality of
 *   every input as it stood the last time this derivation executed, beside the
 *   same relation now. Where one has moved, that is the reason the output is
 *   suspect, named — staleness with an account rather than a flag.
 * - **The candidates** are a search. No table in this world records which input
 *   rows produced an output row, so nothing here claims lineage; what is shown
 *   is which input tuples mention the same referents, ranked by how many. The
 *   SQL beside them is the recorded truth about how they combine.
 *
 * The third is kept visibly separate from the first two because collapsing a
 * search into a structural claim is exactly the failure this product exists to
 * avoid.
 */

import { useEffect, useState, type ReactNode } from "react";
import { usePresence } from "../styles/usePresence";
import { ProblemNotice } from "./ProblemNotice";
import { shownMode } from "./ReadingAttribution";
import { Scalar, scalarLabel } from "./scalar";
import {
  worldApi,
  type WorldDerivation,
  type WorldReading,
  type WorldRole,
  type WorldSupport,
  type WorldTuple,
} from "../api/world";
import { TableBar, type TableChrome } from "./tableChrome";

/** Deep enough to read a real dependency chain; shallow enough to stay a tree. */
const MAX_DEPTH = 6;

type Branch = {
  /** The path that reached this node, which is the only unique thing about it. */
  path: string;
  name: string;
  prefix: string;
};

/**
 * The closure, as the lines §8.6 draws it with.
 *
 * A relation can be reached along two paths — `part_type` feeds both
 * compatibility relations — and both are drawn, because dropping the second
 * would misreport the shape of the computation. What is guarded is a cycle:
 * a name already on the path it is being reached from stops there.
 */
function flatten(root: string, adjacency: Record<string, string[]>): Branch[] {
  const out: Branch[] = [];
  const walk = (name: string, prefix: string, path: string[], depth: number) => {
    const reached = adjacency[name] ?? [];
    if (depth >= MAX_DEPTH) return;
    reached.forEach((child, index) => {
      const last = index === reached.length - 1;
      const here = [...path, child];
      out.push({
        path: here.join(">"),
        name: child,
        prefix: `${prefix}${last ? "└─ " : "├─ "}`,
      });
      if (path.includes(child)) return;
      walk(child, `${prefix}${last ? "   " : "│  "}`, here, depth + 1);
    });
  };
  walk(root, "", [root], 0);
  return out;
}

function Tree({
  root,
  adjacency,
  nodes,
  empty,
  onOpen,
  reading,
}: {
  root: string;
  adjacency: Record<string, string[]>;
  nodes: WorldDerivation["nodes"];
  empty: string;
  onOpen: (relation: string) => void;
  reading?: WorldReading;
}) {
  const branches = flatten(root, adjacency);
  if (!branches.length) return <p className="deriv__note">{empty}</p>;
  return (
    <ul className="deriv__tree">
      {branches.map((branch) => {
        const node = nodes[branch.name];
        return (
          <li key={branch.path}>
            <span className="deriv__rule">{branch.prefix}</span>
            <button type="button" onClick={() => onOpen(branch.name)}>
              {branch.name}
            </button>
            <span className="deriv__of">
              {node ? [shownMode(reading, node.mode), node.count].filter((bit) => bit !== null).join(" · ") : ""}
              {node?.stale ? " · stale" : ""}
            </span>
          </li>
        );
      })}
    </ul>
  );
}

/**
 * The rule, disclosed.
 *
 * Two things had to be true for this to stop jolting. It stays mounted through
 * the absorb, because a `<pre>` that unmounts on the closing frame has no
 * transition to run and just leaves a hole. And what animates is the *row*, not
 * the block: `--rise` moves opacity and transform only, so the SQL would still
 * have claimed its full height on the opening frame and shoved the whole
 * closure down before fading in. A `0fr → 1fr` grid row carries the height with
 * no measurement and no hard-coded max.
 *
 * A person pressed `rule`, so this is a caused change and it is allowed to
 * move. Its time and curve are the spine's, like everything else.
 */
function Sql({ sql, open }: { sql: string; open: boolean }) {
  const presence = usePresence(open);
  if (!presence.mounted || !sql) return null;
  return (
    <div
      className={`deriv__disclosure${presence.shown ? " is-in" : ""}`}
      aria-hidden={presence.shown ? undefined : true}
    >
      {/* The grid item carries no padding of its own, so `min-height: 0`
          actually takes it to zero; the `<pre>` keeps its padding inside. */}
      <div className="deriv__clip">
        <pre className="deriv__sql">{sql}</pre>
      </div>
    </div>
  );
}

export function DerivationView({
  relation,
  assertionId,
  present,
  onOpen,
  onTable,
  onFocus,
  chrome,
  reading,
}: {
  relation: string;
  /** Set when this was opened from one tuple, which is what candidates need. */
  assertionId: string | null;
  present: Set<string>;
  onOpen: (relation: string) => void;
  onTable: (relation: string) => void;
  /** The input relation is passed with the row: role names repeat across
   *  relations, and guessing the owner from them picks the wrong one. */
  onFocus: (relation: string, roles: WorldRole[], tuple: WorldTuple) => void;
  chrome: TableChrome;
  /** The World's reading descriptor, when it has one: it says which values are adapter defaults. */
  reading?: WorldReading;
}) {
  const [closure, setClosure] = useState<WorldDerivation | null>(null);
  const [support, setSupport] = useState<WorldSupport | null>(null);
  const [problem, setProblem] = useState<string | null>(null);
  const [supportProblem, setSupportProblem] = useState<string | null>(null);
  const [showSql, setShowSql] = useState(false);

  useEffect(() => {
    let cancelled = false;
    setClosure(null);
    setSupport(null);
    setProblem(null);
    setSupportProblem(null);
    worldApi
      .derivation(relation)
      .then((answer) => {
        if (!cancelled) setClosure(answer);
      })
      .catch((failure: Error) => {
        if (!cancelled) setProblem(failure.message);
      });
    // Candidates are a second, heavier read and only mean something for a
    // tuple, so they are asked for separately and their failure is not the
    // closure's failure.
    if (assertionId) {
      worldApi
        .support(assertionId)
        .then((answer) => {
          if (!cancelled) setSupport(answer);
        })
        .catch((failure: Error) => {
          if (!cancelled) setSupportProblem(failure.message);
        });
    }
    return () => {
      cancelled = true;
    };
  }, [relation, assertionId]);

  const run = closure?.run ?? null;
  const nodes = closure?.nodes ?? {};
  const self = nodes[relation];

  return (
    <section className="table deriv" aria-label={`${relation} derivation`}>
      <TableBar
        chrome={chrome}
        title={relation}
        meta={
          <>
            {self ? [shownMode(reading, self.mode), self.count].filter((bit) => bit !== null).join(" · ") : ""}
            {run ? ` · ${run.state.toLowerCase()}` : ""}
            {self?.stale ? " · stale" : ""}
          </>
        }
      >
        {run ? (
          <button
            type="button"
            data-active={showSql ? "true" : undefined}
            onClick={() => setShowSql((on) => !on)}
          >
            rule
          </button>
        ) : null}
        <button type="button" onClick={() => onTable(relation)}>
          extension
        </button>
      </TableBar>

      {problem ? <ProblemNotice message={problem} title="Unable to load derivation" /> : null}
      {supportProblem ? <ProblemNotice message={supportProblem} title="Unable to load supporting tuples" /> : null}

      <div className="deriv__scroll">
        <Sql sql={run?.sql ?? ""} open={showSql && Boolean(run)} />

        {/*
          * One line while the closure is in flight, and the trees emit when it
          * lands — the second and fifth reading laws. It used to emit the two
          * headings over nothing and then snap the trees, the run table and
          * the bar's meta in together when the fetch landed: a cross-fade to
          * an empty skeleton followed by an uncaused jump. Nothing here is a
          * `flow`; a read is a lookup, and `Waiting` is for writes.
          */}
        {!closure && !problem ? (
          <p className="world__hint deriv__note">Reading dependency metadata…</p>
        ) : null}

        {closure ? (
          <div className="deriv__columns motion-emit">
            <section>
              <h3>rests on</h3>
              <Tree
                reading={reading}
                root={relation}
                adjacency={closure.rests_on}
                nodes={nodes}
                empty={`No input dependency metadata recorded for ${relation}.`}
                onOpen={onOpen}
              />
            </section>

            <section>
              <h3>supports</h3>
              <Tree
                reading={reading}
                root={relation}
                adjacency={closure.supports}
                nodes={nodes}
                empty={`No dependent relation metadata recorded for ${relation}.`}
                onOpen={onOpen}
              />
            </section>
          </div>
        ) : null}

        {closure && !run ? (
          <p className="deriv__note">No derivation run metadata recorded for {relation}.</p>
        ) : null}

        {run ? (
          <section className="deriv__run motion-emit">
            <h3>
              last run
              <span>
                {run.last_run_world_revision === null
                  ? "revision not recorded"
                  : `rev ${run.last_run_world_revision}`}
                {run.output_cardinality === null
                  ? ""
                  : ` · ${run.output_cardinality} out`}
              </span>
            </h3>
            {run.last_error ? <ProblemNotice message={run.last_error} title="Derivation failed" /> : null}
            {/* Not a windowed table: a derivation reads a handful of relations,
                and a scroller around four rows is furniture. */}
            <div className="deriv__grid" data-head="true">
              <span>input</span>
              <span>at run</span>
              <span>now</span>
              <span />
            </div>
            {run.inputs.map((input) => (
              <div className="deriv__grid" key={input.relation} data-moved={input.moved ? "true" : undefined}>
                <button type="button" onClick={() => onOpen(input.relation)}>
                  {input.relation}
                  {input.declared ? "" : " ·"}
                </button>
                <span>
                  {input.version_at_run === null
                    ? "—"
                    : `v${input.version_at_run} · ${input.count_at_run}`}
                </span>
                <span>
                  {input.version_now === null
                    ? "—"
                    : `v${input.version_now} · ${input.count_now}`}
                </span>
                <span>{input.moved ? "moved since" : "unchanged"}</span>
              </div>
            ))}
            {run.inputs.some((input) => !input.declared) ? (
              <p className="deriv__note">
                · held by the run, not declared by the dependency table.
              </p>
            ) : null}
          </section>
        ) : null}

        {support?.derived ? (
          <section className="deriv__support motion-emit">
            <h3>
              candidate support
              <span>{support.referents.join(" · ")}</span>
            </h3>
            {/* The honest caption, and it is load-bearing. */}
            <p className="deriv__note">
              Input tuples that mention these referents, ranked by how many. The
              world records derivation per relation, not per row — these are
              candidates for the support of this tuple, not its recorded lineage.
            </p>
            {support.inputs.map((input) => (
              <div className="deriv__input" key={input.relation}>
                <h4>
                  <button type="button" onClick={() => onOpen(input.relation)}>
                    {input.relation}
                  </button>
                  <span>
                    {input.matched} of {input.count}
                    {input.matched > input.tuples.length
                      ? ` · showing ${input.tuples.length}`
                      : ""}
                  </span>
                </h4>
                {input.tuples.length ? (
                  <>
                    {/* The role names, once per input: `C300 active` is not a
                        tuple anyone can read without them. */}
                    <div className="deriv__tuple deriv__tuple--head">
                      {input.roles.map((role) => (
                        <span key={role.name}>{role.name}</span>
                      ))}
                      <span className="deriv__mentions">mentions</span>
                    </div>
                    {input.tuples.map((tuple) => (
                    <div
                      className="deriv__tuple"
                      key={tuple.assertion_id}
                      data-present={present.has(tuple.assertion_id) ? true : undefined}
                      onClick={() => onFocus(input.relation, input.roles, tuple)}
                    >
                      {input.roles.map((role) => (
                        <span key={role.name}>
                          {strip(tuple.values[role.name], role.referent)}
                        </span>
                      ))}
                      <span className="deriv__mentions">{tuple.mentions}</span>
                    </div>
                    ))}
                  </>
                ) : (
                  <p className="deriv__note">
                    No tuple of {input.relation} mentions these referents.
                  </p>
                )}
              </div>
            ))}
          </section>
        ) : null}
      </div>
    </section>
  );
}

/** As the table prints a cell: the namespace repeats and is dropped. */
function strip(value: unknown, referent: boolean): ReactNode {
  if (scalarLabel(value) !== undefined) return <Scalar value={value} />;
  if (!referent) return <Scalar value={value} />;
  const text = String(value);
  const colon = text.indexOf(":");
  return colon > 0 ? text.slice(colon + 1) : text;
}
