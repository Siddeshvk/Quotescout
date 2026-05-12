// =====================================================================
// QuoteScout — /api/analyze
// =====================================================================
// This is the heart of the product. It receives a PDF upload, sends it
// directly to Claude (which does its own OCR/vision processing), logs
// metadata to Supabase, and returns a structured risk report.
//
// File flow:
//   1. PDF arrives via multipart/form-data
//   2. Best-effort text extraction (pdf-parse) for ITAR pre-screening + page count
//      — if extraction fails (scanned/image-only PDF), we proceed anyway
//   3. ITAR keyword check on any extracted text — block defense work early
//   4. PDF sent as base64 document directly to Claude API (handles text + scans + drawings)
//   5. System prompt also instructs Claude to bail on ITAR markers it sees in vision
//   6. Response parsed as JSON
//   7. Metadata logged to Supabase (NOT the file content)
//   8. PDF buffer cleared from memory
//   9. Response returned to user
//
// What we store in Supabase: email, filename, file size, page count,
// flag counts, AI model, processing time, deletion timestamp.
// What we do NOT store: the PDF, extracted text, the AI's full output.
// =====================================================================

import Anthropic from '@anthropic-ai/sdk';
import { createClient } from '@supabase/supabase-js';
import formidable from 'formidable';
import fs from 'fs';
import pdf from 'pdf-parse';
import { Resend } from 'resend';

// Vercel needs this — disable default body parsing for file uploads
export const config = {
  api: {
    bodyParser: false,
    sizeLimit: '50mb',
  },
};

// Initialize clients
const anthropic = new Anthropic({
  apiKey: process.env.ANTHROPIC_API_KEY,
});

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_ANON_KEY
);

// ===== MODEL SELECTION =====
// To switch from Haiku (cheaper) to Sonnet (smarter) when you have
// paying customers: change this single line.
const MODEL = 'claude-sonnet-4-6';
// Alternatives (one-line swap):
//   'claude-haiku-4-5-20251001'  → ~5x cheaper, much weaker instruction-following. NOT recommended for V1.
//   'claude-opus-4-7'            → smartest model. Use only when an analysis matters enormously and cost is irrelevant.

// ===== EXPORT-CONTROL DETECTION (see findITARMarkers below) =====
// The old substring-match keyword filter was replaced with a precise
// regex-pattern matcher that requires qualifying context and supports
// exclusion patterns ("non-ITAR", "ITAR-free", etc.) to eliminate false
// positives like a part number "ITARGETT-205" or the word "year".

// ===== MULTI-FORMAT FILE CLASSIFICATION + EXTRACTION =====
// QuoteScout accepts every common RFQ-package format. Each file is routed
// to the best processing path its format physically allows. PDFs and images
// get full vision analysis. Text-based CAD (DXF, STEP, IGES, ASCII STL/OBJ,
// g-code) is parsed for human-readable content. Native binary CAD files
// (SLDPRT, DWG, IPT, CATPart, etc.) yield only metadata + embedded ASCII
// strings — Claude is told this explicitly so it doesn't hallucinate
// geometry.

const TEXT_CAD_EXTS = new Set(['dxf','step','stp','iges','igs','stl','obj','amf','3mf','sat','jt','nc','tap','gcode','csv','txt']);
const BINARY_CAD_EXTS = new Set(['sldprt','sldasm','ipt','iam','catpart','catproduct','prt','asm','f3d','dwg','x_t','x_b']);
const IMAGE_EXTS = new Set(['png','jpg','jpeg','gif','webp']);
const IMAGE_MIME = { jpg: 'image/jpeg', jpeg: 'image/jpeg', png: 'image/png', gif: 'image/gif', webp: 'image/webp' };

function classifyFile(filename, mimetype) {
  const lower = (filename || '').toLowerCase();
  const ext = lower.split('.').pop();
  if (ext === 'pdf' || mimetype === 'application/pdf') return { kind: 'pdf', ext };
  if (IMAGE_EXTS.has(ext)) return { kind: 'image', ext, mediaType: IMAGE_MIME[ext] };
  if (TEXT_CAD_EXTS.has(ext)) return { kind: 'text-cad', ext };
  if (BINARY_CAD_EXTS.has(ext)) return { kind: 'binary-cad', ext };
  if (['xlsx','xls','docx','doc'].includes(ext)) return { kind: 'office', ext };
  return { kind: 'unknown', ext };
}

// Extract useful human-readable content from text-based CAD/drawing files.
// Truncates aggressively to keep token cost reasonable — STEP/IGES files
// can be hundreds of MB of geometry primitives; we only want metadata +
// any named features or text annotations.
function extractTextCAD(buffer, filename, ext) {
  const MAX = 40 * 1024;
  let text;
  try { text = buffer.toString('utf-8'); } catch (e) { return `Could not read "${filename}" as UTF-8.`; }

  if (ext === 'step' || ext === 'stp') {
    const headerMatch = text.match(/HEADER;[\s\S]*?ENDSEC;/i);
    const header = headerMatch ? headerMatch[0] : '(no HEADER found)';
    // Pull product names from DATA section — they often hint at material/finish
    const productMatches = text.match(/PRODUCT\s*\([^)]*\)/gi) || [];
    const productLines = productMatches.slice(0, 20).join('\n');
    return `STEP file "${filename}":\n--- HEADER ---\n${header}\n\n--- PRODUCT ENTITIES (sample) ---\n${productLines}`.slice(0, MAX);
  }

  if (ext === 'iges' || ext === 'igs') {
    return `IGES file "${filename}" (first ${MAX/1024}KB):\n${text.slice(0, MAX)}`;
  }

  if (ext === 'dxf') {
    const headerMatch = text.match(/HEADER\s+[\s\S]*?ENDSEC/i);
    const header = headerMatch ? headerMatch[0].slice(0, 8000) : '';
    const textEntities = [];
    const re = /\b(TEXT|MTEXT|DIMENSION|ATTDEF|INSERT|LAYER)\b[\s\S]{0,800}?(?=\b0\b|$)/g;
    let m; let count = 0;
    while ((m = re.exec(text)) !== null && count < 80) { textEntities.push(m[0]); count++; }
    return `DXF file "${filename}":\n--- HEADER ---\n${header}\n\n--- TEXT/DIMENSION/LAYER ENTITIES ---\n${textEntities.join('\n---\n')}`.slice(0, MAX);
  }

  if (ext === 'stl') {
    // ASCII STL starts with "solid"; binary STL is 80-byte header + binary
    if (text.trim().toLowerCase().startsWith('solid')) {
      return `ASCII STL file "${filename}" (first ${MAX/1024}KB):\n${text.slice(0, MAX)}`;
    }
    return `Binary STL file "${filename}" — geometry is binary mesh data, not directly readable. File header (first 80 chars): "${text.slice(0, 80).replace(/[^\x20-\x7E]/g, '?')}"`;
  }

  if (['obj','amf','3mf','sat','jt','nc','tap','gcode','csv','txt'].includes(ext)) {
    return `${ext.toUpperCase()} file "${filename}":\n${text.slice(0, MAX)}`;
  }

  return `Text content from "${filename}":\n${text.slice(0, MAX)}`;
}

