/**
 * The legacy Purpose frontier table.
 *
 * Durable governed Obligations have a separate typed read path and table
 * (`GovernedObligationTable` below). Keeping the components near one another
 * shares the table furniture without making either payload pretend to be the
 * other.
 *
 * This surface is the old §8.7 Purpose frontier. Its unresolved rows are the
 * join between what one Purpose demanded and what the world asserted. That is
 * different from a governed Obligation's Resolution status, which is shown by
 * the sibling table and does not require a Purpose.
 *
 * The list is a table because Purpose failures are rows, and it shares the
 * extension's shape, windowing and margin rule so that "a row you can put on
 * the field" means one thing across the product. Governed obligations are
 * fetched by their own read contract and table.
 *
 * In the legacy branch, two granularities are kept apart. The rows are
 * obligations — tuple-level, *this
 * demanded tuple is missing*. The band above them is `requirements` —
 * relation-level, *this is what was wanted of the world at all* — which is
 * where the v1 lineage records the met half of a frontier. See `Asked`.
 *
 * One rule of tone. Resolved obligations are shown, quietly, because the
 * interesting thing about a frontier is where it has moved; unresolved ones are
 * shown at full strength. Neither is coloured. **Absence is not falsehood** —
 * the world has not denied these tuples, it has said nothing about them — so
 * nothing here is allowed to read as a rejection.
 */

import { useEffect, useMemo, useState } from "react";
import type {
  LegacyWorldObligation,
  WorldDemand,
  WorldObligation,
  WorldRelation,
  WorldResolutionStatus,
} from "../api/world";
import { still } from "../styles/motion";
import { ProblemNotice } from "./ProblemNotice";
import { scalarText } from "./scalar";
import { useRowWindow } from "./rowWindow";
import { TableBar, TableSearch, type TableChrome } from "./tableChrome";

const ROW_HEIGHT = 26;
const OVERSCAN = 8;
const COLUMNS = "minmax(0, 1.1fr) minmax(0, 2fr) minmax(0, 1fr) 96px";
const ASKED_COLUMNS = "28px minmax(0, 2fr) minmax(0, 1.1fr)";

type Requirement = NonNullable<WorldDemand["requirements"]>[number];

export type Obligation = LegacyWorldObligation & { key: string };
export type GovernedObligation = WorldObligation & { key: string };

export function FrontierTable({
  demand,
  relations,
  problem,
  settled,
  present,
  chrome,
  onFocus,
}: {
  demand: WorldDemand | null;
  /** The vocabulary, so a tuple prints in role order rather than JSON order. */
  relations: WorldRelation[];
  problem: string | null;
  /** The frontier read has answered — content, null, or failure. */
  settled: boolean;
  /** Obligation keys and assertion ids already on the field. */
  present: Set<string>;
  chrome: TableChrome;
  onFocus: (obligation: Obligation) => void;
}) {
  return (
    <LegacyFrontierTable
      demand={demand}
      relations={relations}
      problem={problem}
      settled={settled}
      present={present}
      chrome={chrome}
      onFocus={onFocus}
    />
  );
}

function statusOf(obligation: WorldObligation): WorldResolutionStatus | null {
  return obligation.resolution?.status ?? null;
}

function statusLabel(status: WorldResolutionStatus): string {
  return status.toLowerCase().replaceAll("_", " ");
}

