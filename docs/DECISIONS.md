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
