/**
 * QuoteScout — lib/rules.js
 * Deterministic machining-risk rules engine (v1). Roadmap item #3 — "the core move."
 *
 * WHAT IT IS: a pure function that takes the deterministic STEP signals
 * (from step-probe.js), the AI-extracted dimensions[], the shop profile
 * (qs_profile), and a resolved material entry (from materials.js), and returns
 * auditable risk flags. Every flag carries source:'rules' and an `evidence`
 * object with the exact computed values, so an estimator sees *why* it fired.
 *
 * DESIGN RULES (non-negotiable):
 *   - NEVER throw. Any missing/oddly-shaped input -> the rule simply doesn't fire.
 *   - NEVER fabricate a measurement we can't compute. v1 has no topology, so we
 *     do NOT invent min-wall or hole-depth numbers; rules that need a value only
 *     fire when that value is actually present in dimensions[] (and we tag the
 *     lower confidence of AI/OCR-derived numbers).
 *   - Honor step-probe caveats: assembly envelopes are unreliable; a high
 *     freeform share with zero analytic curved faces may be a translator artifact.
 *
 * USED BY: job-status.js (run as a post-pass, then mergeFlags with the AI flags).
 *   import { evaluateRules, mergeFlags, RULES_VERSION } from './rules.js'
 *
 * dimensions[] shape is read DEFENSIVELY (the AI schema may vary): each item may
 * have value/nominal, unit, tol/tolerance/plusMinus, type/kind/feature, label/name.
 */

import { lookupMaterial } from './materials.js';

export const RULES_VERSION = '1.0.0';

/* ----------------------------- small helpers ----------------------------- */

const sev = { RED: 'RED', AMBER: 'AMBER', YELLOW: 'YELLOW', PURPLE: 'PURPLE' };
const HARD = { none: 0, low: 1, moderate: 2, high: 3, severe: 4 };

function num(x) { const n = typeof x === 'number' ? x : parseFloat(x); return Number.isFinite(n) ? n : null; }
function lc(x) { return String(x == null ? '' : x).toLowerCase(); }
function arr(x) { return Array.isArray(x) ? x : (x == null ? [] : [x]); }

/** Pull a tolerance magnitude (± value) out of a dimension item, in its own unit. */
function tolMag(d) {
  const t = d && (d.tol ?? d.tolerance ?? d.plusMinus ?? d.plus_minus ?? d.pm);
  if (t == null) return null;
  if (typeof t === 'number') return Math.abs(t);
  // strings like "+/-0.001", "±0.0005", "0.001"
  const m = String(t).match(/[-+]?\d*\.?\d+/);
  return m ? Math.abs(parseFloat(m[0])) : null;
}
/** Best-guess unit for a dimension ('in' | 'mm' | null). */
function dimUnit(d, fallback) {
  const u = lc(d && (d.unit ?? d.units));
  if (u.includes('mm') || u.includes('milli')) return 'mm';
  if (u.includes('in') || u === '"' || u.includes('inch')) return 'in';
  return fallback || null;
}
function toMM(v, unit) { return unit === 'in' ? v * 25.4 : v; } // assume mm if unknown

function flag(o) {
  return {
    source: 'rules',
    confidence: 0.9,
    category: 'geometry',
    ...o,
  };
}

/* --------------------------------- rules --------------------------------- */
/* Each rule is (ctx) => flag | flag[] | null.  ctx is assembled in evaluateRules. */

