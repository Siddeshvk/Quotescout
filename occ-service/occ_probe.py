"""
QuoteScout — occ_probe.py
OpenCascade (OCCT via OCP) topology feature extraction. Stage B of the geometry
pipeline: produces the things step-probe.js (a pure-text STEP parser) CANNOT —
real volumes, an exact assembled bounding box, hole DEPTHS (so depth:diameter),
internal-vs-external discrimination, a material-removal proxy, and an approximate
min wall — all from the actual B-rep.

CONTRACT: probe_step(path, options) -> dict (JSON-serializable). This dict is the
input the QuoteScout rules engine (lib/rules.js) consumes downstream. Keys are
stable; see README for the documented schema.

PRINCIPLES (match the rest of QuoteScout):
- Never raise on a valid STEP. Every computation is independently guarded; on
  failure the field is null and a warning is appended. A partial result beats a 500.
- Be honest about confidence. Exact analytic facts (bbox, volume, hole diameter)
  are reported plainly; estimates (min wall, through/blind, removal ratio) are
  labeled approximate and the rules engine treats them conservatively.
- No PMI/GD&T here either — STEP carries none. This complements the drawing; it
  does not replace it.
"""

import math
import re
import time

from OCP.STEPControl import STEPControl_Reader
from OCP.IFSelect import IFSelect_RetDone
from OCP.Interface import Interface_Static
from OCP.Bnd import Bnd_Box
from OCP.BRepBndLib import BRepBndLib
from OCP.BRepGProp import BRepGProp
from OCP.GProp import GProp_GProps
from OCP.TopExp import TopExp_Explorer, TopExp
from OCP.TopAbs import (
    TopAbs_FACE, TopAbs_SOLID, TopAbs_EDGE, TopAbs_VERTEX, TopAbs_IN, TopAbs_ON,
)
from OCP.TopoDS import TopoDS
from OCP.TopTools import TopTools_IndexedMapOfShape
from OCP.BRep import BRep_Tool
from OCP.BRepAdaptor import BRepAdaptor_Surface
from OCP.GeomAbs import (
    GeomAbs_Plane, GeomAbs_Cylinder, GeomAbs_Cone, GeomAbs_Sphere, GeomAbs_Torus,
    GeomAbs_BSplineSurface, GeomAbs_BezierSurface, GeomAbs_SurfaceOfRevolution,
    GeomAbs_SurfaceOfExtrusion,
)
from OCP.BRepClass3d import BRepClass3d_SolidClassifier
from OCP.BRepLProp import BRepLProp_SLProps
from OCP.IntCurvesFace import IntCurvesFace_ShapeIntersector
from OCP.gp import gp_Pnt, gp_Dir, gp_Lin

OCC_PROBE_VERSION = "1.0.0"

# Tunables (kept conservative for Cloud Run CPU/time budget)
MIN_WALL_MAX_SOLIDS = 4          # skip min-wall on big assemblies (too slow / not meaningful)
MIN_WALL_SAMPLES_PER_FACE = 6    # UV grid is N x N per face
MIN_WALL_FACE_CAP = 400          # stop after this many faces sampled
NORMAL_CLUSTER_DEG = 10.0        # planar-face normals within this angle = same setup direction


# --------------------------------------------------------------------------- #
# loading
# --------------------------------------------------------------------------- #
def _read_step(path):
    """Load a STEP file, forcing output units to millimetres. Returns (shape, warnings)."""
    warnings = []
    # Force the importer to convert whatever the file declares into mm so every
    # downstream number is in mm regardless of the file's native unit.
    Interface_Static.SetCVal_s("xstep.cascade.unit", "MM")
    reader = STEPControl_Reader()
    status = reader.ReadFile(path)
    if status != IFSelect_RetDone:
        raise ValueError(f"STEP read failed (status {int(status)}) — file is not a readable STEP.")
    reader.TransferRoots()
    shape = reader.OneShape()
    if shape is None or shape.IsNull():
        raise ValueError("STEP transferred to an empty shape — geometry could not be reconstructed.")
    return shape, warnings


