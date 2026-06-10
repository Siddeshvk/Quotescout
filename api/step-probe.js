/**
 * QuoteScout — api/step-probe.js
 * STEP (ISO 10303-21) geometry-signal extractor + diagnostic endpoint.
 *
 * WHAT IT DOES
 *   GET   /api/step-probe              -> minimal HTML test page (upload a .step, see signals)
 *   POST  /api/step-probe  (multipart, field "file")
 *                                      -> JSON { signals, summaryText }
 *
 * DESIGN
 *   - Pure-text parse of the STEP Part 21 file. No OpenCascade, no AI call,
 *     no database write. The upload is read once in memory and the temp file
 *     is deleted. Nothing is stored.
 *   - extractStepSignals() and buildStepSummary() are exported so analyze.js
 *     can do:  import { extractStepSignals, buildStepSummary } from './step-probe.js'
 *     and inject the compact summary block into the model prompt instead of
 *     (or alongside) raw CAD text — large token savings, deterministic facts.
 *   - The core extractor is dependency-free (pure string -> object), so the
 *     identical code can later run client-side inside app.html: that bypasses
 *     Vercel's ~4.5 MB request-body limit and means customer CAD never has to
 *     leave the browser for signal extraction.
 *
 * WHAT IT EXTRACTS (deterministic, not AI):
 *   schema (AP203/AP214/AP242), length units, product names, assembly vs part,
 *   solid/shell counts, face-type histogram (planar / cylindrical / conical /
 *   toroidal / spherical / swept / freeform), freeform share, edge count,
 *   distinct cylindrical diameters with counts (hole/bore/boss candidates),
 *   approximate bounding box (vertex point cloud + analytic circle extents —
 *   the circle expansion matters for turned parts, where vertex points alone
 *   sit on the seam and badly under-report the radial extent), aspect ratio.
 *
 * ROBUSTNESS RULES (each one earned by a real file):
 *   - Units are resolved from the GLOBAL_UNIT_ASSIGNED_CONTEXT records the
 *     geometry actually references — NOT from record presence. Every genuine
 *     inch file also contains an SI-mm basis record (INCH := 25.4 × mm), so
 *     "an mm record exists" proves nothing. Mixed contexts -> majority + warning.
 *   - Scale plausibility: declared-inch parts spanning > 100 in trip a warning
 *     (the classic 25.4× bug — mm geometry exported with an inch declaration),
 *     including what the envelope would be if the values were really mm.
 *   - Assemblies: components live in local coordinate frames, so the pooled
 *     point span is flagged unreliable (bbox.reliable = false) and the
 *     machining-character hint is suppressed in favor of a per-part note.
 *   - NURBS-ified analytics: zero analytic curved faces + high B-spline share
 *     warns that the translator may have exported cylinders/fillets as NURBS,
 *     so the part may look "sculpted" when it is a plain milled/turned job.
 *
 * KNOWN LIMITS (honest):
 *   - Face-level signals, not verified machining features (no topology walk).
 *   - Bounding box is an approximation: exact for analytic vertices/circles,
 *     slightly oversized for spline control cages.
 *   - No PMI/GD&T: AP203/AP214 exports carry no tolerances — the drawing
 *     remains the source of truth for tolerance/finish callouts.
 *   True feature recognition (hole depth/axis, min wall, pockets) is phase 2
 *   via an OpenCascade (CadQuery/OCP) microservice — too heavy for Vercel
 *   serverless functions, which cap at 250 MB unzipped.
 *
 * Validated before shipping: node --check (ESM); 17-assertion synthetic-fixture
 * unit test (turned brass-bar part); 17-assertion multipart HTTP round-trip
 * (GET page, 200/422/400/413 paths); and two real-world AS1 assembly exports
 * (AP203 139 KB / AP214 442 KB) parsed in <25 ms each, which exercised the
 * unit-context, scale-plausibility, assembly, and NURBS-ify rules above.
 */

import { readFile, unlink } from 'fs/promises';
import formidable from 'formidable';

export const STEP_PROBE_VERSION = '1.0.0';

const MAX_UPLOAD_BYTES = 16 * 1024 * 1024; // platform will 413 around 4.5 MB on Hobby anyway

/* ─────────────────────────── core extractor (pure, isomorphic) ─────────────────────────── */

