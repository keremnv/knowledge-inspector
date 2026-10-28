# Build and develop

Run from the project root. Python 3.11+, SQLite 3.37+, Node.js 22.12+ and npm are required to build. The installed application needs Python and SQLite, but no Node.js.

```bash
python3 scripts/build_release.py
python3 scripts/test_installed_wheel.py -v
```

The release builder installs the locked frontend dependencies, builds and verifies the Source bundle, then writes a wheel in `release/`. Test the installed wheel with Chinook:

```bash
python3 examples/chinook/prepare.py --view-copy
python3 -m venv /tmp/ki-test-venv
/tmp/ki-test-venv/bin/pip install --no-deps release/knowledge_inspector-0.1.0-py3-none-any.whl
KI_EXECUTABLE=/tmp/ki-test-venv/bin/ki npx playwright test -c playwright.app.config.ts --workers 1
```

Use `-c playwright.app.config.ts` if using the Playwright command directly. The Source browser suite uses `npx playwright test -c playwright.source.config.ts`; it runs a development frontend and includes real SQLite and mocked HTTP tests. See [engineering evidence](ENGINEERING_EVIDENCE.md) for known failures and scope.

## Continuous integration

GitHub Actions runs a single Linux job with Python 3.13 and Node.js 22. It prints
its SQLite version, builds the Source frontend and wheel, runs the Source Python
suite and installed-wheel checks, and exercises selected SQLite, HTTP-recovery,
canvas and installed-application flows with Playwright Chromium. The Chinook
fixture is downloaded and checked against its pinned digest. The wheel is used
only inside the runner: the workflow does not upload it or any compiled assets.

This job covers one environment, not the full Python/SQLite or operating-system
support range. macOS and Windows remain untested, and bounded reads can report
that their query budget was exceeded. One timing-sensitive test (the incoming-reference page time limit) skips itself on hosts too slow to finish a million-row count in 0.1 s, so a hosted runner may report it as skipped. A passing workflow does not clear the
separate third-party notice work required before distributing a binary wheel.

## Performance benchmarks

`benchmarks/run_all.sh WHEEL` measures a locally built wheel (distribution size, startup, interactions, working-set growth, Python probes) into `benchmarks/results/`, taking about 15 minutes on an otherwise idle machine. Methodology, results and limits are in the [performance report](PERFORMANCE.md#reproducing); it is not part of CI.
