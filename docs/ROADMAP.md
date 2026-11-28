# Roadmap

What is planned after the open pull requests, in rough order. Decisions are in `DECISIONS.md`; this is only the
list of what comes next.

1. **Reader:** a dotted follow reads the record twice (once to place it, once to show it); the list of what is on
   the canvas is visible only while it has keyboard focus.
2. **Prose cleanup:** apply "Exceptions in labels, not sentences" and "One cause, one label, on what it belongs
   to" to every sentence inventoried in `TRAVERSAL_REVIEW.md` section 8.
3. **Documentation cleanup:** bring `README.md`, `API_CONTRACT.md` and the files under `docs/` in line with the
   interface as it now is, in the same plain wording; remove what is out of date or said twice.
4. **The ontology layer:** compatibility with declared ontologies; a way into a store by what its tables mean
   ("51 tables, how do I understand them?", "what is a node?"); a span's offsets selecting the text they point to.
5. **What deserves a node on the canvas, and in what shape.**
6. **Architecture, without changing behaviour,** once behaviour is solid: logic out of React components into
   plain modules; the graph library behind a small interface of our own; the largest components
   (`WorldCanvas.tsx`, `SourceWorkspace.tsx`) split.
