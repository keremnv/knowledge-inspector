"""What pyproject.toml cannot say: ship only the Source application's modules,
and refuse to build without the staged, verified frontend.

Stage the frontend with `python3 scripts/build_release.py`, which also builds
the wheel. Configuration lives in pyproject.toml.
"""
import sys
from pathlib import Path

from setuptools import setup
from setuptools.command.build_py import build_py

HERE = Path(__file__).resolve().parent
SHIPPED = {
    "knowledge_inspector": {"__init__", "__main__", "cli"},
    "adapters": {"capture"},
    "adapters.sqlite": {"server"},
    "adapters.source": {"app", "model", "server"},
}


class BuildPy(build_py):
    def find_package_modules(self, package, package_dir):
        return [module for module in super().find_package_modules(package, package_dir)
                if module[1] in SHIPPED.get(package, ())]

    def run(self):
        sys.path.insert(0, str(HERE))
        from adapters.source.app import frontend_problems
        frontend = HERE / "knowledge_inspector" / "frontend"
        problems = (frontend_problems(frontend, require_manifest=True) if (frontend / "index.html").is_file()
                    else [f"no staged frontend at {frontend}"])
        if problems:
            sys.exit("knowledge-inspector: refusing to build without the compiled frontend:\n  "
                     + "\n  ".join(problems)
                     + "\n  Build it first: python3 scripts/build_release.py (needs Node.js and npm)")
        super().run()


setup(cmdclass={"build_py": BuildPy})