export function GovernedObligationTable({
  obligations,
  problem,
  settled,
  chrome,
  onFocus,
}: {
  obligations: GovernedObligation[];
  problem: string | null;
  /** The read has landed or failed — an empty list before that is outstanding. */
  settled: boolean;
  chrome: TableChrome;
  onFocus: (obligation: GovernedObligation) => void;
}) {
  const [query, setQuery] = useState("");
  const rows = useMemo(
    () => obligations.filter((item) =>
      JSON.stringify(item).toLowerCase().includes(query.trim().toLowerCase()),
    ),
    [obligations, query],
  );
  const counts = useMemo(() => {
    const result = new Map<WorldResolutionStatus, number>();
    obligations.forEach((item) => {
      const status = statusOf(item);
      if (status) result.set(status, (result.get(status) ?? 0) + 1);
    });
    return result;
  }, [obligations]);

  return (
    <section className="table" aria-label="governed obligations">
      <TableBar
        chrome={chrome}
        meta={
          settled ? (
            <>
              {obligations.length} governed obligation
              {obligations.length === 1 ? "" : "s"}
              {counts.get("RESOLVED")
                ? ` · ${counts.get("RESOLVED")} resolved`
                : ""}
            </>
          ) : (
            "Reading obligations…"
          )
        }
      />
      <TableSearch value={query} onChange={setQuery} label="Search governed obligations" />
      {query && !rows.length ? (
        <p className="table__empty">No obligations match this search.</p>
      ) : null}
      <div
        className="table__head"
        style={{ gridTemplateColumns: "minmax(0, 3fr) 155px 90px" }}
      >
        <span>question</span>
        <span>dimension</span>
        <span>status</span>
      </div>
      {problem ? <ProblemNotice message={problem} title="Unable to load obligations" /> : null}
      <div className="table__scroll table__scroll--flow">
        {rows.map((item) => {
          const status = statusOf(item);
          return (
            <div
              key={item.key}
              className="table__row"
              {...still("rowsNeverFly")}
              data-loaded
              data-resolved={status === "RESOLVED" ? true : undefined}
              style={{
                minHeight: ROW_HEIGHT,
                gridTemplateColumns: "minmax(0, 3fr) 155px 90px",
              }}
              role="button"
              tabIndex={0}
              onClick={() => onFocus(item)}
              onKeyDown={(event) => {
                if (event.key === "Enter" || event.key === " ") {
                  event.preventDefault();
                  onFocus(item);
                }
              }}
            >
              <span title={item.question}>{item.question}</span>
              <span className="table__origin">{item.dimension ?? "—"}</span>
              <span className="table__origin">{status ? statusLabel(status) : "resolution not recorded"}</span>
            </div>
          );
        })}
      </div>
    </section>
  );
}