const RULES = [
  // R1 — material explicitly excluded by the shop profile
  function r_material_excluded(ctx) {
    const { material, profile, rawMaterialStr } = ctx;
    const exclusions = arr(profile && (profile.material_exclusions ?? profile.materialExclusions));
    if (!exclusions.length) return null;
    const hay = lc(rawMaterialStr);
    const famName = material ? lc(material.family) + ' ' + lc(material.name) : '';
    for (const ex of exclusions) {
      const e = lc(ex);
      if (!e) continue;
      if ((hay && hay.includes(e)) || (famName && famName.includes(e)) ||
          (material && lookupMaterial(ex) && lookupMaterial(ex).key === material.key)) {
        return flag({
          rule: 'material_excluded', severity: sev.RED, category: 'capability', confidence: 0.95,
          message: `Material appears to be on the shop's exclusion list ("${ex}") — likely a no-bid or requires an outside partner.`,
          evidence: { material: material ? material.name : rawMaterialStr, exclusion: ex },
        });
      }
    }
    return null;
  },

  // R2 — part envelope exceeds a configured machine work-envelope (single parts only)
  function r_envelope_capacity(ctx) {
    const { signals, profile } = ctx;
    const b = signals && signals.bbox;
    if (!b || b.reliable === false || !Array.isArray(b.size_mm)) return null; // skip assemblies / no bbox
    // profile may store an envelope; probe a few plausible field names (mm)
    const env = profile && (profile.max_part_envelope_mm ?? profile.work_envelope_mm ?? profile.machine_envelope_mm);
    if (!Array.isArray(env) || env.length < 3) return null;
    const part = [...b.size_mm].sort((a, z) => z - a);
    const cap = [...env].map(num).filter((v) => v != null).sort((a, z) => z - a);
    if (cap.length < 3) return null;
    const over = part.some((v, i) => v > cap[i]);
    if (!over) return null;
    return flag({
      rule: 'envelope_exceeds_capacity', severity: sev.RED, category: 'capability', confidence: 0.8,
      message: `Approximate part envelope ${b.size_mm.join(' × ')} mm may exceed the shop's stated work envelope ${env.join(' × ')} mm — verify fit/fixturing before quoting.`,
      evidence: { part_mm: b.size_mm, envelope_mm: env, method: b.method },
    });
  },

  // R3 — slender part: deflection / fixturing risk (from bbox aspect ratio, single parts)
  function r_aspect_ratio(ctx) {
    const { signals } = ctx;
    const b = signals && signals.bbox;
    const ar = signals && num(signals.aspect_ratio);
    if (!b || b.reliable === false || ar == null) return null;
    if (ar >= 15) return flag({
      rule: 'high_aspect_ratio', severity: sev.AMBER, category: 'geometry', confidence: 0.75,
      message: `Very slender part (aspect ratio ~${ar}:1) — expect deflection, chatter, and special workholding; confirm it can be held and cut to tolerance.`,
      evidence: { aspect_ratio: ar, size_mm: b.size_mm },
    });
    if (ar >= 8) return flag({
      rule: 'elevated_aspect_ratio', severity: sev.YELLOW, category: 'geometry', confidence: 0.7,
      message: `Elevated aspect ratio (~${ar}:1) — workholding and deflection worth a look.`,
      evidence: { aspect_ratio: ar, size_mm: b.size_mm },
    });
    return null;
  },

  // R4 — freeform/sculpted surfacing => surface machining / possible 5-axis
  function r_freeform(ctx) {
    const { signals } = ctx;
    if (!signals) return null;
    const share = num(signals.freeform_share);
    if (share == null || share < 0.25) return null;
    const f = signals.faces || {};
    const analyticCurved = (num(f.cylindrical) || 0) + (num(f.conical) || 0) + (num(f.toroidal) || 0) + (num(f.spherical) || 0);
    // translator-artifact guard: lots of B-splines but zero analytic curves -> low confidence
    const suspectArtifact = analyticCurved === 0 && share >= 0.4;
    return flag({
      rule: 'freeform_surfacing',
      severity: suspectArtifact ? sev.YELLOW : sev.AMBER,
      category: 'geometry',
      confidence: suspectArtifact ? 0.5 : 0.75,
      message: suspectArtifact
        ? `~${Math.round(share * 100)}% B-spline faces with zero analytic cylinders/cones/fillets — could be genuine sculpted surfacing OR a translator that NURBS-ified analytic faces. Verify against the drawing before assuming 3D-surface/5-axis work.`
        : `~${Math.round(share * 100)}% freeform surfacing — expect ball-nose surface machining and longer cycle times; confirm 5-axis need.`,
      evidence: { freeform_share: share, analytic_curved_faces: analyticCurved },
    });
  },

  // R5 — freeform surfacing but the shop's equipment list shows no 5-axis
  function r_freeform_vs_equipment(ctx) {
    const { signals, profile } = ctx;
    if (!signals || (num(signals.freeform_share) || 0) < 0.3) return null;
    const equip = lc(arr(profile && (profile.equipment ?? profile.machines)).join(' ') || (profile && profile.equipment) || '');
    if (!equip) return null;
    const has5 = /5[\s-]?axis|five[\s-]?axis/.test(equip);
    if (has5) return null;
    return flag({
      rule: 'capability_gap_5axis', severity: sev.AMBER, category: 'capability', confidence: 0.6,
      message: `Part shows significant freeform surfacing but the shop profile lists no 5-axis capability — confirm this can be done on available machines or routed out.`,
      evidence: { freeform_share: num(signals.freeform_share), equipment_seen: equip.slice(0, 120) },
    });
  },

  // R6 — material work-hardens: machining-strategy heads-up
  function r_work_hardening(ctx) {
    const { material } = ctx;
    if (!material || (HARD[material.work_hardening] || 0) < 3) return null; // high/severe only
    const severe = material.work_hardening === 'severe';
    return flag({
      rule: 'work_hardening_material',
      severity: severe ? sev.AMBER : sev.YELLOW,
      category: 'material', confidence: 0.85,
      message: `${material.name} work-hardens (${material.work_hardening}); plan for sharp tooling, consistent feed, and no dwelling. ${severe ? 'Expect elevated tool wear and cycle time.' : ''}`.trim(),
      evidence: { material: material.name, work_hardening: material.work_hardening, machinability_index: material.machinability_index },
    });
  },

  // R7 — abrasive / high-tooling-demand material
  function r_tooling_demand(ctx) {
    const { material } = ctx;
    if (!material || (HARD[material.tooling_demand] || 0) < 4) return null; // severe only
    return flag({
      rule: 'severe_tooling_demand', severity: sev.AMBER, category: 'material', confidence: 0.8,
      message: `${material.name} is very demanding on tooling (abrasive/hard) — factor tool wear and possible grinding/EDM finishing into cost and lead time.`,
      evidence: { material: material.name, tooling_demand: material.tooling_demand },
    });
  },

  // R8 — surcharge-sensitive material: price-volatility (commercial) flag
  function r_surcharge(ctx) {
    const { material } = ctx;
    if (!material || (HARD[material.surcharge_sensitivity] || 0) < 3) return null; // high/severe
    return flag({
      rule: 'material_surcharge_risk', severity: sev.PURPLE, category: 'commercial', confidence: 0.8,
      message: `${material.name} carries volatile alloy/metal surcharges — re-check the current surcharge with your supplier before locking the price${(HARD[material.surcharge_sensitivity] === 4) ? ' (this one moves a lot)' : ''}.`,
      evidence: { material: material.name, surcharge_sensitivity: material.surcharge_sensitivity, cost_class: material.cost_class },
    });
  },

  // R9 — tight tolerance present (from dimensions[]) — precision/inspection flag
  function r_tight_tolerance(ctx) {
    const { dimensions, signals } = ctx;
    if (!Array.isArray(dimensions) || !dimensions.length) return null;
    const fileUnit = signals && signals.units === 'inch' ? 'in' : (signals && signals.units === 'mm' ? 'mm' : null);
    let tightest = null;
    for (const d of dimensions) {
      const t = tolMag(d);
      if (t == null || t <= 0) continue;
      const u = dimUnit(d, fileUnit);
      const tmm = toMM(t, u);
      if (tightest == null || tmm < tightest.tmm) tightest = { tmm, t, u: u || 'mm?', d };
    }
    if (!tightest) return null;
    // thresholds expressed as inch-equivalents (+ tiny margin so the exact
    // float conversion of ±0.0005"/±0.001" lands on the right side):
    //   <= ~±0.0005" (0.0127 mm) => precision ;  <= ~±0.001" (0.0254 mm) => tight
    const PRECISION_MM = 0.0128, TIGHT_MM = 0.0255;
    if (tightest.tmm <= PRECISION_MM) return flag({
      rule: 'precision_tolerance', severity: sev.AMBER, category: 'tolerance', confidence: 0.65,
      message: `A tolerance as tight as ±${tightest.t}${tightest.u} (~±${(tightest.tmm / 25.4).toFixed(4)}") is called out — confirm process capability, CMM/inspection plan, and whether grinding/lapping is implied.`,
      evidence: { tightest_tol: tightest.t, unit: tightest.u, approx_mm: +tightest.tmm.toFixed(4), label: tightest.d.label ?? tightest.d.name ?? null },
    });
    if (tightest.tmm <= TIGHT_MM) return flag({
      rule: 'tight_tolerance', severity: sev.YELLOW, category: 'tolerance', confidence: 0.6,
      message: `Tight tolerance ±${tightest.t}${tightest.u} present — verify it's achievable and inspected.`,
      evidence: { tightest_tol: tightest.t, unit: tightest.u, approx_mm: +tightest.tmm.toFixed(4) },
    });
    return null;
  },

  // R10 — tight tolerance AND difficult material (interaction is worse than either alone)
  function r_tol_material_interaction(ctx) {
    const { dimensions, material, signals } = ctx;
    if (!material || !Array.isArray(dimensions) || !dimensions.length) return null;
    const hard = (HARD[material.work_hardening] || 0) >= 3 || (HARD[material.tooling_demand] || 0) >= 3 || (material.machinability_index || 100) <= 35;
    if (!hard) return null;
    const fileUnit = signals && signals.units === 'inch' ? 'in' : 'mm';
    const anyTight = dimensions.some((d) => { const t = tolMag(d); return t != null && toMM(t, dimUnit(d, fileUnit)) <= 0.025; });
    if (!anyTight) return null;
    return flag({
      rule: 'tight_tol_difficult_material', severity: sev.AMBER, category: 'tolerance', confidence: 0.6,
      message: `Tight tolerance on ${material.name} (a difficult-to-machine material) — holding size is harder here; budget for slower cutting, tool-wear compensation, and possibly secondary grinding.`,
      evidence: { material: material.name, machinability_index: material.machinability_index },
    });
  },

  // R11 — assembly submitted: clarify what's being quoted
  function r_assembly(ctx) {
    const { signals } = ctx;
    if (!signals || !signals.is_assembly) return null;
    return flag({
      rule: 'assembly_submitted', severity: sev.YELLOW, category: 'data_quality', confidence: 0.9,
      message: `The STEP file is an assembly (${signals.assembly_components ?? '?'} component instances) — confirm which part(s) are being quoted; the overall envelope from an assembly file is unreliable.`,
      evidence: { assembly_components: signals.assembly_components ?? null },
    });
  },

  // R12 — unit ambiguity / scale-bug surfaced by step-probe -> confirm units
  function r_unit_ambiguity(ctx) {
    const { signals } = ctx;
    const warns = arr(signals && signals.warnings);
    const hit = warns.find((w) => /declared.*inch/i.test(w) || /mixed length units/i.test(w) || /unit not identified/i.test(w));
    if (!hit && !(signals && signals.units_assumed)) return null;
    return flag({
      rule: 'unit_ambiguity', severity: sev.AMBER, category: 'data_quality', confidence: 0.85,
      message: `Units in the CAD model are ambiguous or possibly mislabeled — confirm the dimensional units with the customer before quoting (a unit error here is a scrap-the-job error).`,
      evidence: { units: signals && signals.units, units_assumed: !!(signals && signals.units_assumed), warning: hit || null },
    });
  },

  // R13 — required certification not held by the shop (from an optional requirements field)
  function r_certification(ctx) {
    const { requirements, profile } = ctx;
    const reqStr = lc(arr(requirements).join(' ') || requirements || '');
    if (!reqStr) return null;
    const held = lc(arr(profile && (profile.certs_held ?? profile.certifications)).join(' ') || (profile && profile.certs_held) || '');
    const certs = [
      ['as9100', 'AS9100'], ['nadcap', 'NADCAP'], ['iso 13485', 'ISO 13485'], ['iso13485', 'ISO 13485'],
      ['itar', 'ITAR'], ['ppap', 'PPAP'], ['iatf', 'IATF 16949'], ['ds9100', 'AS9100'],
    ];
    for (const [needle, label] of certs) {
      if (reqStr.includes(needle) && !held.includes(needle) && !held.includes(label.toLowerCase())) {
        return flag({
          rule: 'certification_gap', severity: sev.RED, category: 'certification', confidence: 0.7,
          message: `RFQ appears to require ${label}, which isn't listed in the shop's certifications — confirm before bidding; this can be a hard no-bid.`,
          evidence: { required: label, certs_held: held ? held.slice(0, 120) : '(none on profile)' },
        });
      }
    }
    return null;
  },
];