def _native_unit_from_text(path):
    """Cheap header sniff (mirrors step-probe.js) so we can report the file's
    declared unit and flag the classic inch/mm mislabel independently of OCC."""
    try:
        with open(path, "r", encoding="latin-1", errors="ignore") as fh:
            head = fh.read(200000)
    except Exception:
        return None
    has_inch = re.search(r"CONVERSION_BASED_UNIT\s*\(\s*'INCH'", head, re.I) is not None
    has_mm = re.search(r"SI_UNIT\s*\(\s*\.MILLI\.\s*,\s*\.METRE\.\s*\)", head, re.I) is not None
    if has_inch and not has_mm:
        return "inch"
    if has_inch and has_mm:
        return "inch+mm(mixed)"
    if has_mm:
        return "mm"
    return None


# --------------------------------------------------------------------------- #
# small topology helpers
# --------------------------------------------------------------------------- #
def _iter(shape, kind):
    ex = TopExp_Explorer(shape, kind)
    while ex.More():
        yield ex.Current()
        ex.Next()


def _count_unique(shape, kind):
    m = TopTools_IndexedMapOfShape()
    TopExp.MapShapes_s(shape, kind, m)
    return m.Extent()


def _solids(shape):
    return [TopoDS.Solid_s(s) for s in _iter(shape, TopAbs_SOLID)]


def _bbox(shape):
    box = Bnd_Box()
    BRepBndLib.Add_s(shape, box)
    xmin, ymin, zmin, xmax, ymax, zmax = box.Get()
    return (
        [round(xmax - xmin, 3), round(ymax - ymin, 3), round(zmax - zmin, 3)],
        (xmin, ymin, zmin, xmax, ymax, zmax),
    )


def _volume(shape):
    g = GProp_GProps()
    BRepGProp.VolumeProperties_s(shape, g)
    return g.Mass()


def _surface_area(shape):
    g = GProp_GProps()
    BRepGProp.SurfaceProperties_s(shape, g)
    return g.Mass()


def _face_vertices(face):
    pts = []
    for v in _iter(face, TopAbs_VERTEX):
        p = BRep_Tool.Pnt_s(TopoDS.Vertex_s(v))
        pts.append((p.X(), p.Y(), p.Z()))
    return pts


# --------------------------------------------------------------------------- #
# faces histogram
# --------------------------------------------------------------------------- #
_SURF_NAME = {
    GeomAbs_Plane: "planar",
    GeomAbs_Cylinder: "cylindrical",
    GeomAbs_Cone: "conical",
    GeomAbs_Sphere: "spherical",
    GeomAbs_Torus: "toroidal",
    GeomAbs_BSplineSurface: "freeform",
    GeomAbs_BezierSurface: "freeform",
    GeomAbs_SurfaceOfRevolution: "swept",
    GeomAbs_SurfaceOfExtrusion: "swept",
}


def _faces_histogram(shape):
    hist = {k: 0 for k in ["planar", "cylindrical", "conical", "spherical",
                           "toroidal", "swept", "freeform", "other"]}
    total = 0
    for f in _iter(shape, TopAbs_FACE):
        total += 1
        try:
            t = BRepAdaptor_Surface(TopoDS.Face_s(f)).GetType()
            hist[_SURF_NAME.get(t, "other")] += 1
        except Exception:
            hist["other"] += 1
    hist["total"] = total
    return hist


# --------------------------------------------------------------------------- #
# holes / bosses (the headline new signal: DEPTH -> depth:diameter)
# --------------------------------------------------------------------------- #
def _point_inside_any_solid(solids, p, tol=1e-6):
    for s in solids:
        clf = BRepClass3d_SolidClassifier(s)
        clf.Perform(p, tol)
        st = clf.State()
        if st == TopAbs_IN or st == TopAbs_ON:
            return True
    return False


