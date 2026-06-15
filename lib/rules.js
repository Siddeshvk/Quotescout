/**
 * QuoteScout — lib/rules.js  (v2: real-geometry rules)
 * Deterministic machining-risk rules. Roadmap #3 — "the core move."
 *
 * v2 change: now that the OCC microservice (occ-service/) returns true topology,
 * the rules consume REAL geometry the AI cannot compute — hole DEPTH (depth:dia),
 * min wall, material-removal ratio, and a setup-count proxy — and the engine
 * emits flags in the SAME schema as the AI's flags so job-status.js can merge
 * them straight into the report with zero renderer changes.
 *
 * INPUT (all optional; a rule fires only when its specific input is present):
 *   evaluateRules({
 *     geometry,      // OCC /probe JSON  OR  step-probe signals (auto-normalized)
 *     dimensions,    // AI-extracted dimensions[] (reserved; see note)
 *     profile,       // shop profile: text string, or an object with optional
 *                    //   max_part_envelope_mm:[x,y,z] for the envelope rule
 *     material,      // freeform material string (reserved)
 *     requirements,  // reserved
 *   }) -> { flags:[...app-schema...], rules_version, fired, evaluated }
 *
 * FLAG SCHEMA (matches analyze.js SYSTEM_PROMPT output exactly):
 *   { severity:'RED'|'AMBER'|'YELLOW'|'PURPLE',
 *     category:'compliance'|'sequence'|'dimensional'|'outside_service'|
 *              'inspection'|'material'|'cost'|'clarification',
 *     title, description, recommendedAction, impact,
 *     confidence: 0-100 (integer),
 *     source:'rules', rule:'<id>', evidence:{...} }
 *
 * HONESTY: exact-geometry rules (deep_hole) carry high confidence; estimate-based
 * rules (thin_wall, high_removal, many_setups) carry lower confidence and "verify"
 * language, because the underlying OCC fields are labeled approximate. Below 70
 * confidence a flag is downgraded to PURPLE, matching the app's own convention.
 *
 * NOTE on material/tolerance/certification rules: those were in v1 but the AI's
 * own system prompt already enforces them (material exclusions, hard-to-machine,
 * envelope/HP, PPAP, etc.) AND its output carries no structured material field or
 * numeric tolerance list to drive them deterministically — so re-deriving them
 * here would duplicate the AI and fire on nothing. They are intentionally omitted
 * until a structured shop profile / structured dimensions exist. Every rule below
 * can actually fire on real inputs.
 */

export const RULES_VERSION = '2.0.0';

/* ------------------------------ helpers ------------------------------ */
function num(x) { const n = typeof x === 'number' ? x : parseFloat(x); return Number.isFinite(n) ? n : null; }
function arr(x) { return Array.isArray(x) ? x : (x == null ? [] : [x]); }
function lc(x) { return String(x == null ? '' : x).toLowerCase(); }
function clampConf(c) { c = Math.round(num(c) || 0); return c < 0 ? 0 : c > 100 ? 100 : c; }

/** Below-70 confidence -> PURPLE, per the app's own rule. */
function mkflag(o) {
  const conf = clampConf(o.confidence);
  let severity = o.severity || 'PURPLE';
  if (conf < 70) severity = 'PURPLE';
  return {
    source: 'rules',
    severity,
    category: o.category || 'dimensional',
    title: o.title || '',
    description: o.description || '',
    recommendedAction: o.recommendedAction || '',
    impact: o.impact || '',
    confidence: conf,
    rule: o.rule,
    evidence: o.evidence || {},
  };
}

/** Normalize OCC features OR step-probe signals into one shape the rules read. */
function normGeom(geometry) {
  if (!geometry || typeof geometry !== 'object') return null;
  const g = {};
  const isOcc = ('max_depth_to_dia' in geometry) || ('min_wall_mm' in geometry) ||
                ('removal_ratio' in geometry) || ('distinct_setup_normals' in geometry);
  g.source_kind = isOcc ? 'occ' : 'step';

  // bbox: OCC = flat bbox_mm; step-probe = bbox.size_mm
  g.bbox_mm = Array.isArray(geometry.bbox_mm)
    ? geometry.bbox_mm
    : (geometry.bbox && Array.isArray(geometry.bbox.size_mm) ? geometry.bbox.size_mm : null);

  g.aspect_ratio = num(geometry.aspect_ratio);
  g.is_assembly = !!geometry.is_assembly;
  g.assembly_components = geometry.assembly_components ?? geometry.num_solids ?? null;
  g.faces = geometry.faces || {};
  // freeform share
  if (isOcc && g.faces && num(g.faces.total)) {
    g.freeform_share = num(g.faces.freeform) ? g.faces.freeform / g.faces.total : 0;
  } else {
    g.freeform_share = num(geometry.freeform_share);
  }
  g.holes = Array.isArray(geometry.holes) ? geometry.holes : null;
  g.max_depth_to_dia = num(geometry.max_depth_to_dia);
  g.min_wall_mm = num(geometry.min_wall_mm);
  g.min_wall_confidence = geometry.min_wall_confidence || null;
  g.removal_ratio = num(geometry.removal_ratio);
  g.distinct_setup_normals = num(geometry.distinct_setup_normals);
  g.warnings = arr(geometry.warnings);
  g.native_unit = geometry.native_unit_declared || geometry.units || null;
  g.units_assumed = !!geometry.units_assumed;
  return g;
}