/* ------------------------------- public API ------------------------------- */

/**
 * Run all rules. Inputs are all optional; rules fire only when their inputs exist.
 * @param {object} input
 * @param {object} [input.stepSignals]  // object returned by extractStepSignals()
 * @param {Array}  [input.dimensions]   // AI-extracted dimensions[]
 * @param {object} [input.profile]      // qs_profile
 * @param {string} [input.material]     // freeform material string (AI/OCR/form)
 * @param {Array|string} [input.requirements] // optional surfaced requirements/cert text
 * @returns {{flags: Array, rules_version: string, fired: number, evaluated: number}}
 */
export function evaluateRules(input = {}) {
  const signals = input.stepSignals || input.signals || null;
  const rawMaterialStr = input.material || input.materialName || '';
  const material = rawMaterialStr ? lookupMaterial(rawMaterialStr) : null;
  const ctx = {
    signals,
    dimensions: Array.isArray(input.dimensions) ? input.dimensions : [],
    profile: input.profile || {},
    requirements: input.requirements || '',
    rawMaterialStr,
    material,
  };

  const flags = [];
  for (const rule of RULES) {
    let out = null;
    try { out = rule(ctx); } catch { out = null; } // a buggy rule must never break the pass
    if (!out) continue;
    for (const f of arr(out)) if (f) flags.push(f);
  }
  return { flags, rules_version: RULES_VERSION, fired: flags.length, evaluated: RULES.length };
}

