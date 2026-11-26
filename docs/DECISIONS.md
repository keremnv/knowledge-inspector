# Interface decisions

Owner decisions about how the interface speaks and shows values, recorded so they can be revisited. Earlier
owner decisions (O1–O21) are cited in the code, tests and `API_CONTRACT.md` where they apply.

## 2026-11-26 · Exceptions in labels, not sentences

**The rule.** The interface speaks only about exceptions, only where they happen, in labels. Normal states are
silent. Standing truths are said once.

Explanatory prose had spread through the Source UI (about two dozen note and limitation elements). It falls into
three kinds:

| Kind | Examples | What it becomes |
|---|---|---|
| A standing truth, repeated on every record | "Source grounding supports addressability, not independent factual verification or semantic endorsement."; "Historical enforcement is not established."; "Fixed capture. A new capture requires an operator restart …" | Said **once**, in one place (capture details or an "about this view" panel), not per record. |
| A description of absence or normality | "none declared"; "No rows in this capture reference this record through applies · record; claim · record; …" | **Silence**: the line is left out, or a count column shows 0. |
| An exception the reader would otherwise misread | a count unavailable because a query limit was reached; a reference with no matching record; an identity that could not be verified; an invalid declaration | **Kept**, as a short label in place ("count unavailable", "no matching record"), with the reason under details. Never removed: unavailable or not checked is never zero. |

**Status.** Decided. Applied so far to the JSON value view (no note under the value). The rest is to be applied
in the traversal redesign, which inventories every such sentence.

## 2026-11-26 · TEXT shown as its characters

A TEXT value is shown as its characters, not as a quoted, JSON-escaped string: `sex == "male" and hypogonadism`,
not `"sex == \"male\" and hypogonadism"`. What the quotes used to make visible is shown another way:
- the empty TEXT is marked `empty`; spaces at either end are shown as `␣` and marked;
- characters a reader cannot see (controls, separators, zero-width and bidirectional characters) are shown as their
  escape (`\n`, `\u200B`) and marked;
- NULL keeps its own style (muted, italic), so the TEXT "NULL" and a NULL do not look alike; the TEXT "5" and the
  INTEGER 5 differ by storage class style;
- in the Reader, lines break as written and a long TEXT is shortened until "show all"; in a table cell a line break
  is a marked `\n` on one line;
- "value details" keeps the exact TEXT, quoted. Record names and keys keep their quoted form (O17).

## 2026-11-26 · A special rendering only where a value's form can be checked exactly

A value gets a rendering of its own only when its form can be checked exactly, never guessed from a column name or
a pattern. For now, text only: plain text, multi-line or long text, and a JSON object or array (strict parse). URLs,
dates, Markdown and "looks like code" stay text. Links between records come from declared foreign keys, not from
recognising an identifier. Images and other media are not supported.

## 2026-11-26 · Following records

Following a declared reference leaves the same trail whichever way it runs. Before this, an outgoing reference (a
dotted value) opened its target in the Reader and drew the connection, while an incoming one opened the child table
in Tables, and choosing the row cleared Reader Back and drew nothing. The review behind this decision, with its
walks and screenshots, is `docs/TRAVERSAL_REVIEW.md`.

**The model.** Left shows sets of rows; right shows one thing. A set is a whole table, a filtered table, or the rows
related to one record through one declaration. A person can predict where they land: one verified record opens in
the Reader, a choice among rows opens in Tables, and Back restores the workspace they just left.

1. **The canvas draws the path, in both directions.** Following a reference places both records and draws the exact
   observation used. Opening a set of several rows has not picked an edge yet; choosing a row in it draws the
   observation from that child to the record that defined the set, even when the Reader has since moved on (back
   at the evidence set after reading a clause, the next row is drawn to the original finding). Inspecting an
   observation leaves the canvas alone; "show connection" draws it on request. `?placement=explicit` still only
   navigates.
2. **An incoming singleton opens directly, when the row read establishes it.** An exact count of one is enough to
   ask for the row. The child opens in the Reader once the scoped result is complete, holds exactly that row, and the
   row has a verified handle; Tables keeps the set it had. A sole child without a verified key opens in Tables,
   where its values can be read. A group whose count is unavailable stays browsable in Tables. A value that takes
   part in more than one declared reference (`span.source`, in both the reference to `source` and the one to
   `source_field`) lets the person choose the declaration, so both stay reachable.
3. **One Back across both panels.** Every move that changes what is open (a row, a follow, a set, a Find hit, a
   canvas mark, table info, whole table) records the workspace it leaves: the Reader subject, the table scope, its
   Find, sort and window, the selection, and which panels were open. Back restores all of it. A record opened from
   an address is the first restorable state. **whole table** stays its own action, a request to widen the current
   set; Back after it recovers the narrowed set. Filtering, sorting and paging refine the set in place and are not
   steps.
4. **Nonempty relationships first; exceptions in place.** The Reader lists the incoming declarations that have rows,
   and those whose count is unknown, labelled as such ("count unavailable"). Declarations with an exact zero, and
   the complete list in both directions, are under details. Declaration pages are read one after another; usable
   groups show as they arrive, with a "checking declarations" label until every page has been read, and "coverage
   incomplete" if a page fails. The current record's reads come first, and the rest stops when the person leaves.
   An empty list implies absence only after every page succeeded.
5. **A whole set is the unit of bulk placement, with precise removal.** "keep all" places every row of the set in
   Tables (all pages), not the page shown, and says the scope before it runs ("keep all 2", "keep all 10,106"; no
   total is claimed where none is known). It can be stopped, and reports how far it got ("kept 120 of 10,106 ·
   stopped"). "remove set" takes off exactly what that run contributed: a record already on the canvas before it,
   or reached afterwards by another path, stays. Both sit on the bar under the rows, beside the page size, never on a
   bar of their own, and only where rows can be placed: a view or a table without a key shows no button and no
   sentence about one. When the line above the rows does not already name the cause (the session's record limit),
   the cause stands where the button would be, as a label.

**What this removes.** The Reader's "expand through" list (bulk placement of a group is "keep all" on the set in
Tables); "references · N declared" as a way to navigate (it stays, under details, as the complete list);
"open referenced record" in the reference view (the → target does the same); the separate table Back; the
page-limited "add all" and the table-wide "clear" in the table footer. This supersedes O8.5 (add all limited to the
page shown) and O8.9 (expand through in the Reader).

**What stays for a declaration layer.** Source mode follows physical references. That "evidence · holder" means
"what this finding cites", that eight nullable target columns are one "cites" relationship, and what a span's
offsets select in its note, need declared roles and conventions from whoever produced the data.

**Acceptance.** The review's walk B (finding → evidence through holder → span) leaves three records, two exact
connections, and a Back trail to the starting finding. Walk A takes 14 clicks (18 before). Walk C takes five clicks
to identify the three referring rows (three before): the counts say there is one of each but do not identify them.

**Status.** Decided. Applied in the traversal change.
