/**
 * QuoteScout — lib/materials.js
 * Static material reference table + fuzzy lookup. Roadmap item #2 ("KB as code").
 *
 * WHY A JS FILE: given the GitHub-web-UI deploy flow, a version-controlled JS
 * module IS the database. No Supabase round-trip, no API key, deploys like any
 * other file. Per-shop overrides can move to Supabase later.
 *
 * HONESTY: machinability_index is an APPROXIMATE relative figure on the common
 * AISI free-machining scale (B1112 / AISI 1212 steel = 100). Real cutting rates
 * depend on grade, condition, tooling, and the shop. These values are for
 * *relative* risk reasoning (is this material easy/hard, does it work-harden,
 * is it surcharge-volatile) — NOT for cycle-time or cost quoting. cost_class is
 * a 1 (cheap) – 5 (expensive) relative band, not a price.
 *
 * CONSUMED BY: lib/rules.js (material-aware flags) and analyze.js (prompt enrich).
 *   import { lookupMaterial, MATERIALS_VERSION } from './materials.js'
 */

export const MATERIALS_VERSION = '1.0.0';

/* work_hardening / tooling_demand / surcharge_sensitivity scale:
   'none' < 'low' < 'moderate' < 'high' < 'severe'                                */

const MATERIALS = [
  // ---- aluminum ----
  { key: 'al-6061', name: '6061-T6 Aluminum', family: 'aluminum',
    machinability_index: 190, work_hardening: 'low', tooling_demand: 'low',
    surcharge_sensitivity: 'low', cost_class: 2,
    risks: ['gummy if not lubricated', 'thin sections can distort from residual stress'],
    notes: 'Workhorse alloy; machines very freely.' },
  { key: 'al-7075', name: '7075-T6 Aluminum', family: 'aluminum',
    machinability_index: 120, work_hardening: 'low', tooling_demand: 'low',
    surcharge_sensitivity: 'low', cost_class: 3,
    risks: ['more expensive than 6061', 'stress-corrosion sensitive in some tempers'],
    notes: 'High-strength aerospace alloy.' },
  { key: 'al-2024', name: '2024 Aluminum', family: 'aluminum',
    machinability_index: 110, work_hardening: 'low', tooling_demand: 'low',
    surcharge_sensitivity: 'low', cost_class: 3,
    risks: ['corrosion sensitive bare'], notes: 'Aerospace alloy.' },

  // ---- carbon / alloy steel ----
  { key: 'steel-12l14', name: '12L14 Free-Machining Steel', family: 'steel_carbon',
    machinability_index: 170, work_hardening: 'low', tooling_demand: 'low',
    surcharge_sensitivity: 'low', cost_class: 1,
    risks: ['leaded — confirm RoHS/lead-free requirements'], notes: 'Best-machining steel.' },
  { key: 'steel-1018', name: '1018 Mild Steel', family: 'steel_carbon',
    machinability_index: 78, work_hardening: 'low', tooling_demand: 'low',
    surcharge_sensitivity: 'low', cost_class: 1,
    risks: ['can be gummy / built-up edge at low SFM'], notes: 'Common low-carbon steel.' },
  { key: 'steel-1045', name: '1045 Medium-Carbon Steel', family: 'steel_carbon',
    machinability_index: 57, work_hardening: 'low', tooling_demand: 'moderate',
    surcharge_sensitivity: 'low', cost_class: 1, risks: [], notes: 'Shafting / medium strength.' },
  { key: 'steel-4140', name: '4140 Alloy Steel', family: 'steel_alloy',
    machinability_index: 66, work_hardening: 'low', tooling_demand: 'moderate',
    surcharge_sensitivity: 'low', cost_class: 2,
    risks: ['abrasive and lower machinability when heat-treated (Q&T)', 'distortion risk if machined then hardened'],
    notes: 'Machinability assumes annealed; harder conditions are tougher on tooling.' },
  { key: 'steel-4340', name: '4340 Alloy Steel', family: 'steel_alloy',
    machinability_index: 50, work_hardening: 'low', tooling_demand: 'high',
    surcharge_sensitivity: 'low', cost_class: 2,
    risks: ['tough, demanding on tooling', 'distortion on heat treat'], notes: 'High-strength alloy steel.' },

  // ---- tool steel ----
  { key: 'tool-a2', name: 'A2 Tool Steel', family: 'steel_tool',
    machinability_index: 35, work_hardening: 'low', tooling_demand: 'high',
    surcharge_sensitivity: 'low', cost_class: 3,
    risks: ['abrasive', 'grind/EDM often needed after hardening', 'distortion on heat treat'],
    notes: 'Machinability assumes annealed.' },
  { key: 'tool-d2', name: 'D2 Tool Steel', family: 'steel_tool',
    machinability_index: 27, work_hardening: 'low', tooling_demand: 'severe',
    surcharge_sensitivity: 'low', cost_class: 3,
    risks: ['high carbide content — very abrasive', 'usually finished by grinding/EDM'],
    notes: 'High-chromium cold-work tool steel.' },

  // ---- stainless ----
  { key: 'ss-304', name: '304 Stainless (Austenitic)', family: 'stainless_austenitic',
    machinability_index: 45, work_hardening: 'high', tooling_demand: 'moderate',
    surcharge_sensitivity: 'high', cost_class: 3,
    risks: ['work-hardens fast — must keep feeding, avoid dwelling', 'nickel surcharge moves the price'],
    notes: 'Confirm 304 vs 304L and current alloy surcharge.' },
  { key: 'ss-316', name: '316 Stainless (Austenitic)', family: 'stainless_austenitic',
    machinability_index: 36, work_hardening: 'high', tooling_demand: 'high',
    surcharge_sensitivity: 'high', cost_class: 3,
    risks: ['work-hardens worse than 304', 'molybdenum + nickel make surcharge volatile'],
    notes: 'Marine/medical grade.' },
  { key: 'ss-416', name: '416 Stainless (Free-Machining Martensitic)', family: 'stainless_martensitic',
    machinability_index: 85, work_hardening: 'low', tooling_demand: 'low',
    surcharge_sensitivity: 'moderate', cost_class: 3,
    risks: ['sulfur lowers corrosion resistance vs 304/316'], notes: 'The easy-machining stainless.' },
  { key: 'ss-174ph', name: '17-4 PH Stainless', family: 'stainless_ph',
    machinability_index: 48, work_hardening: 'moderate', tooling_demand: 'high',
    surcharge_sensitivity: 'high', cost_class: 4,
    risks: ['condition matters (H900 vs solution-annealed)', 'work-hardens', 'surcharge-sensitive'],
    notes: 'Precipitation-hardening; confirm required condition.' },

  // ---- cast iron ----
  { key: 'iron-grey', name: 'Grey Cast Iron', family: 'cast_iron',
    machinability_index: 80, work_hardening: 'none', tooling_demand: 'moderate',
    surcharge_sensitivity: 'low', cost_class: 2,
    risks: ['abrasive graphite dust', 'dry-machined — housekeeping/health controls'],
    notes: 'Machines easily but abrasive.' },

  // ---- titanium / superalloy ----
  { key: 'ti-6al4v', name: 'Ti-6Al-4V Titanium', family: 'titanium',
    machinability_index: 22, work_hardening: 'high', tooling_demand: 'severe',
    surcharge_sensitivity: 'high', cost_class: 5,
    risks: ['low thermal conductivity — heat stays at the cutting edge', 'work-hardens', 'fine-chip fire risk', 'expensive, surcharge-volatile'],
    notes: 'Needs rigid setups, flood coolant, sharp tools, conservative speeds.' },
  { key: 'inconel-718', name: 'Inconel 718 (Nickel Superalloy)', family: 'nickel_superalloy',
    machinability_index: 12, work_hardening: 'severe', tooling_demand: 'severe',
    surcharge_sensitivity: 'severe', cost_class: 5,
    risks: ['severe work-hardening — never dwell', 'very abrasive, eats tooling', 'highest surcharge volatility', 'long cycle times'],
    notes: 'One of the hardest common materials to machine; price moves a lot.' },

  // ---- copper / brass ----
  { key: 'brass-c360', name: 'C360 Free-Cutting Brass', family: 'brass',
    machinability_index: 100, work_hardening: 'low', tooling_demand: 'low',
    surcharge_sensitivity: 'moderate', cost_class: 3,
    risks: ['copper price moves the cost', 'leaded — confirm lead-free requirement'],
    notes: 'Excellent machinability; reference for the brass scale.' },
  { key: 'copper-c101', name: 'C101 Copper (OFE)', family: 'copper',
    machinability_index: 20, work_hardening: 'moderate', tooling_demand: 'moderate',
    surcharge_sensitivity: 'high', cost_class: 3,
    risks: ['gummy despite being soft — built-up edge, poor finish', 'copper price volatile'],
    notes: 'Soft but machines poorly; sharp tools + good chip control needed.' },

  // ---- plastics (machinability_index less meaningful; flagged) ----
  { key: 'plastic-delrin', name: 'Delrin / Acetal (POM)', family: 'plastic', is_plastic: true,
    machinability_index: 200, work_hardening: 'none', tooling_demand: 'low',
    surcharge_sensitivity: 'low', cost_class: 2,
    risks: ['low melting point — can melt/smear at high speed', 'high thermal expansion affects tolerances'],
    notes: 'Machines beautifully; watch heat and CTE for tight tolerances.' },
  { key: 'plastic-peek', name: 'PEEK', family: 'plastic', is_plastic: true,
    machinability_index: 90, work_hardening: 'none', tooling_demand: 'moderate',
    surcharge_sensitivity: 'low', cost_class: 5,
    risks: ['very expensive', 'glass/carbon-filled grades are abrasive on tooling'],
    notes: 'High-performance polymer; confirm filled vs unfilled.' },
  { key: 'plastic-nylon', name: 'Nylon (PA)', family: 'plastic', is_plastic: true,
    machinability_index: 110, work_hardening: 'none', tooling_demand: 'low',
    surcharge_sensitivity: 'low', cost_class: 2,
    risks: ['gummy / stringy chips', 'absorbs moisture — dimensions move with humidity'],
    notes: 'Tolerance stability is the main concern.' },
];

