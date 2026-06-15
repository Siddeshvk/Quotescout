"""
Self-contained validation for occ_probe.py.
Ground-truth checks (a known block + a thin plate) ALWAYS run — the fixtures are
generated on the fly by make_fixtures.py. The real-world AS1 assembly checks run
only if real1.stp / real2.stp happen to be present next to this script; if not,
they're reported as SKIPPED (not failures), so the suite passes out of the box.

Run:  python validate_occ.py
"""
import json
import os
import subprocess
import sys

from occ_probe import probe_step

HERE = os.path.dirname(os.path.abspath(__file__))

# Ensure the known-geometry fixtures exist (regenerate if missing).
for fx in ("fixture_holes.step", "fixture_thinwall.step"):
    if not os.path.exists(os.path.join(HERE, fx)):
        print(f"[setup] {fx} missing — running make_fixtures.py")
        subprocess.run([sys.executable, os.path.join(HERE, "make_fixtures.py")], cwd=HERE, check=True)
        break

p = 0
f = 0
skipped = 0


def ok(name, cond, extra=""):
    global p, f
    p += cond
    f += (not cond)
    print(("ok   " if cond else "FAIL ") + name + (("  — " + extra) if extra else ""))


def skip(name, why):
    global skipped
    skipped += 1
    print(f"skip {name}  — {why}")


def approx(a, b, tol):
    return a is not None and abs(a - b) <= tol


print("===== Fixture A: 50x30x20 block, O10 through + O6 blind 8 deep =====")
a = probe_step(os.path.join(HERE, "fixture_holes.step"))
print(json.dumps({k: a[k] for k in ["ok", "num_solids", "bbox_mm", "volume_mm3", "bbox_volume_mm3",
      "removal_ratio", "hole_count", "max_depth_to_dia", "holes", "faces", "edges_total",
      "distinct_setup_normals", "min_wall_mm"] if k in a}, indent=1))
ok("A ok", a.get("ok"))
ok("A single solid", a.get("num_solids") == 1)
ok("A bbox 50x30x20", a.get("bbox_mm") == [50.0, 30.0, 20.0], str(a.get("bbox_mm")))
ok("A volume ~28203", approx(a.get("volume_mm3"), 28203.0, 50), str(a.get("volume_mm3")))
ok("A 2 holes detected", a.get("hole_count") == 2, str(a.get("hole_count")))
dias = sorted(h["diameter_mm"] for h in a["holes"] if h["kind"] == "hole")
ok("A hole diameters [6,10]", dias == [6.0, 10.0], str(dias))
h10 = next((h for h in a["holes"] if h["diameter_mm"] == 10.0), None)
h6 = next((h for h in a["holes"] if h["diameter_mm"] == 6.0), None)
ok("A O10 depth 20 (through)", h10 and approx(h10["depth_mm"], 20.0, 0.1), str(h10))
ok("A O10 depth:dia 2.0", h10 and approx(h10["depth_to_dia"], 2.0, 0.05))
ok("A O6 depth 8 (blind)", h6 and approx(h6["depth_mm"], 8.0, 0.1), str(h6))
ok("A O6 depth:dia ~1.33", h6 and approx(h6["depth_to_dia"], 1.33, 0.05))
ok("A max_depth_to_dia 2.0", approx(a.get("max_depth_to_dia"), 2.0, 0.05))
ok("A holes classified internal (not boss)", all(h["kind"] == "hole" for h in a["holes"]))
ok("A removal_ratio ~0.06", approx(a.get("removal_ratio"), 0.06, 0.02), str(a.get("removal_ratio")))
ok("A face counts present", a["faces"]["total"] >= 8, str(a["faces"]))

print("\n===== Fixture B: 40x40x2 thin plate (min wall must ~2.0) =====")
b = probe_step(os.path.join(HERE, "fixture_thinwall.step"))
print("min_wall_mm:", b.get("min_wall_mm"), "| method:", b.get("min_wall_method"),
      "| conf:", b.get("min_wall_confidence"), "| bbox:", b.get("bbox_mm"))
ok("B min wall ~2.0mm", approx(b.get("min_wall_mm"), 2.0, 0.3), str(b.get("min_wall_mm")))

print("\n===== Real assemblies (optional - run only if sample files present) =====")
real_specs = [("real2.stp", "mm"), ("real1.stp", "inch+mm(mixed)")]
have_real = all(os.path.exists(os.path.join(HERE, name)) for name, _ in real_specs)
if not have_real:
    skip("real-assembly checks", "real1.stp/real2.stp not bundled (third-party AS1 samples). "
                                 "Drop them next to this script to enable these checks.")
else:
    for name, expect_units in real_specs:
        r = probe_step(os.path.join(HERE, name), {"min_wall": False})
        print(f"-- {name}: ok={r.get('ok')} solids={r.get('num_solids')} bbox={r.get('bbox_mm')} "
              f"native_unit={r.get('native_unit_declared')} elapsed={r.get('elapsed_ms')}ms warns={len(r.get('warnings', []))}")
        ok(f"{name} ok + is_assembly", r.get("ok") and r.get("is_assembly"))
        ok(f"{name} native unit {expect_units}", r.get("native_unit_declared") == expect_units,
           str(r.get("native_unit_declared")))
    r1 = probe_step(os.path.join(HERE, "real1.stp"), {"min_wall": False})
    ok("real1 scale-bug warning raised",
       any("mislabeled as inch" in w or "millimetres mislabeled" in w for w in r1.get("warnings", [])),
       str(r1.get("warnings")))

print(f"\n{p} passed, {f} failed, {skipped} skipped")
sys.exit(1 if f else 0)