def _cylindrical_features(shape, solids):
    """Group cylindrical faces into hole/boss features with depth along the axis.
    Internal (hole) vs external (boss) is decided by probing just inside the
    radius at mid-height: inside the solid -> material fills it -> boss; else hole."""
    raw = []
    for f in _iter(shape, TopAbs_FACE):
        try:
            face = TopoDS.Face_s(f)
            ad = BRepAdaptor_Surface(face)
            if ad.GetType() != GeomAbs_Cylinder:
                continue
            cyl = ad.Cylinder()
            r = cyl.Radius()
            ax = cyl.Axis()
            loc = ax.Location()
            d = ax.Direction()
            o = (loc.X(), loc.Y(), loc.Z())
            dv = (d.X(), d.Y(), d.Z())
            # depth = span of this face's vertices projected on the axis direction
            projs = []
            for (px, py, pz) in _face_vertices(face):
                projs.append((px - o[0]) * dv[0] + (py - o[1]) * dv[1] + (pz - o[2]) * dv[2])
            depth = (max(projs) - min(projs)) if len(projs) >= 2 else None
            raw.append({"r": r, "o": o, "d": dv, "depth": depth, "mid": (
                None if not projs else (min(projs) + max(projs)) / 2.0)})
        except Exception:
            continue

    # cluster coaxial + equal-radius faces (a single drilled hole can be several faces)
    used = [False] * len(raw)
    feats = []
    for i in range(len(raw)):
        if used[i]:
            continue
        a = raw[i]
        group = [a]
        used[i] = True
        for j in range(i + 1, len(raw)):
            if used[j]:
                continue
            b = raw[j]
            if abs(a["r"] - b["r"]) > max(0.01, 0.01 * a["r"]):
                continue
            # same axis direction (parallel, within ~1 deg) and collinear origins
            dot = abs(a["d"][0] * b["d"][0] + a["d"][1] * b["d"][1] + a["d"][2] * b["d"][2])
            if dot < 0.9998:
                continue
            # distance between axis lines ~ 0
            ox = (b["o"][0] - a["o"][0], b["o"][1] - a["o"][1], b["o"][2] - a["o"][2])
            cross = (
                ox[1] * a["d"][2] - ox[2] * a["d"][1],
                ox[2] * a["d"][0] - ox[0] * a["d"][2],
                ox[0] * a["d"][1] - ox[1] * a["d"][0],
            )
            if math.sqrt(cross[0] ** 2 + cross[1] ** 2 + cross[2] ** 2) > max(0.05, 0.01 * a["r"]):
                continue
            group.append(b)
            used[j] = True

        depths = [g["depth"] for g in group if g["depth"] is not None]
        if not depths:
            continue
        depth = round(sum(depths), 3)  # contiguous faces of one hole -> additive height
        dia = round(a["r"] * 2.0, 3)
        # internal vs external: probe a point just inside the radius at mid-height
        kind = "unknown"
        try:
            mid = group[0]["mid"] or 0.0
            o, d, r = group[0]["o"], group[0]["d"], group[0]["r"]
            base = (o[0] + d[0] * mid, o[1] + d[1] * mid, o[2] + d[2] * mid)
            # any perpendicular direction
            perp = (1.0, 0.0, 0.0)
            if abs(d[0]) > 0.9:
                perp = (0.0, 1.0, 0.0)
            # gram-schmidt to make perp ⟂ d
            pd = perp[0] * d[0] + perp[1] * d[1] + perp[2] * d[2]
            perp = (perp[0] - pd * d[0], perp[1] - pd * d[1], perp[2] - pd * d[2])
            pl = math.sqrt(perp[0] ** 2 + perp[1] ** 2 + perp[2] ** 2) or 1.0
            perp = (perp[0] / pl, perp[1] / pl, perp[2] / pl)
            inside_r = max(0.0, r - max(0.05, 0.02 * r))
            probe = gp_Pnt(base[0] + perp[0] * inside_r, base[1] + perp[1] * inside_r, base[2] + perp[2] * inside_r)
            kind = "boss" if _point_inside_any_solid(solids, probe) else "hole"
        except Exception:
            kind = "unknown"

        feats.append({
            "diameter_mm": dia,
            "depth_mm": depth,
            "depth_to_dia": round(depth / dia, 2) if dia > 1e-9 else None,
            "kind": kind,
        })

    # sort by depth:dia descending so the worst hole is first
    feats.sort(key=lambda h: (h["depth_to_dia"] or 0), reverse=True)
    return feats