/* alias → key. Lowercased, alphanumerics only (see normalize()).               */
const ALIASES = {
  // aluminum
  '6061': 'al-6061', '6061t6': 'al-6061', 'al6061': 'al-6061', 'aluminum6061': 'al-6061', 'alum6061': 'al-6061',
  '7075': 'al-7075', '7075t6': 'al-7075', 'al7075': 'al-7075',
  '2024': 'al-2024', 'al2024': 'al-2024',
  'aluminum': 'al-6061', 'aluminium': 'al-6061', 'al': 'al-6061',
  // steel
  '12l14': 'steel-12l14', '1215': 'steel-12l14',
  '1018': 'steel-1018', 'a36': 'steel-1018', 'mildsteel': 'steel-1018', 'lowcarbonsteel': 'steel-1018',
  '1045': 'steel-1045',
  '4140': 'steel-4140', '4140ht': 'steel-4140', '4140pht': 'steel-4140', 'aisi4140': 'steel-4140',
  '4340': 'steel-4340',
  'a2': 'tool-a2', 'a2toolsteel': 'tool-a2',
  'd2': 'tool-d2', 'd2toolsteel': 'tool-d2',
  // stainless
  '304': 'ss-304', '304l': 'ss-304', '304ss': 'ss-304', 'ss304': 'ss-304', 'stainless304': 'ss-304', '18-8': 'ss-304', '188': 'ss-304',
  '316': 'ss-316', '316l': 'ss-316', '316ss': 'ss-316', 'ss316': 'ss-316', 'stainless316': 'ss-316',
  '416': 'ss-416', '416ss': 'ss-416',
  '174ph': 'ss-174ph', '17-4': 'ss-174ph', '174': 'ss-174ph', '17-4ph': 'ss-174ph', '155ph': 'ss-174ph',
  'stainless': 'ss-304', 'stainlesssteel': 'ss-304', 'ss': 'ss-304', 'cres': 'ss-304',
  // cast iron
  'greycastiron': 'iron-grey', 'graycastiron': 'iron-grey', 'castiron': 'iron-grey', 'g25': 'iron-grey',
  // titanium / superalloy
  'ti6al4v': 'ti-6al4v', 'ti64': 'ti-6al4v', 'grade5titanium': 'ti-6al4v', 'titanium': 'ti-6al4v', 'ti': 'ti-6al4v',
  'inconel718': 'inconel-718', 'in718': 'inconel-718', 'inconel': 'inconel-718', 'nickelalloy': 'inconel-718', 'superalloy': 'inconel-718',
  // copper / brass
  'c360': 'brass-c360', 'brass': 'brass-c360', 'freecuttingbrass': 'brass-c360', '360brass': 'brass-c360',
  'c101': 'copper-c101', 'copper': 'copper-c101', 'ofecopper': 'copper-c101', 'c110': 'copper-c101',
  // plastics
  'delrin': 'plastic-delrin', 'acetal': 'plastic-delrin', 'pom': 'plastic-delrin',
  'peek': 'plastic-peek',
  'nylon': 'plastic-nylon', 'pa6': 'plastic-nylon', 'pa66': 'plastic-nylon', 'polyamide': 'plastic-nylon',
};