function LegacyFrontierTable({
  demand,
  relations,
  problem,
  settled,
  present,
  chrome,
  onFocus,
}: {
  demand: WorldDemand | null;
  /** The vocabulary, so a tuple prints in role order rather than JSON order. */
  relations: WorldRelation[];
  problem: string | null;
  /** The frontier read has answered — content, null, or failure. */
  settled: boolean;
  /** Obligation keys and assertion ids already on the field. */
  present: Set<string>;
  chrome: TableChrome;
  onFocus: (obligation: Obligation) => void;
}) {
  const [query, setQuery] = useState("");
  const [resolved, setResolved] = useState(false);

  const all = useMemo<Obligation[]>(
    () =>
      (demand?.obligations ?? []).map((obligation, index) => ({
        ...obligation,
        // Positional, and positional in the *document* rather than in whatever
        // is being shown, so a key means the same obligation whether or not the
        // resolved ones are filtered out. Not `demand:0`, because a trailing
        // `:<digits>` is how this surface marks a role spoke.
        key: `demand#${index}`,
      })),
    [demand],
  );
  const rows = useMemo(
    () => (resolved ? all : all.filter((item) => item.state === "UNRESOLVED"))
      .filter((item) => JSON.stringify(item).toLowerCase().includes(query.trim().toLowerCase())),
    [all, resolved, query],
  );
  /** Whether this frontier has a resolved half at all — see the toggle. */
  const movable = useMemo(
    () => all.some((item) => item.state === "ASSERTED"),
    [all],
  );
  const open = all.filter((item) => item.state === "UNRESOLVED").length;

  const window_ = useRowWindow(rows.length, ROW_HEIGHT, OVERSCAN);
  const { reset } = window_;
  useEffect(reset, [query, resolved, reset]);
  const order = useMemo(
    () => new Map(relations.map((item) => [item.name, item.roles.map((role) => role.name)])),
    [relations],
  );

  return (
    <section className="table" aria-label="unresolved frontier">
      <TableBar
        chrome={chrome}
        meta={
          demand ? (
            <>
              {open} unresolved of {all.length} obligation
              {all.length === 1 ? "" : "s"}
              {demand.purpose.id ? ` · ${demand.purpose.id}` : ""}
              {demand.purpose.revision ? ` rev ${demand.purpose.revision}` : ""}
            </>
          ) : !settled ? (
            "Reading purpose…"
          ) : (
            "no purpose loaded"
          )
        }
      >
        {/*
          * Only where the *obligations* have a resolved half. A frontier read
          * off a world that materializes its failures as tuples has none — a
          * requirement that was met leaves no failure row — and a toggle that
          * reports a state it cannot change is worse than no toggle. That
          * world's met half is not missing, it is relation-level: the `Asked`
          * band above carries it.
          */}
        {movable ? (
        <button
          type="button"
          data-active={resolved}
          onClick={() => setResolved((on) => !on)}
        >
          {resolved ? "unresolved only" : "show resolved"}
        </button>
        ) : null}
      </TableBar>
      <TableSearch value={query} onChange={setQuery} label="Search obligations" />

      {query && !rows.length ? <p className="table__empty">No obligations match this search.</p> : null}

      <Asked
        requirements={demand?.requirements ?? []}
        purpose={demand?.purpose.statement ?? ""}
      />

      <div className="table__head" style={{ gridTemplateColumns: COLUMNS }}>
        <span>relation</span>
        <span>tuple</span>
        <span>demanded by</span>
        <span>state</span>
      </div>

      {problem ? <ProblemNotice message={problem} title="Unable to load obligations" /> : null}
      {demand || problem ? null : settled ? (
        <p className="table__rule">This world records no Purpose demand.</p>
      ) : (
        <p className="world__hint">Reading the Purpose demand…</p>
      )}

      <div className="table__scroll" ref={window_.ref} onScroll={window_.onScroll}
        onKeyDown={window_.onKeyDown} role="region" aria-label="Purpose frontier rows" tabIndex={window_.scrollable ? 0 : undefined}>
        <div className="table__spacer" style={{ height: rows.length * ROW_HEIGHT }}>
          {window_.indices.map((index) => {
            const item = rows[index];
            if (!item) return null;
            const placed = present.has(item.key) || Boolean(item.assertion_id && present.has(item.assertion_id));
            return (
              <div
                key={item.key}
                className="table__row"
                role="button"
                tabIndex={0}
                {...still("rowsNeverFly")}
                data-loaded
                data-present={placed ? true : undefined}
                data-resolved={item.state === "ASSERTED" ? true : undefined}
                style={{ top: index * ROW_HEIGHT, height: ROW_HEIGHT, gridTemplateColumns: COLUMNS }}
                onClick={() => onFocus(item)}
                onKeyDown={(event) => {
                  if (event.key !== "Enter" && event.key !== " ") return;
                  event.preventDefault();
                  onFocus(item);
                }}
              >
                <span>{item.relation}</span>
                <span title={tuple(item, order)}>{tuple(item, order)}</span>
                <span className="table__origin">{demandedBy(item.demanded_by)}</span>
                <span className="table__origin">{item.state.toLowerCase()}</span>
              </div>
            );
          })}
        </div>
      </div>

      {demand?.rule ? (
        <p className="table__rule" title={demand.rule}>
          {demand.rule}
        </p>
      ) : null}
    </section>
  );
}

/**
 * What the purpose asked for, as opposed to which tuples did not arrive.
 *
 * The two are different granularities and the band exists to keep them apart.
 * An obligation is tuple-level — *this* demanded tuple is missing. A
 * requirement is relation-level — this is what was wanted of the world in the
 * first place — and it is the only place the v1 lineage records the half of a
 * frontier that was *met*. Folding a met requirement into the rows below as a
 * resolved obligation would print a relation-level fact in a tuple-level table
 * and claim a tuple arrived that nothing ever demanded.
 *
 * The current World runtime records these as purpose-scoped state, so the band
 * is present when the construction declared requirements.
 *
 * Nothing here is coloured. A met requirement is quiet and an unmet one is at
 * full strength, which is the same rule the resolved obligations follow, and
 * the count on the left is the mark — geometry and weight, not a palette.
 */