/**
 * Parse STEP Part 21 text into geometry signals.
 * @param {string} text     Raw file contents.
 * @param {string} filename For labeling only.
 * @returns {object} signals (see header comment).
 */
export function extractStepSignals(text, filename = '') {
  const warnings = [];
  const out = {
    ok: false,
    probe_version: STEP_PROBE_VERSION,
    file: filename || null,
    bytes: text ? text.length : 0,
  };

  if (!text || text.indexOf('ISO-10303-21') === -1) {
    out.error = 'Not a STEP file (missing ISO-10303-21 marker).';
    return out;
  }

  /* ---- header: schema ---- */
  const schemaM = text.match(/FILE_SCHEMA\s*\(\s*\(\s*'([^']*)'/);
  const schemaRaw = schemaM ? schemaM[1] : '';
  out.schema =
    /AUTOMOTIVE_DESIGN/i.test(schemaRaw) ? 'AP214' :
    /CONFIG_CONTROL_DESIGN|CONFIGURATION_CONTROL/i.test(schemaRaw) ? 'AP203' :
    /AP242|MANAGED_MODEL_BASED/i.test(schemaRaw) ? 'AP242' :
    (schemaRaw ? schemaRaw.split(/\s+/)[0] : 'unknown');

  /* ---- isolate DATA section ---- */
  const di = text.indexOf('DATA;');
  const de = di >= 0 ? text.indexOf('ENDSEC;', di) : -1;
  let data;
  if (di >= 0 && de > di) {
    data = text.slice(di, de);
  } else {
    warnings.push('DATA section markers not found; parsed whole file.');
    data = text;
  }

  /* ---- simple-instance type histogram:  #n = TYPE ( ... ) ; ---- */
  const counts = Object.create(null);
  let entityCount = 0;
  {
    const re = /#\d+\s*=\s*([A-Z][A-Z0-9_]*)\s*\(/g;
    let m;
    while ((m = re.exec(data))) {
      entityCount++;
      counts[m[1]] = (counts[m[1]] || 0) + 1;
    }
  }

  /* ---- complex (multi-supertype) instances:  #n = ( TYPE(...) TYPE(...) ) ; ----
     Length-unit entities are harvested BY ID so units can be resolved from the
     geometric contexts that actually reference them (GLOBAL_UNIT_ASSIGNED_CONTEXT)
     rather than bag-of-records guessing. This matters because every genuine inch
     file *also* contains an SI-mm basis record (INCH := 25.4 × mm), so mere
     presence of an mm record proves nothing. */
  let complexFreeform = 0;
  const unitById = new Map(); // '#821' -> 'inch' | 'mm' | 'cm' | 'm' | 'foot' | 'cbu:<NAME>'
  {
    const re = /(#\d+)\s*=\s*\(([^;]*)\)\s*;/g;
    let m;
    while ((m = re.exec(data))) {
      entityCount++;
      const body = m[2];
      if (body.indexOf('B_SPLINE_SURFACE') !== -1) complexFreeform++;
      if (body.indexOf('LENGTH_UNIT') !== -1) {
        const cbu = /CONVERSION_BASED_UNIT\s*\(\s*'([^']+)'/i.exec(body);
        if (cbu) {
          const n = cbu[1].toUpperCase();
          unitById.set(m[1], n === 'INCH' ? 'inch' : n === 'FOOT' ? 'foot' : 'cbu:' + n);
        } else if (/SI_UNIT\s*\(\s*\.MILLI\.\s*,\s*\.METRE\.\s*\)/.test(body)) unitById.set(m[1], 'mm');
        else if (/SI_UNIT\s*\(\s*\.CENTI\.\s*,\s*\.METRE\.\s*\)/.test(body)) unitById.set(m[1], 'cm');
        else if (/SI_UNIT\s*\(\s*\$\s*,\s*\.METRE\.\s*\)/.test(body)) unitById.set(m[1], 'm');
      }
    }
  }
  /* tally the length units the geometric representation contexts actually use */
  const ctxTally = {};
  {
    const re = /GLOBAL_UNIT_ASSIGNED_CONTEXT\s*\(\s*\(([^)]*)\)/g;
    let m;
    while ((m = re.exec(data))) {
      for (const id of m[1].split(',')) {
        const u = unitById.get(id.trim());
        if (u) { ctxTally[u] = (ctxTally[u] || 0) + 1; break; } // first length unit per context
      }
    }
  }
  let units = 'unknown', unitsAssumed = false;
  const ctxKinds = Object.keys(ctxTally);
  if (ctxKinds.length === 1) {
    units = ctxKinds[0];
  } else if (ctxKinds.length > 1) {
    ctxKinds.sort((a, b) => ctxTally[b] - ctxTally[a]);
    units = ctxKinds[0];
    warnings.push(
      `Mixed length units across representation contexts (${ctxKinds.map(k => `${k}×${ctxTally[k]}`).join(', ')}) — ` +
      `using majority '${units}'; verify scale against the drawing.`
    );
  } else {
    /* no resolvable context — fall back to record presence; conversion-based inch
       sits on top of an SI-mm basis, so INCH wins when both records appear */
    const flat = [...unitById.values()];
    if (flat.includes('inch') || /CONVERSION_BASED_UNIT\s*\(\s*'INCH'/i.test(data)) units = 'inch';
    else if (flat.includes('mm') || /SI_UNIT\s*\(\s*\.MILLI\.\s*,\s*\.METRE\.\s*\)/.test(data)) units = 'mm';
    else if (flat.includes('m') || /SI_UNIT\s*\(\s*\$\s*,\s*\.METRE\.\s*\)/.test(data)) units = 'm';
  }
  if (units.startsWith('cbu:')) {
    warnings.push(`Length unit is a non-standard conversion unit ('${units.slice(4)}') — treating coordinates as mm; verify scale.`);
    units = 'unknown';
  }
  if (units === 'unknown') {
    warnings.push('Length unit not identified — treating coordinates as mm.');
    unitsAssumed = true;
  }
  if (units === 'm') warnings.push('Length unit is metres — unusual for part CAD; verify scale.');
  if (units === 'foot') warnings.push('Length unit is FEET — extremely unusual for part CAD; verify scale.');
  const MM_PER = { mm: 1, cm: 10, m: 1000, inch: 25.4, foot: 304.8 };
  const toMM = MM_PER[units] || 1;

  /* ---- products ---- */
  const products = [];
  {
    const re = /#\d+\s*=\s*PRODUCT\s*\(\s*'([^']*)'\s*,\s*'([^']*)'/g;
    const seen = new Set();
    let m;
    while ((m = re.exec(data))) {
      const key = m[1] + '|' + m[2];
      if (!seen.has(key)) {
        seen.add(key);
        if (products.length < 8) products.push({ id: m[1], name: m[2] });
      }
    }
  }

  /* ---- counts of interest ---- */
  const c = (t) => counts[t] || 0;
  const facesTotal  = c('ADVANCED_FACE') + c('FACE_SURFACE');
  const planar      = c('PLANE');
  const cylindrical = c('CYLINDRICAL_SURFACE');
  const conical     = c('CONICAL_SURFACE');
  const toroidal    = c('TOROIDAL_SURFACE') + c('DEGENERATE_TOROIDAL_SURFACE');
  const spherical   = c('SPHERICAL_SURFACE');
  const swept       = c('SURFACE_OF_REVOLUTION') + c('SURFACE_OF_LINEAR_EXTRUSION');
  const freeform    = c('B_SPLINE_SURFACE_WITH_KNOTS') + c('BEZIER_SURFACE') +
                      c('B_SPLINE_SURFACE') + complexFreeform;
  const knownSurf   = planar + cylindrical + conical + toroidal + spherical + swept + freeform;
  const other       = Math.max(0, facesTotal - knownSurf);
  const edges       = c('EDGE_CURVE');
  const solids      = c('MANIFOLD_SOLID_BREP') + c('BREP_WITH_VOIDS');
  const shells      = c('CLOSED_SHELL') + c('OPEN_SHELL');
  const nauo        = c('NEXT_ASSEMBLY_USAGE_OCCURRENCE');
  const faceDen     = Math.max(facesTotal, knownSurf, 1);

  /* ---- cylindrical diameter distribution (hole/bore/boss candidates) ---- */
  const diaMap = new Map();
  {
    const re = /CYLINDRICAL_SURFACE\s*\(\s*'[^']*'\s*,\s*#\d+\s*,\s*([0-9+\-.eE]+)\s*\)/g;
    let m;
    while ((m = re.exec(data))) {
      const r = Number(m[1]);
      if (!isFinite(r) || r <= 0) continue;
      const d = +(2 * r).toFixed(3);
      diaMap.set(d, (diaMap.get(d) || 0) + 1);
    }
  }
  const allDias = [...diaMap.entries()]
    .map(([d, count]) => ({ d, count }))
    .sort((a, b) => b.count - a.count || a.d - b.d);

  /* ---- bounding box: vertex point cloud + analytic circle extents ----
     Pass 1: axis placements (id -> location/axis refs)
     Pass 2: circles (placement ref + radius); mark which point/direction ids we need
     Pass 3: directions (store only needed)
     Pass 4: cartesian points (bbox over all 3D points; store only circle centers) */
  const plc = new Map();
  {
    const re = /#(\d+)\s*=\s*AXIS2_PLACEMENT_3D\s*\(\s*'[^']*'\s*,\s*#(\d+)\s*,\s*(?:#(\d+)|\$)/g;
    let m;
    while ((m = re.exec(data))) plc.set(m[1], { loc: m[2], axis: m[3] || null });
  }
  const circles = [];
  {
    const re = /#\d+\s*=\s*CIRCLE\s*\(\s*'[^']*'\s*,\s*#(\d+)\s*,\s*([0-9+\-.eE]+)\s*\)/g;
    let m;
    while ((m = re.exec(data))) {
      const r = Number(m[2]);
      if (isFinite(r) && r > 0) circles.push({ pl: m[1], r });
    }
  }
  const needPt = new Set(), needDir = new Set();
  for (const cc of circles) {
    const p = plc.get(cc.pl);
    if (p) { needPt.add(p.loc); if (p.axis) needDir.add(p.axis); }
  }
  const dirs = new Map();
  if (needDir.size) {
    const re = /#(\d+)\s*=\s*DIRECTION\s*\(\s*'[^']*'\s*,\s*\(([^)]+)\)/g;
    let m;
    while ((m = re.exec(data))) {
      if (!needDir.has(m[1])) continue;
      const v = m[2].split(',').map(Number);
      if (v.length === 3 && v.every(isFinite)) dirs.set(m[1], v);
    }
  }
  let n3 = 0, n2 = 0;
  const ctr = new Map();
  const min = [Infinity, Infinity, Infinity];
  const max = [-Infinity, -Infinity, -Infinity];
  {
    const re = /#(\d+)\s*=\s*CARTESIAN_POINT\s*\(\s*'[^']*'\s*,\s*\(([^)]+)\)/g;
    let m;
    while ((m = re.exec(data))) {
      const v = m[2].split(',').map(Number);
      if (v.length === 3 && v.every(isFinite)) {
        n3++;
        if (v[0] < min[0]) min[0] = v[0];
        if (v[0] > max[0]) max[0] = v[0];
        if (v[1] < min[1]) min[1] = v[1];
        if (v[1] > max[1]) max[1] = v[1];
        if (v[2] < min[2]) min[2] = v[2];
        if (v[2] > max[2]) max[2] = v[2];
        if (needPt.has(m[1])) ctr.set(m[1], v);
      } else if (v.length === 2) {
        n2++;
      }
    }
  }
  /* expand bbox by circle extents — critical for turned parts, where the only
     vertex on a full circular edge is the seam point */
  let circleExpanded = 0;
  for (const cc of circles) {
    const p = plc.get(cc.pl);
    if (!p) continue;
    const o = ctr.get(p.loc);
    if (!o) continue;
    let z = p.axis ? dirs.get(p.axis) : null;
    if (!z) z = [0, 0, 1];
    const L = Math.hypot(z[0], z[1], z[2]) || 1;
    for (let k = 0; k < 3; k++) {
      const zk = z[k] / L;
      const half = cc.r * Math.sqrt(Math.max(0, 1 - zk * zk));
      if (o[k] - half < min[k]) min[k] = o[k] - half;
      if (o[k] + half > max[k]) max[k] = o[k] + half;
    }
    circleExpanded++;
  }

  let bbox = null, aspect_ratio = null;
  if (n3 > 0 && isFinite(min[0])) {
    const size = [max[0] - min[0], max[1] - min[1], max[2] - min[2]].map(v => +v.toFixed(3));
    const size_mm = size.map(v => +(v * toMM).toFixed(2));
    const size_in = size_mm.map(v => +(v / 25.4).toFixed(3));
    bbox = {
      min: min.map(v => +v.toFixed(3)),
      max: max.map(v => +v.toFixed(3)),
      size,
      size_mm,
      size_in,
      units: unitsAssumed ? 'mm (assumed)' : units,
      method: circleExpanded ? 'vertex_points+circle_extents' : 'vertex_points',
      reliable: nauo === 0,
    };
    const sorted = [...size].sort((a, b) => b - a);
    aspect_ratio = sorted[2] > 1e-9 ? +(sorted[0] / sorted[2]).toFixed(1) : null;
    if (Math.max(...size) === 0) warnings.push('Degenerate bounding box (all points coincident).');
    /* scale plausibility: the classic 25.4× bug is mm geometry exported with an
       INCH declaration. >100 in (~2.5 m) in any direction is implausible for a
       machined part/assembly, but is exactly what a mislabeled mm file produces. */
    const rawMax = Math.max(...size);
    if (units === 'inch' && rawMax > 100) {
      warnings.push(
        `Declared unit is INCH but the raw span is ${rawMax.toFixed(0)} in (≈ ${(rawMax * 0.0254).toFixed(1)} m) — ` +
        `some exporters mislabel mm geometry as inch. If these values were mm, the envelope would be ` +
        `${size.map(v => v.toFixed(0)).join(' × ')} mm. Confirm units with the customer before quoting.`
      );
    }
    if (nauo > 0) {
      warnings.push(
        'Assembly STEP: components are defined in local coordinate frames, so this raw point span can misstate ' +
        'assembled size — treat the envelope as unreliable and request part-level files for capacity checks.'
      );
    }
  } else {
    warnings.push('No 3D vertex data found — bounding box unavailable.');
  }
  if (n2 > 0 && n2 > n3) warnings.push(`File is dominated by 2D points (${n2}) — may be a drawing/parametric export rather than a solid model.`);

  /* translator quirk: some exporters convert analytic surfaces (cylinders, cones,
     fillets) to B-splines, which would make a plain milled part look "sculpted" */
  if (facesTotal > 0 && (cylindrical + conical + toroidal + spherical) === 0 && freeform / faceDen >= 0.4) {
    warnings.push(
      'All curved faces are B-splines with zero analytic cylinders/cones/fillets — some CAD translators ' +
      'NURBS-ify analytic surfaces on export, so hole and fillet counts may be understated. ' +
      'Verify feature complexity against the drawing rather than this face histogram.'
    );
  }

  Object.assign(out, {
    ok: true,
    units,
    units_assumed: unitsAssumed,
    products,
    is_assembly: nauo > 0,
    assembly_components: nauo,
    solids,
    shells,
    faces: { total: facesTotal, planar, cylindrical, conical, toroidal, spherical, swept, freeform, other },
    freeform_share: +(freeform / faceDen).toFixed(3),
    edges,
    cylinder_diameters: allDias.slice(0, 12),
    distinct_cylinder_diameters: allDias.length,
    points_3d: n3,
    bbox,
    aspect_ratio,
    entity_count: entityCount,
    est_tokens_raw: Math.round(text.length / 4),
    warnings,
  });
  return out;
}

/** One-or-two-sentence character read used in the summary block. */
function geometryHint(s) {
  const f = s.faces;
  const tot = Math.max(1, f.total || (f.planar + f.cylindrical + f.conical + f.toroidal + f.spherical + f.swept + f.freeform));
  const rotational = (f.cylindrical + f.conical + f.toroidal + f.swept) / tot;
  if (s.is_assembly) {
    return 'assembly file — face statistics are pooled across all components, so a single machining character is not meaningful; assess each part from its own file or the drawings';
  }
  if (s.freeform_share >= 0.25) {
    const analyticCurved = f.cylindrical + f.conical + f.toroidal + f.spherical;
    if (analyticCurved === 0 && s.freeform_share >= 0.4) {
      return 'heavily B-spline surfaced — either genuinely sculpted geometry OR a translator that exported analytic faces (cylinders/fillets) as NURBS; verify against the drawing before assuming 5-axis/surface work';
    }
    return 'significant sculpted/freeform surfacing — expect surface machining (ball-nose 3-axis or 5-axis) and longer cycle times';
  }
  if (rotational >= 0.5 && (s.aspect_ratio || 0) >= 2.5) {
    return 'predominantly rotational geometry on a slender envelope — likely turned (lathe) work, possibly with secondary milling';
  }
  if (s.freeform_share <= 0.05) {
    return 'prismatic/analytic geometry — conventional milling and/or turning';
  }
  return 'mixed prismatic geometry with some contoured surfaces';
}

/**
 * Compact, prompt-ready text block for injection into the analyze.js system/user prompt.
 */
export function buildStepSummary(s) {
  if (!s || !s.ok) return '';
  const L = [];
  L.push(`[STEP GEOMETRY SIGNALS — deterministic parse of "${s.file || 'model.step'}" (computed facts, not AI output)]`);
  const prod = s.products.length
    ? s.products.slice(0, 3).map(p => (p.name && p.name !== p.id ? `${p.id} ("${p.name}")` : p.id)).join('; ')
    : 'unnamed';
  L.push(
    `Part: ${prod} | Schema: ${s.schema} | Units: ${s.units}${s.units_assumed ? ' (assumed)' : ''} | ` +
    (s.is_assembly
      ? `ASSEMBLY — ${s.assembly_components} component instance${s.assembly_components === 1 ? '' : 's'}`
      : `single part (${s.solids} solid bod${s.solids === 1 ? 'y' : 'ies'})`)
  );
  if (s.bbox && s.bbox.reliable === false) {
    L.push(
      `Envelope: UNRELIABLE for assemblies (components sit in local frames) — raw point span ` +
      `${s.bbox.size_mm.join(' × ')} mm (${s.bbox.size_in.join(' × ')} in) shown for reference only; ` +
      `use part-level files or the drawing for capacity checks.`
    );
  } else if (s.bbox) {
    L.push(
      `Envelope (approx): ${s.bbox.size_mm.join(' × ')} mm  (${s.bbox.size_in.join(' × ')} in) — ` +
      `${s.bbox.method === 'vertex_points+circle_extents' ? 'vertex+circle bound' : 'vertex bound'}; aspect ratio ${s.aspect_ratio ?? '?'} : 1`
    );
  } else {
    L.push('Envelope: not derivable (no 3D vertex data).');
  }
  const f = s.faces;
  L.push(
    `Faces: ${f.total} — planar ${f.planar}, cylindrical ${f.cylindrical}, conical ${f.conical}, ` +
    `toroidal/fillet ${f.toroidal}, spherical ${f.spherical}, swept ${f.swept}, freeform ${f.freeform} ` +
    `(${Math.round(s.freeform_share * 100)}%)${f.other ? `, other ${f.other}` : ''}; edges ${s.edges}`
  );
  if (s.cylinder_diameters.length) {
    const dd = s.cylinder_diameters.slice(0, 10).map(x => `Ø${x.d}×${x.count}`).join(', ');
    L.push(
      `Cylindrical Ø (${({ inch: 'in', foot: 'ft', m: 'm', cm: 'cm' })[s.units] || 'mm'}): ${dd}` +
      (s.distinct_cylinder_diameters > 10 ? ` … ${s.distinct_cylinder_diameters} distinct total` : '') +
      ' — candidate holes/bores/bosses; cross-check against drawing callouts for drill/tap sizes'
    );
  }
  L.push(`Geometry character: ${geometryHint(s)}.`);
  if (s.warnings.length) L.push(`Caveats: ${s.warnings.join(' ')}`);
  L.push('Note: face-level signals, not verified machining features; bounding box is approximate. Use to corroborate drawing dimensions, check envelope fit against shop capacity, and gauge feature complexity — flag any model/drawing mismatch as a clarification.');
  return L.join('\n');
}

/* ─────────────────────────────── diagnostic test page ─────────────────────────────── */

const PAGE = `<!doctype html>
<html lang="en"><head>
<meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>QuoteScout · STEP geometry probe</title>
<style>
  body{font:14px/1.55 system-ui,-apple-system,Segoe UI,sans-serif;max-width:860px;margin:32px auto;padding:0 16px;color:#16202b;background:#fafbfc}
  h1{font-size:19px;margin:0 0 4px} .sub{color:#5b6878;margin:0 0 18px}
  .card{background:#fff;border:1px solid #dde3ea;border-radius:10px;padding:16px 18px;margin:12px 0}
  pre{background:#101826;color:#d9e4f5;padding:14px;border-radius:8px;overflow:auto;white-space:pre-wrap;font-size:12.5px;margin:8px 0 0}
  button{padding:8px 16px;border-radius:7px;border:1px solid #2b6cb0;background:#2b6cb0;color:#fff;font-weight:600;cursor:pointer;margin-left:8px}
  button:disabled{opacity:.5;cursor:wait}
  input[type=file]{font-size:13px}
  small{color:#5b6878}
  .hide{display:none}
</style></head><body>
<h1>QuoteScout — STEP geometry probe</h1>
<p class="sub">See the deterministic geometry signals QuoteScout extracts from a CAD model before any AI runs.</p>
<div class="card">
  <input type="file" id="f" accept=".step,.stp,.p21,.STEP,.STP">
  <button id="go">Extract signals</button>
  <div><small>Diagnostic endpoint — the file is parsed in memory and discarded; nothing is stored. Upload limit ≈ 4 MB on this endpoint.</small></div>
</div>
<div class="card hide" id="sumCard"><b>Prompt-ready summary</b><pre id="sum"></pre></div>
<div class="card hide" id="jsonCard"><b>Raw signals JSON</b><pre id="json"></pre></div>
<script>
(function(){
  var go = document.getElementById('go');
  go.onclick = function(){
    var inp = document.getElementById('f');
    if (!inp.files[0]) { alert('Choose a STEP file first.'); return; }
    var fd = new FormData(); fd.append('file', inp.files[0]);
    var sum = document.getElementById('sum'), js = document.getElementById('json');
    document.getElementById('sumCard').classList.remove('hide');
    document.getElementById('jsonCard').classList.remove('hide');
    sum.textContent = 'Working…'; js.textContent = ''; go.disabled = true;
    fetch(location.pathname, { method:'POST', body: fd })
      .then(function(r){ return r.json(); })
      .then(function(j){
        sum.textContent = j.summaryText || (j.signals && j.signals.error) || j.error || 'No summary returned.';
        js.textContent = JSON.stringify(j.signals || j, null, 2);
      })
      .catch(function(e){ sum.textContent = 'Request failed: ' + e; })
      .then(function(){ go.disabled = false; });
  };
})();
</script>
</body></html>`;

/* ─────────────────────────────────── handler ─────────────────────────────────── */

export default async function handler(req, res) {
  if (req.method === 'GET') {
    res.setHeader('Content-Type', 'text/html; charset=utf-8');
    return res.status(200).send(PAGE);
  }
  if (req.method !== 'POST') {
    res.setHeader('Allow', 'GET, POST');
    return res.status(405).json({ error: 'Use GET for the test page, or POST multipart/form-data with field "file".' });
  }

  let tmp = null;
  try {
    const form = formidable({ maxFiles: 1, maxFileSize: MAX_UPLOAD_BYTES });
    const { files } = await new Promise((resolve, reject) =>
      form.parse(req, (err, fields, fls) => (err ? reject(err) : resolve({ fields, files: fls })))
    );

    // Normalize across formidable v2 (object) and v3 (array) shapes.
    let f = files && (files.file !== undefined ? files.file : Object.values(files)[0]);
    if (Array.isArray(f)) f = f[0];
    const fp = f && (f.filepath || f.path);
    if (!fp) return res.status(400).json({ error: 'No file received. Send multipart field "file".' });
    tmp = fp;

    const text = await readFile(fp, 'latin1');
    const signals = extractStepSignals(text, f.originalFilename || f.name || 'upload.step');
    if (!signals.ok) return res.status(422).json({ signals });

    return res.status(200).json({ signals, summaryText: buildStepSummary(signals) });
  } catch (err) {
    const msg = String((err && err.message) || err);
    const code = /maxFileSize|too large|413/i.test(msg) ? 413
               : /MultipartParser|no parser found|boundary|malformed/i.test(msg) ? 400
               : 500;
    return res.status(code).json({ error: msg });
  } finally {
    if (tmp) unlink(tmp).catch(() => {});
  }
}
