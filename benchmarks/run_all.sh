#!/usr/bin/env bash
# Run the whole benchmark suite against a built wheel, into disposable directories.
#
#   python3 scripts/build_release.py --out /tmp/ki-wheel      # build the wheel first
#   python3 examples/chinook/prepare.py --view-copy            # pinned Chinook (read-only input)
#   benchmarks/run_all.sh /tmp/ki-wheel/knowledge_inspector-*.whl [benchmarks/results]
#
# Takes about 40 minutes. Do not use the machine for other work while it runs.
set -euo pipefail
WHEEL=$(realpath "$1"); OUT=$(realpath -m "${2:-benchmarks/results}")
cd "$(dirname "$0")/.."
CHINOOK=examples/chinook/data/Chinook_Sqlite.sqlite
WORK=$(mktemp -d /tmp/ki-bench-work-XXXXXX); trap 'rm -rf "$WORK"' EXIT
mkdir -p "$OUT"

echo "== environment"; { uname -srm; lscpu | grep -E 'Model name|^CPU\(s\)'; free -m | sed -n 2p; cat /sys/devices/system/cpu/cpu0/cpufreq/scaling_governor 2>/dev/null || true; } | tee "$OUT/environment.txt"
python3 -m venv "$WORK/venv"; "$WORK/venv/bin/python" -m pip install -q --no-index --no-deps "$WHEEL"
KI="$WORK/venv/bin/ki"; "$KI" --version | tee -a "$OUT/environment.txt"
python3 benchmarks/make_fixtures.py "$WORK/fx" > "$OUT/fixtures.tsv"

echo "== distribution";  python3 benchmarks/distribution.py "$WHEEL" --out "$OUT/distribution.json" > /dev/null
echo "== python probes"
python3 adapters/source/benchmark_source.py --chinook "$CHINOOK" --repeats 5 --fanout 100000 > "$OUT/python-source.json"
python3 -m adapters.source.benchmark_search > "$OUT/python-search.json"
: > "$OUT/memory-reproduction.jsonl"
for reader in "" "--reader docs.evidence.baseline_model:SourceReader"; do
  python3 docs/evidence/measure_memory.py "$WORK/fx/size-100000.sqlite" event --rows 20 $reader | tail -1 >> "$OUT/memory-reproduction.jsonl"
done
echo "== browser, installed wheel"
node benchmarks/ui_bench.mjs --ki "$KI" --fixtures "$WORK/fx" --chinook "$CHINOOK" --reps 10 --startup-reps 6 --growth-reps 3 --out "$OUT/ui-bench.json" > /dev/null
node benchmarks/ui_bench.mjs --ki "$KI" --fixtures "$WORK/fx" --only growth --growth-reps 3 --reduced-motion 1 --out "$OUT/ui-bench-reduced-motion.json" > /dev/null
echo "done: $OUT"