/* ------------------------------ rules ------------------------------ */
/* Each rule: (ctx) => flag | flag[] | null.  ctx = { g, profile, dimensions, material }. */

const RULES = [
  // R1 — DEEP HOLE (exact, from OCC hole depth:diameter). The headline new signal.
  function r_deep_hole(ctx) {
    const g = ctx.g;
    if (!g || !Array.isArray(g.holes)) return null;
    const holes = g.holes.filter((h) => h && h.kind !== 'boss' && num(h.depth_to_dia) != null);
    if (!holes.length) return null;
    const worst = holes.reduce((a, b) => (num(b.depth_to_dia) > num(a.depth_to_dia) ? b : a));
    const r = num(worst.depth_to_dia);
    if (r == null || r < 5) return null;
    const severe = r >= 8;
    return mkflag({
      rule: 'deep_hole',
      severity: severe ? 'AMBER' : 'YELLOW',
      category: 'dimensional',
      confidence: 90,
      title: `Deep hole (${r.toFixed(1)}:1 depth-to-diameter)`,
      description: `A Ø${worst.diameter_mm} mm hole is ${worst.depth_mm} mm deep (${r.toFixed(1)}:1). Holes beyond ~5:1 need peck or gun-drilling, careful chip evacuation, and hold straightness/finish harder.`,
      recommendedAction: `Confirm deep-hole drilling capability and the tolerance/finish on the Ø${worst.diameter_mm}×${worst.depth_mm} mm hole.`,
      impact: 'Deep-hole drilling · cost + lead-time',
      evidence: { diameter_mm: worst.diameter_mm, depth_mm: worst.depth_mm, depth_to_dia: r, holes_total: holes.length },
    });
  },

  // R2 — THIN WALL (approximate, from OCC sampled min wall). Conservative.
  function r_thin_wall(ctx) {
    const g = ctx.g;
    if (!g || g.min_wall_mm == null || !g.min_wall_confidence) return null; // OCC-only, must be measured
    const mw = g.min_wall_mm;
    if (mw <= 0 || mw >= 1.5) return null;
    // min wall is an approximate sampled measurement, so this stays a PURPLE
    // "verify" flag regardless of how thin — an uncertain number shouldn't drive
    // a high-severity flag. Thinner -> slightly higher confidence, still PURPLE.
    return mkflag({
      rule: 'thin_wall',
      severity: 'PURPLE',
      category: 'dimensional',
      confidence: mw < 0.8 ? 62 : 55,
      title: `Possible thin wall (~${mw.toFixed(2)} mm)`,
      description: `The estimated minimum wall is ~${mw.toFixed(2)} mm (approximate, from a sampled geometry scan). Thin walls risk distortion, chatter, and breakthrough, and can force lighter cuts or extra fixturing.`,
      recommendedAction: `Verify the minimum wall against the drawing and confirm it can be held without distortion.`,
      impact: 'Thin wall · distortion/scrap risk',
      evidence: { min_wall_mm: mw, method: 'sampled_inward_raycast', confidence: 'approximate' },
    });
  },

  // R3 — HIGH MATERIAL REMOVAL (proxy: 1 - volume/bbox_volume).
  function r_high_removal(ctx) {
    const g = ctx.g;
    if (!g || g.removal_ratio == null) return null;
    const rr = g.removal_ratio;
    if (rr < 0.7) return null;
    const pct = Math.round(rr * 100);
    return mkflag({
      rule: 'high_material_removal',
      severity: 'YELLOW',
      category: 'cost',
      confidence: 68, // proxy (AABB-based) -> <70 => PURPLE
      title: `High material removal (~${pct}% of stock)`,
      description: `Roughly ${pct}% of the bounding stock is cut away (approximate, bounding-box based). High removal means long cycle time and material/chip cost, and may favor near-net stock (casting/forging) or a different blank.`,
      recommendedAction: `Verify cycle time and whether a near-net or alternate stock form lowers cost.`,
      impact: 'High removal · cycle time + material',
      evidence: { removal_ratio: rr, bbox_mm: g.bbox_mm },
    });
  },

  // R4 — MANY SETUPS (proxy: distinct planar-face normal directions).
  function r_many_setups(ctx) {
    const g = ctx.g;
    if (!g || g.distinct_setup_normals == null) return null;
    const n = g.distinct_setup_normals;
    if (n < 5) return null;
    return mkflag({
      rule: 'many_setups',
      severity: 'YELLOW',
      category: 'cost',
      confidence: 55, // proxy -> PURPLE
      title: `Multiple setups likely (~${n} face orientations)`,
      description: `About ${n} distinct planar-face orientations were found (a proxy for setup count, not true fixture planning). Several setups mean more fixturing, more queue time, and setup-dominated cost at low quantity.`,
      recommendedAction: `Confirm the setup count and whether setup is amortized across the lot or quoted as one-time NRE.`,
      impact: 'Multiple setups · setup-dominated cost',
      evidence: { distinct_setup_normals: n },
    });
  },

  // R5 — ENVELOPE vs SHOP CAPACITY. Structured-only: fires when the profile
  // provides max_part_envelope_mm:[x,y,z]. (Free-text profiles are handled by the
  // AI's own envelope-feasibility prompt rule; this activates when profiles become
  // structured so the check is deterministic + carries evidence.)
  function r_envelope_capacity(ctx) {
    const g = ctx.g, profile = ctx.profile;
    if (!g || !Array.isArray(g.bbox_mm)) return null;
    if (g.is_assembly) return null; // assembly bbox is the whole product, not a part
    const env = profile && typeof profile === 'object'
      ? (profile.max_part_envelope_mm || profile.work_envelope_mm || profile.machine_envelope_mm)
      : null;
    if (!Array.isArray(env) || env.length < 3) return null;
    const part = [...g.bbox_mm].map(num).filter((v) => v != null).sort((a, b) => b - a);
    const cap = [...env].map(num).filter((v) => v != null).sort((a, b) => b - a);
    if (part.length < 3 || cap.length < 3) return null;
    if (!part.some((v, i) => v > cap[i])) return null;
    return mkflag({
      rule: 'envelope_exceeds_capacity',
      severity: 'RED',
      category: 'compliance',
      confidence: 85,
      title: 'Part envelope exceeds shop work envelope',
      description: `The part bounding box ${g.bbox_mm.join(' × ')} mm exceeds the shop's stated work envelope ${env.join(' × ')} mm.`,
      recommendedAction: `Verify machine travel/fixturing fit, or sub-tier — the part may not fit available machines.`,
      impact: 'Capability gap · may not fit',
      evidence: { part_mm: g.bbox_mm, envelope_mm: env },
    });
  },

  // R6 — SLENDER PART (aspect ratio; works for OCC and step-probe).
  function r_slender(ctx) {
    const g = ctx.g;
    if (!g || g.aspect_ratio == null || g.is_assembly) return null;
    const ar = g.aspect_ratio;
    if (ar >= 15) return mkflag({
      rule: 'high_aspect_ratio', severity: 'AMBER', category: 'dimensional', confidence: 78,
      title: `Very slender part (~${ar}:1)`,
      description: `Aspect ratio ~${ar}:1 — expect deflection, chatter, and special workholding; holding tolerance over the length is harder.`,
      recommendedAction: `Confirm it can be held and cut to tolerance without excessive deflection.`,
      impact: 'Slender · deflection + workholding',
      evidence: { aspect_ratio: ar, bbox_mm: g.bbox_mm },
    });
    if (ar >= 8) return mkflag({
      rule: 'elevated_aspect_ratio', severity: 'YELLOW', category: 'dimensional', confidence: 70,
      title: `Elevated aspect ratio (~${ar}:1)`,
      description: `Aspect ratio ~${ar}:1 — workholding and deflection are worth checking.`,
      recommendedAction: `Check workholding and deflection for the long axis.`,
      impact: 'Workholding · deflection',
      evidence: { aspect_ratio: ar, bbox_mm: g.bbox_mm },
    });
    return null;
  },

  // R7 — FREEFORM SURFACING (works for OCC + step-probe; honors the NURBS-ify caveat).
  function r_freeform(ctx) {
    const g = ctx.g;
    if (!g) return null;
    const share = num(g.freeform_share);
    if (share == null || share < 0.25) return null;
    const f = g.faces || {};
    const analyticCurved = (num(f.cylindrical) || 0) + (num(f.conical) || 0) + (num(f.toroidal) || 0) + (num(f.spherical) || 0);
    const suspect = analyticCurved === 0 && share >= 0.4;
    return mkflag({
      rule: 'freeform_surfacing',
      severity: suspect ? 'YELLOW' : 'AMBER',
      category: 'dimensional',
      confidence: suspect ? 50 : 72,
      title: suspect ? `Heavy B-spline surfacing (~${Math.round(share * 100)}%) — verify` : `Freeform surfacing (~${Math.round(share * 100)}%)`,
      description: suspect
        ? `~${Math.round(share * 100)}% B-spline faces with zero analytic cylinders/cones/fillets — could be genuine sculpted geometry OR a translator that NURBS-ified analytic faces. Verify against the drawing before assuming 3D-surface/5-axis work.`
        : `~${Math.round(share * 100)}% freeform surfacing — expect ball-nose surface machining (3-axis or 5-axis) and longer cycle times.`,
      recommendedAction: suspect ? `Verify true feature complexity against the drawing.` : `Confirm 5-axis/surface-machining need and cycle-time impact.`,
      impact: 'Surface machining · cycle time',
      evidence: { freeform_share: share, analytic_curved_faces: analyticCurved },
    });
  },

  // R8 — ASSEMBLY submitted.
  function r_assembly(ctx) {
    const g = ctx.g;
    if (!g || !g.is_assembly) return null;
    return mkflag({
      rule: 'assembly_submitted', severity: 'YELLOW', category: 'clarification', confidence: 88,
      title: 'CAD file is an assembly',
      description: `The model is an assembly (${g.assembly_components ?? '?'} components). The envelope is for the whole product, and per-part feature analysis mixes components.`,
      recommendedAction: `Confirm which part(s) are being quoted and request part-level files.`,
      impact: 'Scope unclear · assembly',
      evidence: { components: g.assembly_components },
    });
  },

  // R9 — UNIT / SCALE ambiguity (the scrap-the-job catch), from the geometry warnings.
  function r_unit_scale(ctx) {
    const g = ctx.g;
    if (!g) return null;
    const hit = g.warnings.find((w) => /mislabeled as inch|millimetres mislabeled|mixed length units|unit not identified|declared.*inch/i.test(String(w)));
    if (!hit && !g.units_assumed) return null;
    return mkflag({
      rule: 'unit_ambiguity', severity: 'AMBER', category: 'clarification', confidence: 85,
      title: 'Ambiguous or possibly mislabeled units',
      description: `The CAD model's units look ambiguous or mislabeled. A unit error here is a scrap-the-whole-job error.`,
      recommendedAction: `Confirm the dimensional units with the customer before quoting.`,
      impact: 'Pre-quote blocker · units',
      evidence: { native_unit: g.native_unit, units_assumed: g.units_assumed, warning: hit || null },
    });
  },
];