function Asked({
  requirements,
  purpose,
}: {
  requirements: Requirement[];
  purpose: string;
}) {
  const summary = useMemo(() => {
    const kinds = new Map<string, number>();
    requirements.forEach((item) =>
      kinds.set(item.kind, (kinds.get(item.kind) ?? 0) + 1),
    );
    return [...kinds]
      .map(([kind, count]) => `${count} ${kind.toLowerCase()}`)
      .join(" · ");
  }, [requirements]);

  if (!requirements.length) return null;

  return (
    /*
     * One line at rest, and the rest of it one gesture away.
     *
     * This band used to stand as a second table above the first — its own bar,
     * its own scrolling list, its own disclosure — which is a lot of chrome for
     * eight rows, and it read as a peer of the frontier rather than as context
     * for it.
     *
     * Its load-bearing job is the summary alone: without it, three rows under a
     * heading that says "3 unresolved" read as the whole demand, when the world
     * in fact answered five of the eight things asked of it. That sentence has
     * to be visible. *Which* requirements those were, and what the purpose
     * said, are reference — a reviewer works the obligations below and consults
     * these — so they sit behind the summary rather than above it.
     */
    <details className="asked" aria-label="what the purpose asked for">
      <summary className="asked__bar">
        <b>asked for</b>
        <span>{summary}</span>
      </summary>
      {/*
        * The purpose, once, where it is a property of the whole demand.
        *
        * It used to be reprinted in full on every obligation panel — the same
        * hundred and twenty words beside each of three questions, which is how
        * a panel becomes something people stop reading. It is in here rather
        * than on the resting line because everything on this surface is
        * unresolved *relative to it*, so it belongs with the requirements it
        * generated rather than beside a count.
        */}
      {purpose ? <p className="asked__purpose">{purpose}</p> : null}
      <div className="asked__scroll">
        {requirements.map((item, index) => (
          <div
            className="asked__row"
            key={`${item.name}#${index}`}
            style={{ gridTemplateColumns: ASKED_COLUMNS }}
            data-met={item.failures === 0 ? true : undefined}
            {...still("rowsNeverFly")}
          >
            {/*
              * The count of tuples that failed this requirement, or a check
              * where none did. A number is the honest mark: "1" and "37" are
              * different sizes of the same unmet requirement, and a shared
              * glyph for both would flatten them.
              */}
            <span className="asked__count">
              {item.failures === 0 ? "✓" : item.failures}
            </span>
            <span title={item.note || item.name}>{item.name}</span>
            <span className="table__origin">{item.relation ?? "—"}</span>
          </div>
        ))}
      </div>
    </details>
  );
}

/**
 * `X110, X160, indoor_panel` — in role order, namespaces dropped as elsewhere.
 *
 * Role order, not the order the keys happen to arrive in: an obligation's
 * values are a JSON object, and printing `acceptable_replacement` as
 * `indoor_panel, X110, X160` because that is alphabetical would be printing a
 * different tuple.
 *
 * Only the roles the obligation actually carries. The construction lineage
 * demanded whole tuples, so its obligations name every role; a requirement
 * failure names the *subject* it failed on, which is usually one or two of
 * them. Walking the relation's roles regardless would print `undefined` for
 * the rest — inventing a demand for a tuple nothing asked for. Keys the
 * relation does not declare are kept, at the end, because a subject this
 * layer cannot place is still what the requirement was about.
 */
function tuple(
  item: Obligation,
  order: Map<string, string[]>,
): string {
  const present = Object.keys(item.values);
  const named = (order.get(item.relation) ?? []).filter(
    (name) => name in item.values,
  );
  const names = [...named, ...present.filter((key) => !named.includes(key))];
  return names
    .map((name) => item.values[name])
    .map((value) => {
      // NULL, an empty or unsent value and text that imitates one keep their
      // own forms; every other value is as before.
      const shown = scalarText(value);
      if (typeof value !== "string" || shown !== value) return shown;
      const text = value;
      const colon = text.indexOf(":");
      return colon > 0 ? text.slice(colon + 1) : text;
    })
    .join(", ");
}

function demandedBy(source: Record<string, unknown>): string {
  const name = source.name ?? source.id ?? source.kind ?? "";
  return source.revision ? `${name} rev ${source.revision}` : String(name);
}