/**
 * Merge AI flags with rule flags, de-duplicating near-identical items.
 * Keeps everything informative; on a collision prefers the deterministic
 * rule flag but records that the AI agreed (merged_from).
 */
export function mergeFlags(aiFlags = [], ruleFlags = []) {
  const out = [];
  const seen = new Map(); // key -> index in out

  const keyOf = (f) =>
    (lc(f.category) || 'x') + '|' +
    (lc(f.rule) || lc(f.message).replace(/[^a-z0-9]/g, '').slice(0, 40));

  for (const f of arr(aiFlags)) {
    const ff = { source: 'ai', confidence: 0.7, category: 'geometry', ...f };
    const k = keyOf(ff);
    if (!seen.has(k)) { seen.set(k, out.length); out.push(ff); }
  }
  for (const f of arr(ruleFlags)) {
    const ff = { source: 'rules', ...f };
    const k = keyOf(ff);
    if (seen.has(k)) {
      const i = seen.get(k);
      const prior = out[i];
      // deterministic wins; note the agreement and keep the higher confidence
      out[i] = { ...ff, confidence: Math.max(num(ff.confidence) || 0, num(prior.confidence) || 0), merged_from: [prior.source, 'rules'] };
    } else {
      seen.set(k, out.length); out.push(ff);
    }
  }

  const order = { RED: 0, AMBER: 1, YELLOW: 2, PURPLE: 3 };
  out.sort((a, z) => (order[a.severity] ?? 9) - (order[z.severity] ?? 9));
  return out;
}

export default { evaluateRules, mergeFlags, RULES_VERSION };
