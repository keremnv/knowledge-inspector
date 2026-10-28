import { useEffect, useRef, useState } from "react";
import { CANVAS_CONNECTIONS, HIDE_CONNECTION, referenceName } from "./SourceReferences";
import { identityLimitation } from "./SourceDetails";
import { ReaderAction, ReaderActions } from "../world/ReaderChrome";
import type { SourceCatalogue, SourceIdentity } from "../api/source";
import { placedRecordName, sourceConnectionName, type PlacedReference, type PlacedRecord } from "./sourceField";

type Relation = SourceCatalogue["relations"][number];

/**
 * Show on canvas, for a record whose verified read succeeded in this context.
 *
 * Offered only with the record in hand: the workspace renders this beside an
 * exact-record read, never beside a window row. Showing a record already on
 * the canvas reveals its mark rather than adding a second one.
 */
export function SourcePlacement({ placed, onShow, onRemove }: {
  placed: PlacedRecord | null;
  onShow: () => void;
  onRemove: () => void;
}) {
  return <div className="source-placement" role="group" aria-label="canvas placement">
    <ReaderActions><ReaderAction data-placement="show" onClick={onShow}>{placed ? "reveal" : "show on canvas"}</ReaderAction>
    {placed && <ReaderAction data-placement="remove" onClick={onRemove}>remove</ReaderAction>}
    </ReaderActions>
  </div>;
}

/** Why a row without a registered handle stays in its table. */
export function SourceUnplaceable({ relation, identity }: { relation: Relation; identity?: SourceIdentity }) {
  return <p className="source-placement source-placement--unavailable">canvas placement unavailable · {relation.kind === "view" ? "computed view output" : identityLimitation(identity ?? relation.identity) ?? "record identity unavailable"} · this page only</p>;
}

/**
 * The placed records, as controls: the keyboard's way onto the canvas.
 *
 * A canvas mark has no DOM to focus, so every placed record is also a button
 * here — choosing one opens its Reader and brings its mark into view — with
 * a removal beside it; a connection's × hides only the connection. Pointer
 * users select marks directly and remove one with a right press, the World
 * field's gesture. The list itself is off (owner decision O9): it shows only
 * while keyboard focus is inside it.
 */
export function SourceFieldList({ records, names, references, selected, onSelect, onRemove, onSeparate, onUndoSeparate }: {
  records: PlacedRecord[];
  /** Each record's name by element id (O17). */
  names: ReadonlyMap<string, string>;
  references: PlacedReference[];
  selected: string | null;
  onSelect: (elementId: string) => void;
  onRemove: (elementId: string) => void;
  /** World's "separate": push apart only marks sitting on one another. */
  onSeparate: () => void;
  /** Put back what the last separate displaced, while nothing else has changed. */
  onUndoSeparate?: () => void;
}) {
  const nameOf = (elementId: string) => {
    const record = records.find((item) => item.elementId === elementId);
    return names.get(elementId) ?? (record ? placedRecordName(record) : "a record no longer on the canvas");
  };
  return <><section className="source-field-list" aria-label="Records on canvas">
    <ul className="instrument__items">{records.map((record) => {
      const name = nameOf(record.elementId);
      return <li className="instrument__group" key={record.elementId}>
        <button type="button" data-field-record={record.elementId} aria-pressed={record.elementId === selected} onClick={() => onSelect(record.elementId)}>{name}</button>
        <button type="button" data-field-remove={record.elementId} aria-label={`remove ${name} from canvas`} title="remove from canvas" onClick={() => onRemove(record.elementId)}>×</button>
      </li>;
    })}{references.map((reference) => {
      const name = sourceConnectionName(reference, nameOf);
      return <li className="instrument__group" key={reference.elementId}>
        <button type="button" data-field-reference={reference.elementId} aria-pressed={reference.elementId === selected} onClick={() => onSelect(reference.elementId)}>{name}</button>
        <button type="button" data-field-hide={reference.elementId} aria-label={`hide connection ${name}`} title={HIDE_CONNECTION} onClick={() => onRemove(reference.elementId)}>×</button>
      </li>;
    })}</ul>
  </section>
  <div className="instrument__group" role="group" aria-label="Arrange the canvas">
    <button type="button" onClick={onSeparate} title="Push apart only what is sitting on top of something else">separate</button>
    {onUndoSeparate && <button type="button" onClick={onUndoSeparate} title="Put back what separate displaced">undo separate</button>}
  </div></>;
}

/**
 * What on the canvas joins this record: World's "on this disc". Each line is
 * a connection drawn to the record, with its far end; choosing one selects it.
 * Only what is drawn, never what is merely declared — that is the sections above.
 */
