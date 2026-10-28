# Source and wheel publication status

**Public source: GO for owner approval.** This tree contains the project source, MIT project licence, dependency manifests, tests, build scripts, Chinook screenshots and technical documentation. It does not need to contain npm dependencies, the generated frontend, or a built wheel. The README gives a build-from-source path; no public repository or release has been created.

**Binary wheel: on hold.** The locked `@antv/algorithm` 0.1.26, `@antv/event-emitter` 0.1.3 and `@antv/g-lite` 2.7.0 artifacts declare MIT; the nested `@antv/util` 2.0.17 artifact declares ISC. Their published packages do not contain licence files and their exact package-specific copyright notices were not found in the verified material. A licence declaration is a grant; the absence of a packaged notice is not evidence of an absence of licence. It leaves uncertainty about the notice to preserve in redistributed binaries. The [third-party record](../THIRD_PARTY/README.md) includes available notices, official reference texts and provenance, and distinguishes the two versions of `@antv/util`. Obtain or otherwise verify the missing notices before distributing the wheel.

The eight previously unmatched `@antv/layout` source-map entries now match published npm artifacts, including a newline-normalization discrepancy for `tslib`; the relevant licence files are retained. The two lodash files each match several versions with identical licence notices. See [matched artifacts](../THIRD_PARTY/layout-matched-artifacts.json).

## Validated implementation

The incoming-reference test uses SQLite's own foreign-key checker for REAL-to-TEXT expectations. Its sparse-page success test uses a bounded 800,000-step budget and explicitly checks refusal at lower budgets. Production defaults and `source_query_budget_exceeded` behavior remain unchanged. The full Source Python suite passed on the tested SQLite 3.51.1 and 3.53.1 builds. Query plans that exceed the limits remain explicitly incomplete or refused, rather than reported as empty. See [SQLite compatibility](SQLITE_COMPATIBILITY.md).

Prior to the source-only packaging cleanup, the 22 selected Source browser scenarios, one installed-wheel launch/session test, 12 installed-artifact checks and a real installed Chinook walkthrough passed on Linux. The Chinook input fingerprint was unchanged. The README's source build and virtual-environment install commands were validated. These are functional checks, not a compatibility claim for all systems.

MacOS and Windows remain untested. Dense canvases can obscure labels and reduce responsiveness. Those limitations do not prevent a clearly described experimental source release.
