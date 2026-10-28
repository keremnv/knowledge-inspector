#!/usr/bin/env python3
"""Build the installable `ki` wheel, with its compiled Source frontend.

    python3 scripts/build_release.py [--skip-npm-ci] [--out release]

1. `npm ci`, then `npm run build` with VITE_INSPECTOR_ENTRY=source, and check
   the bundle calls the Source API (a Source-capable build, not World-only).
2. Stage dist/ into knowledge_inspector/frontend/ with ki-frontend.json:
   every file's SHA-256, checked again by setup.py and by `ki` at startup.
3. `pip wheel` the project (no dependencies) into --out.
4. Open the wheel and check it holds exactly the shipped modules, every
   staged frontend file byte for byte, and the `ki` entry point.

Node and npm are needed here only; the wheel needs Python 3.11+ and nothing else.
"""
from __future__ import annotations

import argparse
import hashlib
import json
import os
import shutil
import subprocess
import sys
import zipfile
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
DIST = ROOT / "dist"
STAGE = ROOT / "knowledge_inspector" / "frontend"
sys.path.insert(0, str(ROOT))
from adapters.source.app import FRONTEND_MANIFEST, frontend_problems  # noqa: E402

MODULES = {
    "knowledge_inspector/__init__.py", "knowledge_inspector/__main__.py", "knowledge_inspector/cli.py",
    "adapters/capture.py", "adapters/sqlite/server.py",
    "adapters/source/app.py", "adapters/source/model.py", "adapters/source/server.py",
}


def step(message: str) -> None:
    print(f"==> {message}", flush=True)


def run(*command: str, env: dict | None = None) -> None:
    print("   $", " ".join(command), flush=True)
    subprocess.run(command, cwd=ROOT, check=True, env=env)


def fail(message: str) -> None:
    sys.exit(f"build_release: {message}")


def build_frontend(skip_ci: bool) -> None:
    if not shutil.which("npm"):
        fail("npm is required to build the frontend (it is not needed to install or run the wheel)")
    if not skip_ci:
        step("installing Node dependencies")
        run("npm", "ci")
    step("building the Source frontend")
    run("npm", "run", "build", env={**os.environ, "VITE_INSPECTOR_ENTRY": "source"})
    if not any("/source/v1/" in path.read_text("utf-8", "replace") for path in (DIST / "assets").glob("*.js")):
        fail(f"{DIST} does not call the Source API: not a Source-capable build")


def stage_frontend() -> dict[str, str]:
    step(f"staging {DIST.relative_to(ROOT)}/ into {STAGE.relative_to(ROOT)}/")
    unexpected = sorted(str(p.relative_to(DIST)) for p in DIST.rglob("*")
                        if p.is_file() and p.name != "index.html" and p.parent != DIST / "assets")
    if unexpected:
        # The application serves index.html and /assets/* only; anything else would be unreachable.
        fail(f"the build has files the application would not serve: {', '.join(unexpected)}")
    shutil.rmtree(STAGE, ignore_errors=True)
    shutil.copytree(DIST, STAGE)
    files = {str(p.relative_to(STAGE)): hashlib.sha256(p.read_bytes()).hexdigest()
             for p in sorted(STAGE.rglob("*")) if p.is_file()}
    (STAGE / FRONTEND_MANIFEST).write_text(json.dumps({"format": 1, "entry": "source", "files": files}, indent=1) + "\n")
    if problems := frontend_problems(STAGE, require_manifest=True):
        fail("the staged frontend does not verify:\n  " + "\n  ".join(problems))
    print(f"   {len(files)} files, {sum((STAGE / f).stat().st_size for f in files) // 1024} KiB")
    return files


def build_wheel(out: Path) -> Path:
    step("building the wheel")
    # Stale setuptools output could carry modules no longer shipped.
    shutil.rmtree(ROOT / "build", ignore_errors=True)
    for info in ROOT.glob("*.egg-info"):
        shutil.rmtree(info)
    out.mkdir(parents=True, exist_ok=True)
    for old in out.glob("knowledge_inspector-*.whl"):
        old.unlink()
    run(sys.executable, "-m", "pip", "wheel", "--no-deps", "--wheel-dir", str(out), ".")
    built = sorted(out.glob("knowledge_inspector-*.whl"))
    if len(built) != 1:
        fail(f"expected one knowledge_inspector wheel in {out}, found {[p.name for p in built]}")
    return built[0]


def inspect_wheel(wheel: Path, files: dict[str, str]) -> None:
    step(f"inspecting {wheel.name}")
    with zipfile.ZipFile(wheel) as archive:
        names = set(archive.namelist())
        info = next(n for n in names if n.endswith(".dist-info/METADATA")).rsplit("/", 1)[0]
        python = {n for n in names if n.endswith(".py")}
        frontend = {n for n in names if n.startswith("knowledge_inspector/frontend/")}
        expected = {f"knowledge_inspector/frontend/{name}" for name in [*files, FRONTEND_MANIFEST]}
        problems = [f"missing module: {n}" for n in sorted(MODULES - python)]
        problems += [f"unexpected module: {n}" for n in sorted(python - MODULES)]
        problems += [f"missing frontend file: {n}" for n in sorted(expected - frontend)]
        problems += [f"unexpected frontend file: {n}" for n in sorted(frontend - expected)]
        for name, digest in files.items():
            member = f"knowledge_inspector/frontend/{name}"
            if member in names and hashlib.sha256(archive.read(member)).hexdigest() != digest:
                problems.append(f"frontend file differs from the build: {member}")
        entry_points = archive.read(f"{info}/entry_points.txt").decode()
        if "ki = knowledge_inspector.cli:main" not in entry_points:
            problems.append("no `ki` console script")
        if "Requires-Python: >=3.11" not in archive.read(f"{info}/METADATA").decode():
            problems.append("Requires-Python is not >=3.11")
        others = sorted(n for n in names - python - frontend if not n.startswith(info + "/"))
        problems += [f"unexpected file: {n}" for n in others]
    if problems:
        fail(f"{wheel} is not complete:\n  " + "\n  ".join(problems))
    print(f"   {len(python)} modules, {len(frontend)} frontend files, console script `ki`: complete")


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__.split("\n\n")[0])
    parser.add_argument("--skip-npm-ci", action="store_true", help="reuse the installed node_modules")
    parser.add_argument("--out", type=Path, default=ROOT / "release", help="wheel directory (default: release/)")
    args = parser.parse_args()
    if sys.version_info < (3, 11):
        fail("Python 3.11 or newer is required")
    build_frontend(args.skip_npm_ci)
    files = stage_frontend()
    wheel = build_wheel(args.out.resolve())
    inspect_wheel(wheel, files)
    print(f"\nbuilt {wheel}\ninstall: pipx install {wheel}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