const BY_KEY = new Map(MATERIALS.map((m) => [m.key, m]));

/** lowercase, strip everything but [a-z0-9]; keeps "304-L" ~ "304l" etc. */
function normalize(s) {
  return String(s || '').toLowerCase().replace(/[^a-z0-9]/g, '');
}

/**
 * Resolve a freeform material string (from AI extraction, OCR, or a form field)
 * to a reference entry. Returns null if nothing plausible matches.
 *
 * Strategy: exact alias on the normalized string, then alias-token containment
 * (e.g. "316L stainless steel bar" -> token "316l" -> ss-316), then family
 * keyword fallback. Conservative — prefers null over a wrong guess.
 */
export function lookupMaterial(query) {
  if (!query) return null;
  const norm = normalize(query);
  if (!norm) return null;

  // 1) whole-string alias / key
  if (ALIASES[norm]) return BY_KEY.get(ALIASES[norm]) || null;
  if (BY_KEY.has(norm)) return BY_KEY.get(norm);

  // 2) alias token contained in the string. A specific grade designator (one
  //    containing a digit, e.g. "316l", "4140", "c360") must beat a generic
  //    family word (e.g. "stainlesssteel") even if the family word is longer —
  //    otherwise "316L stainless steel" resolves to plain 304. Among same-class
  //    aliases, prefer the longest. Require length >= 3 so "al" can't match
  //    inside an unrelated word.
  let best = null, bestScore = -1;
  for (const alias of Object.keys(ALIASES)) {
    if (alias.length < 3 || !norm.includes(alias)) continue;
    const hasDigit = /\d/.test(alias);
    const score = (hasDigit ? 1000 : 0) + alias.length; // grade designators dominate
    if (score > bestScore) { best = ALIASES[alias]; bestScore = score; }
  }
  if (best) return BY_KEY.get(best) || null;

  // 3) family keyword fallback (loose, last resort)
  const fam = [
    ['inconel', 'inconel-718'], ['titanium', 'ti-6al4v'], ['stainless', 'ss-304'],
    ['toolsteel', 'tool-a2'], ['castiron', 'iron-grey'], ['brass', 'brass-c360'],
    ['copper', 'copper-c101'], ['aluminum', 'al-6061'], ['aluminium', 'al-6061'],
    ['delrin', 'plastic-delrin'], ['acetal', 'plastic-delrin'], ['peek', 'plastic-peek'], ['nylon', 'plastic-nylon'],
    ['steel', 'steel-1018'],
  ];
  for (const [kw, key] of fam) if (norm.includes(kw)) return BY_KEY.get(key);

  return null;
}

/** All entries (e.g. for building a prompt glossary or admin view). */
export function allMaterials() {
  return MATERIALS.slice();
}

export default { lookupMaterial, allMaterials, MATERIALS_VERSION };