/* ------------------------------ public API ------------------------------ */
export function evaluateRules(input = {}) {
  const g = normGeom(input.geometry || input.stepSignals || input.occ || null);
  const ctx = {
    g,
    profile: input.profile || null,
    dimensions: Array.isArray(input.dimensions) ? input.dimensions : [],
    material: input.material || '',
  };
  const flags = [];
  for (const rule of RULES) {
    let out = null;
    try { out = rule(ctx); } catch { out = null; } // a buggy rule must never break the pass
    for (const fl of arr(out)) if (fl) flags.push(fl);
  }
  return { flags, rules_version: RULES_VERSION, fired: flags.length, evaluated: RULES.length };
}

/**
 * Merge AI flags with deterministic rule flags (both in the app schema).
 * De-dupes near-identical items, prefers the deterministic flag on a collision
 * (records merged_from), and sorts RED -> AMBER -> YELLOW -> PURPLE. Never drops a
 * distinct flag.
 */
export function mergeFlags(aiFlags = [], ruleFlags = []) {
  const out = [];
  const seen = new Map();
  const norm = (s) => lc(s).replace(/[^a-z0-9]/g, '').slice(0, 40);
  const keyOf = (fobj) => lc(fobj.category || 'x') + '|' + (lc(fobj.rule) || norm(fobj.title));

  for (const fobj of arr(aiFlags)) {
    const ff = { source: 'ai', ...fobj };
    const k = keyOf(ff);
    if (!seen.has(k)) { seen.set(k, out.length); out.push(ff); }
  }
  for (const fobj of arr(ruleFlags)) {
    const ff = { source: 'rules', ...fobj };
    const k = keyOf(ff);
    if (seen.has(k)) {
      const i = seen.get(k);
      const prior = out[i];
      out[i] = { ...ff, confidence: Math.max(num(ff.confidence) || 0, num(prior.confidence) || 0), merged_from: [prior.source || 'ai', 'rules'] };
    } else {
      seen.set(k, out.length); out.push(ff);
    }
  }
  const order = { RED: 0, AMBER: 1, YELLOW: 2, PURPLE: 3 };
  out.sort((a, b) => (order[(a.severity || 'PURPLE')] ?? 9) - (order[(b.severity || 'PURPLE')] ?? 9));
  return out;
}

export default { evaluateRules, mergeFlags, RULES_VERSION };
