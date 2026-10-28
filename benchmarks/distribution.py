#!/usr/bin/env python3
"""Shipped-size measurements for the built frontend and an installed wheel.

    python3 benchmarks/distribution.py WHEEL [--dist dist] [--out results/distribution.json]

Reports raw and gzip (level 6, what a typical static server sends) sizes of every
shipped frontend asset, the wheel size, the wheel's declared runtime
dependencies, and what a fresh virtual environment installs alongside it.
Nothing is written outside --out and a disposable virtual environment.
"""
from __future__ import annotations

import argparse
import gzip
import hashlib
import json
import subprocess
import sys
import tempfile
import zipfile
from pathlib import Path


def gz(data: bytes) -> int:
    return len(gzip.compress(data, 6, mtime=0))


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("wheel")
    parser.add_argument("--out", default="benchmarks/results/distribution.json")
    args = parser.parse_args()
    wheel = Path(args.wheel).resolve()
    assets = []
    with zipfile.ZipFile(wheel) as z:
        names = z.namelist()
        for n in names:
            if "/frontend/" in n and not n.endswith("/"):
                data = z.read(n)
                assets.append({"path": n.split("/frontend/", 1)[1], "bytes": len(data), "gzip_bytes": gz(data)})
        metadata = next(n for n in names if n.endswith("METADATA"))
        requires = [l for l in z.read(metadata).decode().splitlines() if l.startswith("Requires-Dist") or l.startswith("Requires-Python")]
        python_files = [n for n in names if n.endswith(".py")]
    def ext(e): return [a for a in assets if a["path"].endswith(e)]
    def tot(rows, k): return sum(r[k] for r in rows)
    main_js = max(ext(".js"), key=lambda a: a["bytes"])
    fonts = ext(".woff2") + ext(".woff")
    with tempfile.TemporaryDirectory() as tmp:
        venv = Path(tmp) / "v"
        subprocess.run([sys.executable, "-m", "venv", str(venv)], check=True)
        pip = [str(venv / "bin/python"), "-m", "pip"]
        listing = lambda: sorted(p["name"] for p in json.loads(subprocess.run(pip + ["list", "--format=json"], check=True, capture_output=True, text=True).stdout))
        base = listing()
        subprocess.run(pip + ["install", "-q", "--no-index", "--no-deps", str(wheel)], check=True)
        installed = [p for p in listing() if p not in base]
        site = next((venv / "lib").glob("python*/site-packages"))
        installed_bytes = sum(f.stat().st_size for d in ("knowledge_inspector", "adapters") for f in (site / d).rglob("*") if f.is_file())
    result = {
        "wheel": {"file": wheel.name, "bytes": wheel.stat().st_size, "sha256": hashlib.sha256(wheel.read_bytes()).hexdigest(), "python_modules": len(python_files)},
        "declared_requirements": requires,
        "installed_by_wheel_beyond_a_fresh_venv": installed,
        "installed_bytes_in_site_packages": installed_bytes,
        "frontend": {
            "main_js": main_js, "css": ext(".css"),
            "js_total": {"bytes": tot(ext(".js"), "bytes"), "gzip_bytes": tot(ext(".js"), "gzip_bytes")},
            "css_total": {"bytes": tot(ext(".css"), "bytes"), "gzip_bytes": tot(ext(".css"), "gzip_bytes")},
            "fonts": {"files": len(fonts), "bytes": tot(fonts, "bytes"), "note": "woff2 and woff fallbacks both shipped; a browser downloads one per face"},
            "all_assets": {"files": len(assets), "bytes": tot(assets, "bytes"), "gzip_bytes": tot(assets, "gzip_bytes")},
        },
    }
    Path(args.out).parent.mkdir(parents=True, exist_ok=True)
    Path(args.out).write_text(json.dumps(result, indent=2) + "\n")
    print(json.dumps(result, indent=2))


if __name__ == "__main__":
    main()