// ===== EXPORT-CONTROL / DEFENSE MARKER DETECTION =====
// Replaces the old substring-match approach with precise regex patterns
// that require qualifying context — so "ITARGETT-205" (a part number) or
// the word "year" don't trip false positives, while real markings like
// "ITAR controlled per 22 CFR 121" or "USML Category VIII" are caught.
//
// Returns an array of { marker, line, context } findings per file, or
// null if no marker hits. The caller decides what to do with the results.

const ITAR_PATTERNS = [
  // Direct ITAR markers (require qualifier — never just "ITAR" alone)
  { name: 'ITAR controlled', regex: /\bITAR[\s-]*(controlled|restricted|regulated|covered|subject)\b/i },
  { name: 'ITAR citation (22 CFR)', regex: /\b22\s*CFR\s*1(2[0-9]|30)\b/i },
  { name: 'ITAR Part reference', regex: /\bITAR\s*Part\s*1(2[0-9]|30)\b/i },
  { name: 'technical data subject to ITAR', regex: /\btechnical\s+data[\w\s,]{0,60}\bITAR\b/i },

  // USML / Munitions List (these are unambiguous when found)
  { name: 'USML Category', regex: /\bUSML\s*(Category|Cat\.?|Part)\s*[IVX]+\b/i },
  { name: 'U.S. Munitions List', regex: /\bU\.?S\.?\s*Munitions\s*List\b/i },

  // EAR — requires citation or qualifier (not standalone, too common in English)
  { name: 'EAR 99', regex: /\bEAR\s*99\b/i },
  { name: 'EAR Category', regex: /\bEAR\s*Category\s*\d+\b/i },
  { name: 'EAR controlled', regex: /\bEAR[\s-]*(controlled|regulated|covered)\b/i },
  { name: 'EAR citation (15 CFR)', regex: /\b15\s*CFR\s*7[3-7][0-9]\b/i },
  { name: 'Export Administration Regulations', regex: /\bExport\s+Administration\s+Regulations?\b/i },
  { name: 'ECCN code', regex: /\bECCN\s*[\(\:]?\s*[0-9][A-E][0-9]{2,3}\b/i },

  // DDTC — specific enough on its own
  { name: 'DDTC', regex: /\b(DDTC|Directorate\s+of\s+Defense\s+Trade\s+Controls)\b/i },

  // Classification banner markings (require slash-slash format)
  { name: 'SECRET banner', regex: /\b(TOP\s+SECRET|SECRET|CONFIDENTIAL)\s*\/\/[A-Z]/ },
  { name: 'CUI banner', regex: /\bCUI\s*\/\/[A-Z\s-]+/ },
  { name: 'NOFORN', regex: /\bNOFORN\b/ },

  // Specific cybersecurity / CUI handling clauses (these signal defense work)
  { name: 'DFARS 252.204-7012 (CUI handling)', regex: /\bDFARS\s*252\.\s*204\s*-\s*70(12|19|20|21)\b/i },
  { name: 'NIST SP 800-171', regex: /\bNIST\s*SP?\s*800[-\s]171\b/i },
  { name: 'CMMC L2/L3', regex: /\bCMMC\s*(Level\s*)?[23]\b/i },
  { name: 'controlled unclassified information', regex: /\bcontrolled\s+unclassified\s+information\b/i },

  // Distribution markings (DoD)
  { name: 'DoD Distribution Statement B-F', regex: /\bdistribution\s+statement\s+[B-F]\b/i },

  // Export-controlled phrasing
  { name: 'export controlled', regex: /\bexport[\s-]controlled\b/i },
  { name: 'export license required', regex: /\b(export\s+license\s+required|requires?\s+export\s+license)\b/i },
  { name: 'not for export', regex: /\bnot\s+for\s+(export|foreign\s+disclosure)\b/i },

  // MIL-SPEC ONLY when paired with access/access-control language
  // (MIL-SPEC alone is too common in commercial drawings — references to MIL test methods, etc.)
  { name: 'MIL-SPEC restricted access', regex: /\bMIL[\s-]SPEC\s+(secret|classified|restricted|controlled\s+access|access\s+control)\b/i },
];

// Exclusion patterns — if these appear in the SAME LINE as a potential marker,
// treat that line's marker as a false positive
const ITAR_EXCLUSIONS = [
  /\bnon[\s-]ITAR\b/i,
  /\bnot\s+(subject\s+to\s+)?ITAR\b/i,
  /\bITAR[\s-]free\b/i,
  /\bcommercial[\s,]+not\s+ITAR\b/i,
  /\bfree\s+from\s+ITAR\b/i,
  /\bno\s+ITAR\b/i,
];

function findITARMarkers(text, filename) {
  if (!text || typeof text !== 'string') return [];
  const lines = text.split(/\r?\n/);
  const findings = [];

  for (let lineIdx = 0; lineIdx < lines.length; lineIdx++) {
    const line = lines[lineIdx];
    if (!line.trim()) continue;

    // Skip lines containing explicit exclusion language
    const isExcluded = ITAR_EXCLUSIONS.some(ex => ex.test(line));
    if (isExcluded) continue;

    for (const pattern of ITAR_PATTERNS) {
      const m = line.match(pattern.regex);
      if (m) {
        findings.push({
          file: filename,
          marker: pattern.name,
          matchedText: m[0],
          line: lineIdx + 1,
          context: line.trim().slice(0, 220),
        });
        break; // one finding per line is enough
      }
    }
  }

  // Cap at 12 findings per file to keep response size reasonable
  return findings.slice(0, 12);
}

// ===== XLSX / DOCX TEXT EXTRACTION =====
// Proper parsing for Office files — not just yanking ASCII strings out
// of the binary. Both use dynamic imports so a missing package doesn't
// crash module load (fails gracefully back to binary-string extraction).

async function extractXlsxText(buffer, filename, ext) {
  try {
    const XLSX = await import('xlsx');
    const wb = XLSX.read(buffer, { type: 'buffer', cellDates: true });
    const out = [`Spreadsheet "${filename}" (${ext.toUpperCase()}) — ${wb.SheetNames.length} sheet(s):`];
    for (const sheetName of wb.SheetNames) {
      out.push(`\n=== Sheet: ${sheetName} ===`);
      const sheet = wb.Sheets[sheetName];
      const csv = XLSX.utils.sheet_to_csv(sheet, { blankrows: false });
      out.push(csv.slice(0, 30000));
      if (csv.length > 30000) out.push(`\n... [truncated, ${csv.length} total chars] ...`);
    }
    return out.join('\n').slice(0, 50000);
  } catch (e) {
    console.error(`xlsx extract failed for ${filename}:`, e?.message);
    return `Spreadsheet "${filename}" — could not parse cell content. File may be password-protected, corrupted, or use an unsupported variant.`;
  }
}

async function extractDocxText(buffer, filename) {
  try {
    const mammoth = await import('mammoth');
    const result = await mammoth.extractRawText({ buffer });
    const text = (result.value || '').trim();
    if (!text) return `Word document "${filename}" — no extractable text content found.`;
    return `Word document "${filename}":\n\n${text.slice(0, 50000)}`;
  } catch (e) {
    console.error(`mammoth extract failed for ${filename}:`, e?.message);
    return `Word document "${filename}" — could not parse paragraph content. File may be password-protected or in legacy .doc format (binary OLE).`;
  }
}

// For binary/proprietary CAD files: extract filename + size + any embedded
// ASCII strings. SolidWorks, Inventor, Creo, CATIA, etc. embed property
// tables, descriptions, and custom properties as ASCII strings.
function extractBinaryMetadata(buffer, filename, ext) {
  const sizeMB = (buffer.length / 1024 / 1024).toFixed(2);
  const text = buffer.toString('latin1');
  const matches = text.match(/[\x20-\x7E]{8,200}/g) || [];

  // Score strings by how "interesting" they look — prefer human-readable words
  const interesting = matches
    .filter(s => {
      if (/^[\s.,;:'"\(\)\[\]\{\}=_\-+\\/]+$/.test(s)) return false;
      if (/^[A-Fa-f0-9]{16,}$/.test(s)) return false;
      if (/^[\x21-\x2F\x3A-\x40\x5B-\x60\x7B-\x7E]+$/.test(s)) return false;
      // Prefer strings with actual letters and spaces (more likely to be human text)
      const letterCount = (s.match(/[A-Za-z]/g) || []).length;
      return letterCount >= 4;
    })
    .filter((s, i, arr) => arr.indexOf(s) === i) // dedupe
    .slice(0, 60);

  const banner = ext.toUpperCase();
  return `Native CAD file "${filename}" (${banner}, ${sizeMB} MB):\n\n` +
    `This is a proprietary binary CAD format. The 3D geometry, dimensions, and GD&T inside cannot be parsed directly by the AI. ` +
    `The following ASCII strings were extracted from the file's metadata + property tables (these often contain part numbers, material names, custom properties, file paths, and configuration notes):\n\n` +
    interesting.join('\n') +
    `\n\n--- ANALYZER GUIDANCE ---\n` +
    `If this RFQ package does NOT include a companion PDF drawing or image, surface a clarification flag: "Native CAD file received without companion PDF drawing — visual confirmation of features, GD&T, surface finish callouts, and tolerance requirements is not possible from the binary CAD geometry alone. Recommend the customer export and attach a PDF of the drawing for complete risk analysis."`;
}

// ===== SYSTEM PROMPT =====
// This is the critical prompt that enforces the legal-safe risk language.
// Do NOT modify the LANGUAGE RULES section without legal review.
const SYSTEM_PROMPT = `You are QuoteScout, an AI risk-surfacing engine for precision manufacturing RFQs. You surface risks in RFQ documents. You do NOT make decisions, approve bids, guarantee manufacturability, or replace engineering judgment.

THE MINDSET YOU OPERATE FROM:
You read like a senior precision-machining estimator under Friday-deadline pressure — but your judgment comes from a Lead Manufacturing Engineer with 30+ years on the shop floor, who has watched margin creep destroy more shops than tariffs ever did. You are blunt, technical, and skeptical. You look for the things the customer didn't say, and the notes the estimator will skim past because they're in a hurry. Every flag must answer one of three questions:
  1. What could cause us to underquote this job?
  2. What could cause rework, scrap, or a missed delivery after the bid is won?
  3. What must be clarified with the customer before any price is committed?
If a flag does not answer one of those three questions, do not surface it. Volume of flags is not the goal — relevance is.

ASSUMPTIONS YOU MUST NOT MAKE:
- Do NOT assume the main drawing contains everything. Critical requirements (special processes, certifications, FAI/PPAP, inspection plans, surface finish callouts) are often in secondary notes, title blocks, revision blocks, attached spec sheets, or referenced standards.
- Do NOT assume that what is not stated is not required. Implied operations (deburr, stress relief, post-heat-treat grind, laser mark, 100% inspection) are common cost leaks.
- Do NOT assume material spec and material certification requirements are the same. A part may call for "4140 PH" but separately require a mill cert traceable to the heat lot — that's a sourcing constraint that affects price.
- Treat vague, missing, or contradictory information as a flag in itself. "Surface finish per print" with no Ra value is a clarification flag, not a non-issue.

LANGUAGE RULES (mandatory — never violate):
- NEVER say "this job is safe to bid" or "you should bid this"
- NEVER say "this job cannot be made" — say "requires verification"
- NEVER say "Go" or "No-Bid" — say "review recommended" or "high-risk flags present"
- ALWAYS include in mandatory disclaimer: "All flags require verification by qualified engineering personnel before pricing"
- Frame every flag as: "Risk identified: [description]. Confidence: [%]. Recommended action: [verify/calculate/confirm]"

FLAG SEVERITY DEFINITIONS:
- RED: Sequence physically impossible OR a confirmed missing compliance requirement OR a hard contradiction between documents
- AMBER: Compliance gap detected — requires shop to confirm certification or capability before committing
- YELLOW: Hidden cost risk — missing operation, unquoted outside service, dimensional math required, or quantity-vs-process mismatch (e.g., qty 5 with PPAP requirements)
- PURPLE: Low confidence (< 70%) — AI uncertain; human verification required before any action

THE 4 RISK CATEGORIES YOU MUST CHECK FOR:

1. Compliance & Inspection Risk
   - Certifications buried anywhere — recognize these by name OR by document reference:
     * Quality Management Systems: ISO 9001 (general manufacturing QMS — baseline), AS9100 (aerospace QMS, supersedes ISO 9001 for aerospace), AS9110 (aerospace MRO/repair stations), AS9120 (aerospace distributors), IATF 16949 (automotive QMS, supersedes ISO/TS 16949), ISO 13485 (medical device QMS), API Q1 / API Q2 / API Spec 6A (oil & gas)
     * Process / Special Process: NADCAP (special-process accreditation — heat treat, NDT, chem-processing, welding, surface enhancement); customers may require NADCAP-accredited sub-tier vendors
     * Defense & Export Control: DFARS (defense procurement), DFARS 252.225-7009 (specialty metals), ITAR / EAR / USML / DDTC (export controls), NIST SP 800-171 (controlled unclassified info handling), CMMC Level 1/2/3 (cybersecurity maturity), CUI markings
     * Calibration / Testing: ISO/IEC 17025 (testing & calibration labs — often required for source inspection or in-house metrology)
     * Pressure & Code Work: ASME Section VIII / ASME B&PV (pressure vessels), ASME NQA-1 (nuclear quality assurance), PED 2014/68/EU (European pressure equipment directive)
     * Environment / Safety: ISO 14001 (environmental), ISO 45001 (occupational health & safety), RoHS/REACH (substance restriction), conflict minerals (Dodd-Frank §1502)
     * Industry-Specific: NSF/ANSI 51/61 (food/water contact), 3-A Sanitary (dairy/food equipment), CE marking (EU), UL listing (US safety), ABS / DNV / Lloyd's (marine classification), AAR M-1003 (railroad), FDA 21 CFR (medical/pharma)
     * Inspection / FAI: AS9102 (aerospace FAI), PPAP (production part approval, levels 1-5), VDA 2 (German automotive), source inspection clauses
   - Inspection requirements: 100% inspection, CPK/Cpk studies, FAI, PPAP, source inspection, CMM reports, layout inspections
   - Material specifications vs material certifications — note when both are required and flag if cert traceability adds sourcing constraint
   - Customer-specific quality clauses referenced by number (e.g., "QC-7 applies") that aren't expanded in the document

2. Sequence & Process Risk
   - Operations that must happen in a specific order: heat treat before finish grind, stress relief before finish machining, Nital Etch after aerospace grinding, deburr before plating
   - Special processes that imply additional sequence steps the drawing doesn't show: black oxide implies pre-clean; passivation implies post-machining clean; brazing implies fixturing
   - Tight or unusual tolerances that imply specific process choices (e.g., ±0.0001" implies grinding or lapping, not just turning)
   - Surface finish callouts (Ra values, mirror finish, no tool marks) that imply a finishing operation not otherwise scoped

3. Dimensional Compensation Risk
   - Coatings that change dimensions: Electroless Nickel (+0.0002"–0.0005" per side), Hard Coat Anodize (+0.0005"–0.001" per side), chrome plate, black oxide
   - Threads requiring undersize cut to compensate for coating buildup
   - Pre-grind / pre-coat / pre-plate dimensions for any features called out as "after coating" or "finished size"
   - Show the math when calculating compensated dimensions

4. Outside Service & Vendor Risk
   Read the drawing notes, title block, and revision block carefully — outside ops are often referenced by spec number alone (e.g., "MIL-A-8625 Type III Class 2") rather than process name. Identify the SPECIFIC class/type, not just the generic process. The categories below are not exhaustive but represent the operations that most often hide cost:
   - Thermal & stress: Vacuum Heat Treat, Induction Hardening, Cryogenic Treatment, Nitriding, Stress Relief, Carburize, Through-Harden vs Case-Harden distinction
   - Surface & plating: Electroless Nickel (note High/Mid/Low Phosphorus class), Hard Coat Anodize Type III vs Type II, Chromate Conversion / Chem Film, Passivation (Nitric vs Citric), Electropolish, Black Oxide, Zinc-Nickel
   - Mechanical finishing: Centerless Grinding (OD/ID), Jig Grinding, Lapping (call out flatness in light-band tolerance), Honing, Shot Peen (Almen intensity), Polishing, Tumble/Vibratory Deburr
   - Non-destructive testing: Magnetic Particle (Magnaflux), Fluorescent Penetrant Inspection (FPI), Radiography / X-Ray, Ultrasonic Testing, Eddy Current
   - Marking & final: Laser Engrave (depth requirements), Electro-Chem Etch, Vibro-Peen, Ink Stamp, Tagging/Bagging requirements per print
   For each detected outside op: flag NADCAP-required processors (heat treat, NDT, special-process aerospace). Flag spec-number-locked vendors (e.g., "per Metcut process X") that limit vendor choice. Note when sequence implies multiple hand-offs — every additional vendor multiplies lead-time risk and minimum-lot exposure. Quantity-vs-process mismatch (qty 1–10 with 4+ outside ops) means outside service minimums likely exceed machining labor — flag this explicitly.

5. Precision & Material Blind Spots (the things estimators skim past)
   - Title-block "Unless Otherwise Specified" tolerances vs explicit GD&T callouts on individual features — when these conflict or when UOS is tighter than estimators typically assume, surface the conflict
   - Tight or unusual tolerances (more than 3 decimal places, or GD&T position/runout/cylindricity callouts under 0.001"): flag as inspection-cost driver and potential CMM/layout-inspection requirement
   - Material gotchas: DFARS / DFAR 252.225-7009 specialty metals clause, "no Chinese material" stipulations, heat-lot or melt-lot traceability requirements, "material supplied by customer" (which means scrap exposure transfers to the shop)
   - Material-vs-process mismatch: gummy materials (303 stainless, 17-4 PH H1150) need different speeds/feeds than 6061 — note when material implies tool-life cost driver
   - Hard-to-machine materials at production volume: Titanium 6Al-4V, Inconel 718, Hastelloy, hardened tool steel — flag tool-wear cost driver when qty > 50
   - Geometry red flags: wall thickness < 0.010", deep-hole drilling with L:D ratio > 10:1, blind holes with bottom flatness/finish callouts — flag scrap-rate risk and recommend a first-article qualification run before committing to bulk pricing
   - Fixture/setup complexity: ±0.0002" callouts on three or more orthogonal planes, or tight relationships across opposing faces, imply 5-axis or complex soft-jaw work — flag as setup NRE risk that estimators frequently absorb
   When you flag a cost-driver risk, NEVER state a price, percentage markup, or hour count. State the *category* of cost driver and recommend verification — for example: "Tool wear is a significant cost driver on Titanium at this volume — verify carbide insert burn rate with tooling vendor before pricing." NOT: "Add 20% for tooling." Your job is to make the estimator look at the right line item; the estimator owns the number.

CROSS-DOCUMENT REASONING:
If multiple documents are provided, treat them as ONE RFQ package. Cross-check:
   - Drawing callouts vs spec sheet requirements (do they agree?)
   - Notes on the drawing vs purchase order text (any contradictions on quantity, delivery, or quality clauses?)
   - Material on the drawing vs material on the spec or PO (matches exactly, or substitutes implied?)
   - Tolerance on the drawing vs tolerance in customer-specific quality clauses
   - When documents conflict, surface the conflict as a clarification flag — do not silently pick one source

FILE TYPES YOU MAY RECEIVE (multi-format RFQ packages):
QuoteScout accepts every common RFQ-package format. The richness of analysis depends on the file's format:
- PDF drawings (text or scanned) — full visual analysis of dimensions, GD&T, notes, title blocks
- Image files (PNG/JPG/GIF/WEBP) — typically scanned drawings or CAD screenshots; same vision analysis as PDF
- DXF 2D drawings — extracted text content including HEADER and TEXT/MTEXT/DIMENSION/LAYER entities; reason about layer names, drawing notes, and dimensional text. Geometry primitives are not visible
- STEP/STP files — extracted HEADER section + PRODUCT entities; reason about file metadata (author, software, units, schema), product/part naming, material references in the header
- IGES/IGS files — extracted ASCII header content; similar reasoning as STEP
- ASCII STL/OBJ/AMF/3MF — extracted vertex/facet data and headers; reason about file metadata only
- Parasolid (.x_t) / SAT / JT — extracted ASCII header content
- G-code (.nc/.tap/.gcode) — toolpath programs; reason about operations referenced, tool changes, feeds/speeds, fixture offsets
- CSV/Excel/Word documents — typically BOMs, inspection plans, material certifications, quality clauses
- Native binary CAD (SLDPRT, SLDASM, IPT, IAM, prt, asm, CATPart, CATProduct, f3d, DWG, .x_b) — only filename, size, and embedded ASCII property strings are visible. The 3D geometry, dimensions, and GD&T cannot be parsed. If a native CAD file appears WITHOUT a companion PDF drawing or image, ALWAYS surface a clarification flag noting that visual confirmation is not possible from binary CAD alone, and recommend the customer export a PDF drawing

Apply the same 5 risk categories to every file format. Calibrate confidence to the format: native CAD without a drawing → most flags should be PURPLE (low confidence) because you literally cannot see the geometry.

BROADER MANUFACTURING OPERATIONS AWARENESS:
While precision machining (turning, milling, drilling, grinding, EDM) is the most common scope, recognize and apply the same risk-surfacing logic to adjacent operations when they appear in an RFQ:
- Casting & post-cast machining: parting line cleanup, hardness variation, internal porosity NDT (X-ray/CT), stress relief before machining
- Forging & post-forge: scale removal, dimensional cleanup margin, grain-flow orientation, trim/coin operations
- Powder metallurgy (MIM, HIP, press-and-sinter): density requirements, infiltration, secondary machining, sintering shrinkage
- Additive manufacturing (DMLS/SLM/EBM, binder jetting, FDM/SLA/SLS): support removal, HIP, post-AM stress relief, build-orientation constraints, surface finishing (as-built Ra is typically 200-800 µin)
- Sheet metal fabrication: laser/waterjet/plasma cutting, press brake, deep drawing, hemming, flat-pattern bend allowance, K-factor assumptions
- EDM operations: wire EDM tolerance class (P/M/N), surface finish (recast layer thickness), corner radius minimums, electrode requirements for sinker EDM
- Welded assemblies: weld procedure spec (WPS), filler metal traceability, NDT (Magnaflux, FPI, RT, UT), post-weld machining, distortion control, heat-treat after welding
- Composite manufacturing: layup, vacuum bagging, autoclave cure cycles, ultrasonic NDT, post-cure machining (diamond tooling required)
- Joining (brazing, soldering, mechanical fastening): joint design, fixture/jig requirements, post-join cleaning, PEM nut installation, helicoil installation
- Advanced heat treat: cryogenic stabilization, vacuum HT, induction hardening (case depth), nitriding (white-layer thickness), carburizing depth
- Advanced surface treatments: thermal spray, HVOF, PVD/CVD, DLC, electropolish per ASTM B912
- Inspection & metrology: AS9102 FAI, PPAP (PSW levels 1-5), layout inspection, CMM scanning, blue-light/structured-light scanning, source inspection, gauge R&R

For all of these, apply the same 5 risk categories (compliance, sequence, dimensional comp, outside service, precision/material blind spots). The risk-surfacing logic is universal even when the process is non-precision-machining.

OUTPUT FORMAT:
Return ONLY valid JSON. No preamble, no commentary, no markdown code fences. Use this exact schema:

{
  "flags": [
    {
      "severity": "RED" | "AMBER" | "YELLOW" | "PURPLE",
      "category": "compliance" | "sequence" | "dimensional" | "outside_service" | "inspection" | "material" | "clarification",
      "title": "Short title of the risk (under 80 chars)",
      "description": "1-3 sentences describing the risk. No prescriptive language.",
      "confidence": 0-100,
      "location": "page or section reference (e.g., 'page 3, note 4' or 'spec sheet, section 2.1')",
      "estimatedCostRange": "optional cost range like '$2,000-$5,000'",
      "recommendedAction": "verify with [role] / calculate [thing] / confirm [cert] / clarify with customer"
    }
  ],
  "dimensions": [
    {
      "feature": "feature description (e.g., '1.0000 +0.0005 bore')",
      "coating": "coating type (e.g., 'Electroless Nickel per AMS 2404 Class 3')",
      "preCoatValue": "calculated pre-coat dimension",
      "calculation": "show the math"
    }
  ],
  "flagCounts": {
    "red": <integer>,
    "amber": <integer>,
    "yellow": <integer>,
    "purple": <integer>
  },
  "summary": "2-3 sentences. NO 'Go/No-Bid' language. NO 'safe to bid'. State what was checked, what was found, what is missing or unclear."
}

If a flag is below 70% confidence, ALWAYS mark it PURPLE regardless of category.
If you cannot extract enough information to analyze, return {"flags": [], "dimensions": [], "flagCounts": {"red":0,"amber":0,"yellow":0,"purple":0}, "summary": "Insufficient information in document. Please verify the file contains a complete RFQ."}.

ITAR / EXPORT-CONTROL DETECTION (mandatory bail-out):
If you detect ANY markers indicating export-controlled work — including but not limited to ITAR, EAR, DDTC, USML, MIL-SPEC defense, DFARS 252.204-7012/7019, classified, secret, top secret, or controlled unclassified information (CUI) — anywhere in the document (body text, drawing title blocks, revision blocks, notes, stamps), STOP analysis and return ONLY this JSON:
{"itar_detected": true, "summary": "Document contains export-controlled markers. QuoteScout V1 is for non-ITAR commercial work only."}`;

// ===== MAIN HANDLER =====
export default async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed. Use POST.' });
  }

  const startTime = Date.now();
  let pdfBuffers = []; // [{ buffer, name, label, size, pages, extractedText }]
  let logId = null;

  // Label dropdown values from frontend → human-readable names for the prompt
  const LABEL_DISPLAY = {
    drawing: 'Drawing',
    spec_sheet: 'Spec Sheet',
    purchase_order: 'Purchase Order',
    quality_clauses: 'Quality Clauses',
    fai_form: 'FAI / PPAP Form',
    other: 'Other',
    '': 'Unlabeled',
  };

  try {
    // ----- 1. Parse multipart form -----
    const form = formidable({
      maxFileSize: 50 * 1024 * 1024,           // 50 MB per file (also serves as total cap)
      maxTotalFileSize: 50 * 1024 * 1024,      // 50 MB total across the package
      maxFiles: 8,
      multiples: true,
      keepExtensions: true,
    });

    const [fields, files] = await form.parse(req);

    const email = (fields.email?.[0] || '').trim().toLowerCase();
    const companyName = (fields.company_name?.[0] || '').trim();
    const emailBodyRaw = (fields.email_body?.[0] || '').trim();
    // Cap at 30KB to keep token cost bounded
    const emailBody = emailBodyRaw.slice(0, 30000);

    // formidable returns either a single object or an array under `files.files`
    const rawFiles = files.files
      ? (Array.isArray(files.files) ? files.files : [files.files])
      : [];

    // Labels arrive as a parallel array — same order as files
    const labels = fields.labels
      ? (Array.isArray(fields.labels) ? fields.labels : [fields.labels])
      : [];

    if (!email) {
      return res.status(400).json({ error: 'Email is required.' });
    }
    if (rawFiles.length === 0 && !emailBody) {
      return res.status(400).json({ error: 'Provide at least one file or paste the RFQ email/notes (minimum ~30 characters).' });
    }
    if (rawFiles.length > 8) {
      return res.status(400).json({ error: 'Maximum 8 files per RFQ package.' });
    }

    // ----- 2. Read each file into memory, validate, run text pre-extraction -----
    let totalSize = 0;
    let totalPages = 0;

    for (let i = 0; i < rawFiles.length; i++) {
      const file = rawFiles[i];
      const filename = file.originalFilename || `file-${i + 1}`;
      const classification = classifyFile(filename, file.mimetype);

      if (classification.kind === 'unknown') {
        return res.status(400).json({
          error: `"${filename}" — file type ".${classification.ext}" not recognized. QuoteScout accepts PDF, images (PNG/JPG/etc.), DXF, STEP/STP, IGES/IGS, STL/OBJ/3MF, Parasolid, SolidWorks, Inventor, Creo, CATIA, AutoCAD DWG, Fusion 360, G-code, BOM spreadsheets, and most common RFQ formats.`,
        });
      }

      const buffer = fs.readFileSync(file.filepath);
      try { fs.unlinkSync(file.filepath); } catch (e) { /* ignore */ }

      // Build the appropriate processing record for each file type
      const record = {
        buffer,
        name: filename,
        label: labels[i] || '',
        size: file.size,
        classification,
        pages: 0,
        extractedText: '',
      };

      if (classification.kind === 'pdf') {
        // Best-effort PDF text extract for ITAR pre-screen
        try {
          const pdfData = await pdf(buffer);
          record.extractedText = pdfData.text || '';
          record.pages = pdfData.numpages || 0;
        } catch (err) {
          console.log(`PDF text extract failed for ${filename}; relying on Claude vision.`);
        }
      } else if (classification.kind === 'text-cad') {
        record.extractedText = extractTextCAD(buffer, filename, classification.ext);
      } else if (classification.kind === 'office') {
        // Modern xlsx/docx: use proper parsers (xlsx + mammoth via dynamic import)
        // Legacy xls/doc: fall back to binary-string extraction
        if (classification.ext === 'xlsx' || classification.ext === 'xls') {
          record.extractedText = await extractXlsxText(buffer, filename, classification.ext);
        } else if (classification.ext === 'docx') {
          record.extractedText = await extractDocxText(buffer, filename);
        } else {
          // .doc legacy binary OLE — no clean parser without heavy deps
          record.extractedText = extractBinaryMetadata(buffer, filename, classification.ext);
        }
      } else if (classification.kind === 'binary-cad') {
        record.extractedText = extractBinaryMetadata(buffer, filename, classification.ext);
      } else if (classification.kind === 'image') {
        // No text to extract for images; ITAR pre-screen happens via Claude vision later
      }

      // Per-file ITAR scan — so we can report which file triggered + where
      record.itarFindings = findITARMarkers(record.extractedText, filename);

      pdfBuffers.push(record);
      totalSize += file.size;
      totalPages += record.pages;
    }

    if (totalSize > 50 * 1024 * 1024) {
      return res.status(400).json({ error: 'Total package size exceeds 50 MB. Remove a file or compress.' });
    }

    // ----- 3. ITAR / export-control / defense marker pre-screen (per-file, precise) -----
    // Collect findings from all files AND from the pasted email/notes text
    const allItarFindings = pdfBuffers.flatMap(p => p.itarFindings || []);
    if (emailBody) {
      const notesFindings = findITARMarkers(emailBody, 'pasted RFQ notes / email body');
      allItarFindings.push(...notesFindings);
    }

    if (allItarFindings.length > 0) {
      try {
        await supabase.from('analysis_logs').insert({
          email,
          company_name: companyName,
          file_name: pdfBuffers.map(p => p.name).join(' + '),
          file_size_bytes: totalSize,
          file_pages: totalPages,
          status: 'rejected_itar',
          error_message: `Markers detected: ${allItarFindings.map(f => `${f.marker} in ${f.file}:${f.line}`).join('; ').slice(0, 1000)}`,
          file_deleted_at: new Date().toISOString(),
          ai_model_used: 'none',
        });
      } catch (e) { /* logging failure shouldn't block response */ }

      pdfBuffers = [];

      // Group findings by file for cleaner display
      const findingsByFile = {};
      for (const f of allItarFindings) {
        if (!findingsByFile[f.file]) findingsByFile[f.file] = [];
        findingsByFile[f.file].push(f);
      }

      const findingDetails = Object.entries(findingsByFile).map(([file, findings]) => ({
        file,
        markers: findings.map(f => ({
          marker: f.marker,
          line: f.line,
          matched: f.matchedText,
          context: f.context,
        })),
      }));

      return res.status(400).json({
        error: 'One or more uploaded files contain markers indicating export-controlled or defense-restricted work. QuoteScout is for non-ITAR commercial work only.',
        itar_detected: true,
        findings: findingDetails,
        guidance: 'If you believe this is a false positive (for example, a part number that happens to contain "ITAR", or text that references but disclaims ITAR scope), please remove or redact the matching content and re-upload. Each finding below shows the exact file, line number, and surrounding context that triggered detection.',
      });
    }

    // ----- 4. Build the multi-document content array for Claude -----
    // Pattern: [optional-email-body, text-header-1, document-1, text-header-2, document-2, ..., final-instruction]
    // The text headers tell Claude which document is which (label + filename), enabling
    // cross-document reasoning per the system prompt.
    const content = [];

    // Pasted email body / RFQ notes come first — they typically contain the actual
    // contract terms (quantities, compliance asks, quote-by date, price-firmness
    // clauses) that the attached drawing alone won't have.
    if (emailBody) {
      content.push({
        type: 'text',
        text: `=== RFQ NOTES / EMAIL BODY (pasted by user) ===\nThis is the email or note content the customer provided alongside the attached files. Treat it as authoritative for contract terms — quantities, quote-by dates, compliance requirements, certifications, pricing references, lead-time expectations — and cross-reference against the attached documents. When the email body and drawing conflict on the same topic, surface the conflict as a flag.\n\n${emailBody}\n\n=== END OF EMAIL BODY ===\n`,
      });
    }

    if (pdfBuffers.length > 1) {
      content.push({
        type: 'text',
        text: `This RFQ package contains ${pdfBuffers.length} documents${emailBody ? ' plus the pasted email body above' : ''}. Treat them as ONE package. Cross-reference across them. Surface conflicts between documents as flags.\n`,
      });
    }

    pdfBuffers.forEach((entry, idx) => {
      const labelDisplay = LABEL_DISPLAY[entry.label] || 'Unlabeled';
      const kind = entry.classification.kind;
      const ext = entry.classification.ext;
      content.push({
        type: 'text',
        text: `=== Document ${idx + 1} of ${pdfBuffers.length}: "${entry.name}" (type: ${ext.toUpperCase()}, labeled: ${labelDisplay}) ===`,
      });

      if (kind === 'pdf') {
        content.push({
          type: 'document',
          source: {
            type: 'base64',
            media_type: 'application/pdf',
            data: entry.buffer.toString('base64'),
          },
        });
      } else if (kind === 'image') {
        content.push({
          type: 'image',
          source: {
            type: 'base64',
            media_type: entry.classification.mediaType || 'image/jpeg',
            data: entry.buffer.toString('base64'),
          },
        });
      } else {
        // text-cad, binary-cad, office — already-extracted text content
        content.push({
          type: 'text',
          text: entry.extractedText || `(no extractable content from ${entry.name})`,
        });
      }
    });

    let finalInstruction;
    if (pdfBuffers.length === 0 && emailBody) {
      // Notes-only submission — no attached files, only the pasted email body
      finalInstruction = 'No documents were attached to this submission — only the email body / RFQ notes above. Analyze the contract terms, compliance requirements, quantities, quote-by date, and any other risk signals visible in the text. Since no drawing is present, flag any technical specifications referenced in the email (tolerances, material grades, processes) as PURPLE / verify — you cannot confirm them without the drawing. Recommend the customer provide a drawing to complete the analysis. Return the structured JSON risk report per the schema in your instructions.';
    } else if (pdfBuffers.length > 1) {
      finalInstruction = 'Analyze all of the above documents as one RFQ package' + (emailBody ? ' (including the pasted email body)' : '') + '. The package may contain PDF drawings, images, native CAD files, neutral CAD exports (STEP/IGES), sheet-metal flats (DXF), G-code, or BOMs — apply the analysis appropriate to each format and cross-reference across them' + (emailBody ? ' and the email body' : '') + '. If a native binary CAD file is present without a companion drawing, surface a clarification flag. Return the structured JSON risk report per the schema in your instructions.';
    } else {
      finalInstruction = 'Analyze the attached RFQ document' + (emailBody ? ' (and the pasted email body above)' : '') + ' for manufacturing risks. The document may be a PDF drawing, image/scan, CAD export (DXF/STEP/IGES/STL), native binary CAD (SLDPRT/IPT/CATPart/DWG/etc.), G-code, BOM spreadsheet, or other RFQ-package format. Read all available content. If it is a native binary CAD file with no drawing companion, calibrate confidence accordingly (most flags PURPLE) and recommend a PDF drawing. Return the structured JSON risk report per the schema in your instructions.';
    }

    content.push({ type: 'text', text: finalInstruction });

    // ----- 5. Call Claude API -----
    const response = await anthropic.messages.create({
      model: MODEL,
      max_tokens: 4096,
      system: SYSTEM_PROMPT,
      messages: [{ role: 'user', content }],
    });

    // ----- 6. Clear PDF buffers from memory -----
    pdfBuffers = [];

    // ----- 7. Parse the AI response -----
    let aiText = '';
    if (Array.isArray(response.content)) {
      for (const block of response.content) {
        if (block.type === 'text') aiText += block.text;
      }
    }

    aiText = aiText.trim();
    if (aiText.startsWith('```')) {
      aiText = aiText.replace(/^```(?:json)?\s*/, '').replace(/\s*```$/, '');
    }

    let parsed;
    try {
      parsed = JSON.parse(aiText);
    } catch (e) {
      console.error('Failed to parse AI JSON:', aiText.slice(0, 500));
      return res.status(500).json({
        error: 'AI returned malformed response. Please try again. If this persists, the document may be too unusual for our V1 prompts.',
      });
    }

    // Handle vision-detected ITAR
    if (parsed.itar_detected === true) {
      try {
        await supabase.from('analysis_logs').insert({
          email,
          company_name: companyName,
          file_name: 'package',
          file_size_bytes: totalSize,
          file_pages: totalPages,
          status: 'rejected_itar',
          error_message: 'Vision-detected ITAR/export-control markers',
          file_deleted_at: new Date().toISOString(),
          ai_model_used: MODEL,
        });
      } catch (e) { /* logging shouldn't block */ }

      return res.status(400).json({
        error: 'This document contains markers (ITAR, EAR, DDTC, MIL-SPEC defense, classified, or CUI) that indicate it may be export-controlled or defense-related work. QuoteScout V1 is for non-ITAR commercial work only. ITAR-cleared infrastructure is planned for Phase 4 (Month 18+).',
      });
    }

    // ----- 8. Compute counts (defensive) -----
    const counts = { red: 0, amber: 0, yellow: 0, purple: 0 };
    (parsed.flags || []).forEach(f => {
      const s = (f.severity || 'PURPLE').toLowerCase();
      if (counts[s] !== undefined) counts[s]++;
    });
    parsed.flagCounts = counts;

    // ----- 9. Log metadata to Supabase (no file content) -----
    const fileDeletedAt = new Date().toISOString();
    const processingMs = Date.now() - startTime;

    try {
      const { data: log, error: logErr } = await supabase
        .from('analysis_logs')
        .insert({
          email,
          company_name: companyName,
          file_name: rawFiles.map(f => f.originalFilename || 'unknown.pdf').join(' + '),
          file_size_bytes: totalSize,
          file_pages: totalPages,
          flag_count_red: counts.red,
          flag_count_amber: counts.amber,
          flag_count_yellow: counts.yellow,
          flag_count_purple: counts.purple,
          total_flags: counts.red + counts.amber + counts.yellow + counts.purple,
          ai_model_used: MODEL,
          processing_time_ms: processingMs,
          file_deleted_at: fileDeletedAt,
          status: 'completed',
        })
        .select('id')
        .single();

      if (!logErr && log) logId = log.id;
    } catch (e) {
      console.error('Supabase log failed:', e.message);
    }

    // ----- 9b. Email the report (optional — silently skipped if RESEND_API_KEY not set) -----
    sendReportEmail({
      to: email,
      companyName,
      fileNames: rawFiles.map(f => f.originalFilename || 'unknown.pdf'),
      analysisId: logId,
      counts,
      flags: parsed.flags || [],
      summary: parsed.summary || '',
    }).catch(e => console.error('Email send failed (non-blocking):', e?.message));

    // ----- 10. Return result -----
    return res.status(200).json({
      ...parsed,
      analysisId: logId,
      fileDeletedAt,
      modelUsed: MODEL,
      processingMs,
      fileCount: rawFiles.length,
      emailWillBeSent: !!process.env.RESEND_API_KEY,
    });

  } catch (err) {
    console.error('analyze.js error:', err);
    pdfBuffers = [];
    return res.status(500).json({
      error: 'Analysis failed. Please try again. If this persists, contact the QuoteScout team.',
      detail: process.env.NODE_ENV === 'development' ? err.message : undefined,
    });
  }
}

// =====================================================================
// Email helper — sends the risk report to the user via Resend.
// Silently skipped if RESEND_API_KEY is not configured. Never blocks
// the user-facing response — runs fire-and-forget.
// =====================================================================
async function sendReportEmail({ to, companyName, fileNames, analysisId, counts, flags, summary }) {
  if (!process.env.RESEND_API_KEY) return;

  const resend = new Resend(process.env.RESEND_API_KEY);
  const fromEmail = process.env.RESEND_FROM_EMAIL || 'reports@quotescout.com';

  const fileList = fileNames.join(', ');
  const totalFlags = (counts.red || 0) + (counts.amber || 0) + (counts.yellow || 0) + (counts.purple || 0);

  // Render flags as simple HTML blocks
  const flagHtml = (flags || []).slice(0, 30).map(f => {
    const sevColor = {
      RED: '#b91c1c',
      AMBER: '#b45309',
      YELLOW: '#a16207',
      PURPLE: '#7c3aed',
    }[(f.severity || 'PURPLE').toUpperCase()] || '#555';
    const conf = (typeof f.confidence === 'number') ? `${f.confidence}%` : '—';
    return `
<div style="border-left: 3px solid ${sevColor}; padding: 10px 14px; margin: 12px 0; background: #fafafa;">
  <div style="font-size: 11px; font-weight: 600; color: ${sevColor}; letter-spacing: 0.05em;">${(f.severity || '').toUpperCase()} · ${(f.category || '').toUpperCase()} · CONFIDENCE ${conf}</div>
  <div style="font-weight: 600; margin-top: 4px;">${escapeHtml(f.title || '')}</div>
  <div style="font-size: 14px; margin-top: 4px; color: #333;">${escapeHtml(f.description || '')}</div>
  ${f.location ? `<div style="font-size: 12px; color: #777; margin-top: 6px;">Location: ${escapeHtml(f.location)}</div>` : ''}
  ${f.recommendedAction ? `<div style="font-size: 13px; color: #444; margin-top: 4px;"><strong>Recommended:</strong> ${escapeHtml(f.recommendedAction)}</div>` : ''}
</div>`;
  }).join('');

  const outcomeUrl = analysisId
    ? `https://quotescout.vercel.app/outcome.html?id=${encodeURIComponent(analysisId)}`
    : null;

  const html = `
<div style="font-family: -apple-system, system-ui, 'Segoe UI', sans-serif; max-width: 640px; margin: 0 auto; color: #1a1a1a; line-height: 1.55; padding: 16px;">
  <div style="border-bottom: 2px solid #1a1a1a; padding-bottom: 12px; margin-bottom: 20px;">
    <h2 style="font-weight: 600; font-size: 20px; margin: 0;">QuoteScout — Risk Report</h2>
    <div style="font-size: 13px; color: #666; margin-top: 4px;">${escapeHtml(fileList)}${companyName ? ` · ${escapeHtml(companyName)}` : ''}</div>
  </div>

  <div style="background: #f5f1e8; padding: 12px 16px; border-left: 3px solid #7d3a30; margin-bottom: 20px;">
    <div style="font-size: 11px; font-weight: 600; color: #7d3a30; letter-spacing: 0.05em;">SUMMARY</div>
    <div style="margin-top: 6px;">${escapeHtml(summary || 'See flags below.')}</div>
  </div>

  <div style="display: flex; gap: 10px; flex-wrap: wrap; margin: 16px 0;">
    <span style="background: #fef2f2; color: #b91c1c; padding: 6px 12px; border-radius: 4px; font-size: 13px; font-weight: 600;">RED ${counts.red || 0}</span>
    <span style="background: #fffbeb; color: #b45309; padding: 6px 12px; border-radius: 4px; font-size: 13px; font-weight: 600;">AMBER ${counts.amber || 0}</span>
    <span style="background: #fefce8; color: #a16207; padding: 6px 12px; border-radius: 4px; font-size: 13px; font-weight: 600;">YELLOW ${counts.yellow || 0}</span>
    <span style="background: #f5f3ff; color: #7c3aed; padding: 6px 12px; border-radius: 4px; font-size: 13px; font-weight: 600;">PURPLE ${counts.purple || 0}</span>
  </div>

  <h3 style="font-size: 16px; margin-top: 24px;">Risk Flags (${totalFlags})</h3>
  ${flagHtml || '<p style="color: #777;">No flags surfaced.</p>'}

  <div style="background: #fafafa; border: 1px solid #e5e5e5; padding: 14px; margin-top: 24px; font-size: 13px; color: #555;">
    <strong>Mandatory disclaimer:</strong> All flags require verification by qualified engineering personnel before pricing. QuoteScout does not price jobs, guarantee manufacturability, or replace engineering judgment.
  </div>

  ${outcomeUrl ? `
  <div style="margin-top: 24px; padding: 16px; border: 1px dashed #999; text-align: center;">
    <p style="margin: 0 0 12px;"><strong>Help us improve.</strong> When this RFQ closes, tell us what happened.</p>
    <a href="${outcomeUrl}" style="background: #1a1a1a; color: white; padding: 10px 20px; text-decoration: none; border-radius: 4px; display: inline-block; font-weight: 500;">Track this outcome →</a>
    <p style="margin: 12px 0 0; font-size: 12px; color: #777;">This is the data loop. Every outcome reported makes the system sharper for the next shop.</p>
  </div>` : ''}

  <hr style="border: none; border-top: 1px solid #eee; margin: 32px 0 16px;">
  <p style="font-size: 12px; color: #888;">QuoteScout · risk-surfacing engine for precision manufacturing RFQs · Built by Sid K · Reply to this email with feedback or to talk shop.</p>
</div>`;

  await resend.emails.send({
    from: `QuoteScout <${fromEmail}>`,
    to,
    subject: `QuoteScout risk report — ${fileList.length > 60 ? fileNames[0] + ' + others' : fileList} (${totalFlags} flags)`,
    html,
  });
}

function escapeHtml(s) {
  if (typeof s !== 'string') return '';
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}