# --------------------------------------------------------------------------- #
# setup-orientation proxy (cheap stand-in for "how many setups", NOT pocket recognition)
# --------------------------------------------------------------------------- #
def _distinct_setup_normals(shape):
    dirs = []
    for f in _iter(shape, TopAbs_FACE):
        try:
            face = TopoDS.Face_s(f)
            ad = BRepAdaptor_Surface(face)
            if ad.GetType() != GeomAbs_Plane:
                continue
            n = ad.Plane().Axis().Direction()
            dirs.append((n.X(), n.Y(), n.Z()))
        except Exception:
            continue
    clusters = []
    cos_tol = math.cos(math.radians(NORMAL_CLUSTER_DEG))
    for d in dirs:
        placed = False
        for c in clusters:
            # treat +n and -n as DIFFERENT setups (top vs bottom face are 2 setups)
            dot = d[0] * c[0] + d[1] * c[1] + d[2] * c[2]
            if dot >= cos_tol:
                placed = True
                break
        if not placed:
            clusters.append(d)
    return len(clusters)


# --------------------------------------------------------------------------- #
# approximate min wall (sampled inward ray casting) — labeled approximate
# --------------------------------------------------------------------------- #
def _min_wall(shape, solids, bbox_size):
    if len(solids) > MIN_WALL_MAX_SOLIDS:
        return None, "min wall skipped (assembly with many solids — not meaningful / too slow)."
    inter = IntCurvesFace_ShapeIntersector()
    inter.Load(shape, 1e-6)
    smallest = None
    faces_done = 0
    diag = math.sqrt(sum(s * s for s in bbox_size)) or 1.0
    for f in _iter(shape, TopAbs_FACE):
        if faces_done >= MIN_WALL_FACE_CAP:
            break
        faces_done += 1
        try:
            face = TopoDS.Face_s(f)
            ad = BRepAdaptor_Surface(face)
            u0, u1 = ad.FirstUParameter(), ad.LastUParameter()
            v0, v1 = ad.FirstVParameter(), ad.LastVParameter()
            if not all(map(math.isfinite, [u0, u1, v0, v1])):
                continue
            n = MIN_WALL_SAMPLES_PER_FACE
            for iu in range(1, n):
                for iv in range(1, n):
                    u = u0 + (u1 - u0) * iu / n
                    v = v0 + (v1 - v0) * iv / n
                    props = BRepLProp_SLProps(ad, u, v, 1, 1e-6)
                    if not props.IsNormalDefined():
                        continue
                    p = props.Value()
                    nrm = props.Normal()
                    # shoot INTO the material: -normal. nudge off the surface first.
                    eps = diag * 1e-4
                    start = gp_Pnt(p.X() - nrm.X() * eps, p.Y() - nrm.Y() * eps, p.Z() - nrm.Z() * eps)
                    ray = gp_Lin(start, gp_Dir(-nrm.X(), -nrm.Y(), -nrm.Z()))
                    inter.PerformNearest(ray, 1e-6, diag)
                    if inter.IsDone() and inter.NbPnt() > 0:
                        dist = inter.WParameter(1)
                        if dist > 1e-4 and (smallest is None or dist < smallest):
                            smallest = dist
        except Exception:
            continue
    if smallest is None:
        return None, "min wall could not be estimated."
    # sanity: must be positive and below the part's largest extent
    if smallest <= 0 or smallest > max(bbox_size):
        return None, "min wall estimate failed sanity check — ignored."
    return round(smallest, 3), None


