/**
 * What the occurrences that mention a referent state, kept with those
 * occurrences.
 *
 * `/world/referent` returns scalar values that came from occurrences — each
 * carries the `assertion_id` it was stated in. An occurrence can mention
 * several referents, and its scalars are its own: a track's price in
 * `track_on_album:10` is not an album's price, and an invoice line's
 * quantity is not a customer's. So this lists each occurrence once, under its
 * relation, with the referent's role in it where the producer says so, and
 * the scalar values beneath. Nothing here is read as a property of the
 * referent, and no role is guessed from a name or an id.
 *
 * The producer's preview is bounded. The count is the relation's full count
 * of occurrences mentioning the referent, never the number of scalars shown.
 */

import type { WorldReferent } from "../api/world";
import { occurrenceChip } from "./occurrence";
import { isUnstatedOrigin, originsLabel } from "./show";
import { Scalar, scalarKind, scalarTitle } from "./scalar";

type Field = WorldReferent["fields"][number];

type Occurrence = {
  id: string;
  participates: string[] | undefined;
  /** Present only where the occurrence supplied a classified origin. */
  origin: string | null;
  state: string | undefined;
  scalars: { role: string; value: unknown }[];
};

type RelationGroup = {
  relation: string;
  count: number | null;
  occurrences: Occurrence[];
};

/** Fields grouped relation → occurrence, in the order the producer sent them. */
export function groupOccurrences(detail: WorldReferent): RelationGroup[] {
  const groups = new Map<string, Map<string, Occurrence>>();
  for (const field of detail.fields) {
    const relation = groups.get(field.relation) ?? new Map<string, Occurrence>();
    groups.set(field.relation, relation);
    const found = relation.get(field.assertion_id) ?? occurrenceOf(field);
    relation.set(field.assertion_id, found);
    found.scalars.push({ role: field.role, value: field.value });
  }
  return [...groups].map(([relation, occurrences]) => ({
    relation,
    count: detail.relations.find((item) => item.name === relation)?.count ?? null,
    occurrences: [...occurrences.values()],
  }));
}

function occurrenceOf(field: Field): Occurrence {
  const supplied = field.origins?.length ? field.origins : [field.origin];
  const classified = supplied.some((origin) => !isUnstatedOrigin(origin));
  return {
    id: field.assertion_id,
    participates: field.referent_roles,
    origin: classified ? originsLabel(supplied).toLowerCase() : null,
    state: field.occurrence_state,
    scalars: [],
  };
}

export function ReferentOccurrences({
  detail,
  onOpen,
}: {
  detail: WorldReferent;
  onOpen: (assertionId: string) => void;
}) {
  const groups = groupOccurrences(detail);
  if (!groups.length) return null;
  const name = detail.label || detail.id;
  return (
    <section
      className="world-reader__section world-occurrences"
      aria-label={`Occurrences mentioning ${name}`}
    >
      <h3>occurrences mentioning this referent</h3>
      <p className="world__note">
        Scalar values are stated by these occurrences, one occurrence each. They
        are not recorded as properties of {name}.
      </p>
      {groups.map(({ relation, count, occurrences }) => {
        const partial = count !== null && occurrences.length < count;
        return (
          <section
            key={relation}
            className="world-occurrences__relation"
            aria-label={`${relation} occurrences mentioning ${name}`}
          >
            <h4>{relation}</h4>
            <p className="world__hint">
              {count === null
                ? `${occurrences.length} occurrences shown.`
                : `${occurrences.length} of ${count} occurrences shown.`}
              {partial
                ? " A bounded preview, not the complete set: expand through this relation to read all occurrences."
                : ""}
            </p>
            <ul className="world-occurrences__list">
              {occurrences.map((occurrence) => (
                <OccurrenceItem
                  key={occurrence.id}
                  occurrence={occurrence}
                  relation={relation}
                  onOpen={onOpen}
                />
              ))}
            </ul>
          </section>
        );
      })}
    </section>
  );
}

function OccurrenceItem({
  occurrence,
  relation,
  onOpen,
}: {
  occurrence: Occurrence;
  relation: string;
  onOpen: (assertionId: string) => void;
}) {
  const chip = occurrenceChip(occurrence.state);
  const as = occurrence.participates?.length
    ? `this referent as ${occurrence.participates.join(" and ")}`
    : null;
  return (
    <li className="world-occurrence" data-assertion-id={occurrence.id}>
      <div className="world-occurrence__head">
        <button
          type="button"
          className="world-occurrence__id"
          title={`Open ${relation} occurrence ${occurrence.id}`}
          aria-label={`Open occurrence ${occurrence.id}`}
          onClick={() => onOpen(occurrence.id)}
        >
          {occurrence.id}
        </button>
        {as || occurrence.origin ? (
          <span className="world-occurrence__meta">
            {[as, occurrence.origin].filter(Boolean).join(" · ")}
          </span>
        ) : null}
        {chip ? (
          <span
            className="node-reader__kind"
            data-occurrence-state={chip.state}
            title={chip.title}
          >
            {chip.label}
          </span>
        ) : null}
      </div>
      <ol className="world__roles" aria-label={`Scalar values stated by ${occurrence.id}`}>
        {occurrence.scalars.map(({ role, value }, index) => (
          <li key={`${role}\u0000${index}`}>
            <b>{role}</b>
            <span data-value-kind={scalarKind(value)} title={scalarTitle(value)}>
              <Scalar value={value} />
            </span>
          </li>
        ))}
      </ol>
    </li>
  );
}
