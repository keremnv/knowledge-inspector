# Roadmap

What is planned after the open pull requests, in rough order. Decisions are in `DECISIONS.md`; this is only the
list of what comes next.

1. **Reader:** a dotted follow reads the record twice (once to place it, once to show it); the list of what is on
   the canvas is visible only while it has keyboard focus.
2. **Prose cleanup:** apply "Exceptions in labels, not sentences" and "One cause, one label, on what it belongs
   to" to every sentence inventoried in `TRAVERSAL_REVIEW.md` section 8.
3. **Documentation cleanup:** bring `README.md`, `API_CONTRACT.md` and the files under `docs/` in line with the
   interface as it now is, in the same plain wording; remove what is out of date or said twice.
4. **Filters that come from relationships** (after column filtering): each a set taken from something already in
   view, said as part of one sentence ("evidence · referencing F1 through holder · not on canvas"):
   - by the canvas: rows already on it, or not yet;
   - related to a record, chosen inside the table (typed or picked from the canvas), offering each declaration
     that fits;
   - the same value as one in the Reader ("outcome is not_met");
   - whether a relationship is present ("findings cited by another finding", "spans no evidence cites");
   - what connects records selected on the canvas (the rows that reference both).
5. **The ontology layer:** compatibility with declared ontologies; a way into a store by what its tables mean
   ("51 tables, how do I understand them?", "what is a node?"); a span's offsets selecting the text they point to.
6. **What deserves a node on the canvas, and in what shape.**
7. **Architecture, without changing behaviour,** once behaviour is solid: logic out of React components into
   plain modules; the graph library behind a small interface of our own; the largest components
   (`WorldCanvas.tsx`, `SourceWorkspace.tsx`) split.