# --------------------------------------------------------------------------- #
# top-level
# --------------------------------------------------------------------------- #
def probe_step(path, options=None):
    """Extract geometry features from a STEP file. Returns a JSON-serializable dict."""
    options = options or {}
    compute_min_wall = options.get("min_wall", True)
    t0 = time.time()
    out = {"ok": False, "version": f"occ-probe {OCC_PROBE_VERSION}", "warnings": []}

    try:
        shape, warns = _read_step(path)
    except Exception as e:
        out["error"] = str(e)
        return out
    out["warnings"].extend(warns)

    timing = {}

    def timed(label, fn, default=None):
        s = time.time()
        try:
            r = fn()
        except Exception as e:
            out["warnings"].append(f"{label} failed: {str(e)[:160]}")
            r = default
        timing[label] = int((time.time() - s) * 1000)
        return r

    solids = timed("solids", lambda: _solids(shape), []) or []
    num_solids = len(solids)
    out["num_solids"] = num_solids
    out["is_assembly"] = num_solids > 1

    bbox_size, bbox_raw = timed("bbox", lambda: _bbox(shape), ([None, None, None], None)) or ([None, None, None], None)
    out["bbox_mm"] = bbox_size
    bbox_vol = None
    if bbox_size and all(isinstance(x, (int, float)) for x in bbox_size):
        bbox_vol = bbox_size[0] * bbox_size[1] * bbox_size[2]
        out["bbox_volume_mm3"] = round(bbox_vol, 1)
        sized = sorted([s for s in bbox_size if s], reverse=True)
        out["aspect_ratio"] = round(sized[0] / sized[-1], 1) if len(sized) == 3 and sized[-1] > 1e-9 else None

    vol = timed("volume", lambda: _volume(shape), None)
    if vol is not None:
        out["volume_mm3"] = round(vol, 1)
        if bbox_vol and bbox_vol > 1e-9:
            out["removal_ratio"] = round(max(0.0, 1.0 - vol / bbox_vol), 3)  # stock-removal proxy (approx)

    area = timed("surface_area", lambda: _surface_area(shape), None)
    if area is not None:
        out["surface_area_mm2"] = round(area, 1)

    out["faces"] = timed("faces", lambda: _faces_histogram(shape), {}) or {}
    out["edges_total"] = timed("edges", lambda: _count_unique(shape, TopAbs_EDGE), None)

    holes = timed("holes", lambda: _cylindrical_features(shape, solids), []) or []
    out["holes"] = holes
    out["hole_count"] = len([h for h in holes if h["kind"] != "boss"])
    dtd = [h["depth_to_dia"] for h in holes if h["kind"] == "hole" and h["depth_to_dia"] is not None]
    out["max_depth_to_dia"] = max(dtd) if dtd else None

    out["distinct_setup_normals"] = timed("setup_normals", lambda: _distinct_setup_normals(shape), None)

    if compute_min_wall:
        mw, mwwarn = timed("min_wall", lambda: _min_wall(shape, solids, bbox_size), (None, None)) or (None, None)
        out["min_wall_mm"] = mw
        out["min_wall_method"] = "sampled_inward_raycast"
        out["min_wall_confidence"] = "approximate"
        if mwwarn:
            out["warnings"].append(mwwarn)
    else:
        out["min_wall_mm"] = None

    # units: output is forced to mm; report the file's declared native unit and
    # flag the classic mislabel so the rules engine can raise a unit-confirm flag.
    native = _native_unit_from_text(path)
    out["units"] = "mm"
    out["native_unit_declared"] = native
    if native and "inch" in native and bbox_size and max([s for s in bbox_size if s] or [0]) > 2500:
        out["warnings"].append(
            f"File declares INCH and converts to a {round(max(bbox_size))} mm envelope (~{round(max(bbox_size)/1000,1)} m) — "
            "implausibly large for a machined part; the file may actually be millimetres mislabeled as inch. Confirm units before quoting."
        )
    if out["is_assembly"]:
        out["warnings"].append(
            "Assembly STEP: bbox/volume are for the assembled product (correctly placed). Per-part feature analysis "
            "(holes, min wall) mixes all components — request part-level files for part-specific flags."
        )

    out["timing_ms"] = timing
    out["elapsed_ms"] = int((time.time() - t0) * 1000)
    out["ok"] = True
    return out