export function SourceOnCanvas({ element, records, references, onSelect }: {
  element: string;
  records: PlacedRecord[];
  references: PlacedReference[];
  onSelect: (elementId: string) => void;
}) {
  const incident = references.filter((reference) => reference.child === element || reference.parent === element);
  if (!incident.length) return null;
  return <section className="world-reader__section world-reader__section--list source-on-canvas" aria-label="on this disc"><h3>on this disc</h3>
    <ul className="gm__list">{incident.map((reference) => {
      const outgoing = reference.child === element;
      const far = records.find((record) => record.elementId === (outgoing ? reference.parent : reference.child));
      return <li key={reference.elementId}><button type="button" data-on-canvas={reference.elementId} onClick={() => onSelect(reference.elementId)}>
        <span className="gm__list-name">{referenceName(reference.observation)}</span>
        <span className="gm__list-meta">{outgoing ? "to" : "from"} {far ? placedRecordName(far) : "this record"}</span>
      </button></li>;
    })}</ul>
  </section>;
}

/** What the canvas draws (O8.10): connections, and each table's records. */
export type SourceShow = { connections: boolean; hiddenTables: string[]; /** The schema's "names" toggle (O12); on unless turned off. */ namedAtRest?: boolean };
/** The owner wants schema names on by default (O12, 2026-10-25); World starts with them off. */
export const schemaNamed = (show: SourceShow) => show.namedAtRest ?? true;
export const SOURCE_SHOW_DEFAULT: SourceShow = { connections: true, hiddenTables: [] };

/**
 * World's show filter, over what Source draws. World's keys are construction
 * origins, which Source data does not have; here they are connections and the
 * tables standing on the canvas. A statement about what the canvas draws,
 * never about the data: hidden records stay on the canvas list and come back
 * with their key. Same cell, same hover-and-pin menu as World's band.
 */
export function SourceShowBand({ show, tables, onShow, schema = false }: {
  show: SourceShow;
  tables: string[];
  onShow: (next: (current: SourceShow) => SourceShow) => void;
  /** The schema view's band: only World's "names" toggle, as World offers in its vocabulary. */
  schema?: boolean;
}) {
  const [pinned, setPinned] = useState(false);
  const [hovered, setHovered] = useState(false);
  // World's: closing by the summary must not be undone by the pointer still on it.
  const suppressHover = useRef(false);
  const closeTimer = useRef<number | undefined>(undefined);
  const rootRef = useRef<HTMLDivElement>(null);
  const open = pinned || hovered;
  useEffect(() => {
    if (!pinned) return;
    const close = (event: PointerEvent) => { if (!rootRef.current?.contains(event.target as Node)) setPinned(false); };
    document.addEventListener("pointerdown", close, true);
    return () => document.removeEventListener("pointerdown", close, true);
  }, [pinned]);
  useEffect(() => () => window.clearTimeout(closeTimer.current), []);
  const key = (name: string, on: boolean, title: string, toggle: () => void, layer: string, describedBy?: string) =>
    <button key={`${layer}:${name}`} type="button" className="world-show__filter" data-layer={layer} aria-pressed={on} title={title} onClick={toggle} aria-describedby={describedBy}>
      <span className="world-show__key" aria-hidden="true" /><span className="world-show__name">{name}</span></button>;
  return <div ref={rootRef} className={`world-filter source-show${open ? " is-open" : ""}`}
    onMouseEnter={() => { window.clearTimeout(closeTimer.current); if (!suppressHover.current) setHovered(true); }}
    onMouseLeave={() => { suppressHover.current = false; window.clearTimeout(closeTimer.current); closeTimer.current = window.setTimeout(() => setHovered(false), 250); }}>
    <div className="instrument__group"><button type="button" className="world-filter__summary" aria-expanded={open} aria-haspopup="true"
      onClick={() => {
        if (!pinned) { setPinned(true); return; }
        setPinned(false); suppressHover.current = true; setHovered(false);
      }}>filter</button></div>
    <div className="world-filter__menu"><div className="instrument__group" role="group" aria-label="Filter">
      {schema ? key("names", schemaNamed(show), schemaNamed(show) ? "Show names on focus only" : "Keep names visible",
        () => onShow((current) => ({ ...current, namedAtRest: !schemaNamed(current) })), "names") : <>
      {key("connections", show.connections, `${show.connections ? "Hide" : "Show"} connections on the canvas`,
        () => onShow((current) => ({ ...current, connections: !current.connections })), "source-connections", "source-show-connections-note")}
      {tables.map((table) => {
        const on = !show.hiddenTables.includes(table);
        return key(table, on, `${on ? "Hide" : "Show"} ${table} records on the canvas`, () => onShow((current) => ({ ...current,
          hiddenTables: on ? [...current.hiddenTables, table] : current.hiddenTables.filter((name) => name !== table) })), "source-table");
      })}</>}
    </div>{!schema && <p className="world-show__note" id="source-show-connections-note" data-canvas-connections>{CANVAS_CONNECTIONS}</p>}</div>
  </div>;
}
