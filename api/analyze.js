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
// Deterministic STEP geometry-signal extractor (api/step-probe.js). STEP files
// carry no PMI/GD&T and the model otherwise sees only the HEADER/PRODUCT text —
// it cannot see geometry. buildStepSummary() gives it a computed face mix,
// envelope, cylindrical-diameter list, freeform share, assembly detection, and
// unit/scale caveats to reason against. Named imports only; the default Vercel
// handler in that file is unused here.
import { extractStepSignals, buildStepSummary } from './step-probe.js';

// Body is now small JSON (Storage file references + client OCR text), not
// multipart file bytes. Files upload straight to Supabase Storage via signed URLs,
// so this function never receives the bytes and Vercel's 4.5 MB body limit no
// longer applies to uploads.
export const config = {
  api: {
    bodyParser: { sizeLimit: '2mb' },
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

// Service-role client for PRIVILEGED, server-only reads that must bypass RLS.
// `nda_acceptances` has Row Level Security on with no anon SELECT policy — which
// is correct: it holds PII (emails, names, companies, IPs) and the anon key is
// public, so the table must not be readable from the browser. The public client
// above therefore cannot see those rows; this server-only client, using the
// service-role key, can. This key must NEVER be exposed to the browser.
// If SUPABASE_SERVICE_ROLE_KEY isn't set it falls back to the anon client, in
// which case the NDA read keeps returning empty (set the env var in Vercel).
const supabaseAdmin = process.env.SUPABASE_SERVICE_ROLE_KEY
  ? createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY)
  : supabase;

// Direct-to-Storage upload path: the browser uploads files straight to this
// private bucket (via signed URLs minted by /api/upload-url), and this function
// downloads each one, processes it, and DELETES it immediately — nothing retained.
const RFQ_BUCKET = 'rfq-uploads';

// Download one Storage object into a Node Buffer. Throws on failure.
async function downloadFromStorage(path) {
  const { data, error } = await supabaseAdmin.storage.from(RFQ_BUCKET).download(path);
  if (error || !data) {
    throw new Error(`storage download failed for ${path}: ${error?.message || 'no data returned'}`);
  }
  const ab = await data.arrayBuffer();
  return Buffer.from(ab);
}

// ===== MODEL SELECTION =====
// To switch from Haiku (cheaper) to Sonnet (smarter) when you have
// paying customers: change this single line.
const MODEL = 'claude-sonnet-4-6';
// Alternatives (one-line swap):
//   'claude-haiku-4-5-20251001'  → ~5x cheaper, much weaker instruction-following. NOT recommended for V1.
//   'claude-opus-4-7'            → smartest model. Use only when an analysis matters enormously and cost is irrelevant.

// ===== STAGE-B OCC GEOMETRY MICROSERVICE (Cloud Run) =====
// For STEP files we additionally call the OpenCascade microservice, which returns
// TRUE topology the model can't compute from STEP text (hole depth:diameter, min
// wall, material-removal ratio, setup-count proxy, exact assembled bbox). Wholly
// optional and best-effort: set OCC_URL to enable; on timeout/error we proceed
// with step-probe's text signals alone. The features are (a) injected into the
// prompt and (b) persisted to rules_context for the deterministic rules pass in
// job-status.js. Set OCC_SHARED_SECRET to match the value configured on Cloud Run.
const OCC_URL = (process.env.OCC_URL || '').replace(/\/+$/, ''); // trailing slash trimmed
const OCC_SHARED_SECRET = process.env.OCC_SHARED_SECRET || '';
const OCC_TIMEOUT_MS = parseInt(process.env.OCC_TIMEOUT_MS || '20000', 10); // bounded < Vercel's 60s

// Call the OCC service for one STEP buffer. Returns the features object or null.
// Never throws — geometry enrichment must never block an upload.
async function probeOccGeometry(buffer, filename) {
  if (!OCC_URL) return null;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), OCC_TIMEOUT_MS);
  try {
    const fd = new FormData();
    fd.append('file', new Blob([buffer]), filename || 'part.step');
    const headers = {};
    if (OCC_SHARED_SECRET) headers['X-OCC-Token'] = OCC_SHARED_SECRET;
    const resp = await fetch(`${OCC_URL}/probe`, {
      method: 'POST',
      body: fd,
      headers,
      signal: controller.signal,
    });
    if (!resp.ok) {
      console.warn(`OCC probe ${filename}: HTTP ${resp.status} — proceeding without OCC geometry.`);
      return null;
    }
    const json = await resp.json();
    return json && json.ok ? json : null;
  } catch (e) {
    console.warn(`OCC probe ${filename} failed (${e?.name || 'error'}) — proceeding without OCC geometry.`);
    return null;
  } finally {
    clearTimeout(timer);
  }
}

// Render OCC features as a prompt block: gives the model real geometry AND tells
// it which deterministic findings it MUST surface as flags.
function buildOccPromptBlock(occ, filename) {
  if (!occ || !occ.ok) return null;
  const L = [];
  L.push(`=== DETERMINISTIC GEOMETRY (OpenCascade topology) for "${filename}" ===`);
  L.push('Computed from the actual B-rep — you cannot see STEP geometry yourself, so treat these as measured facts.');
  if (Array.isArray(occ.bbox_mm)) {
    const inch = occ.bbox_mm.map((v) => +(v / 25.4).toFixed(3));
    L.push(`Bounding box: ${occ.bbox_mm.join(' × ')} mm (${inch.join(' × ')} in)${occ.is_assembly ? ' — ASSEMBLY (whole product)' : ''}; declared unit: ${occ.native_unit_declared || 'unknown'}.`);
  }
  if (occ.volume_mm3 != null) L.push(`Volume: ${occ.volume_mm3} mm³; material removal ≈ ${(occ.removal_ratio != null ? Math.round(occ.removal_ratio * 100) + '%' : 'n/a')} of bounding stock (approx).`);
  if (occ.faces && occ.faces.total) {
    const f = occ.faces;
    L.push(`Faces: ${f.total} total (planar ${f.planar}, cylindrical ${f.cylindrical}, conical ${f.conical}, toroidal ${f.toroidal}, spherical ${f.spherical}, freeform ${f.freeform}); ${occ.distinct_setup_normals ?? '?'} distinct face orientations (rough setup-count proxy).`);
  }
  if (Array.isArray(occ.holes) && occ.holes.length) {
    const top = occ.holes.slice(0, 8).map((h) => `Ø${h.diameter_mm}×${h.depth_mm}mm (${h.depth_to_dia}:1, ${h.kind})`).join('; ');
    L.push(`Holes/bores (${occ.hole_count} internal): ${top}. Deepest internal depth:diameter = ${occ.max_depth_to_dia ?? 'n/a'}.`);
  }
  if (occ.min_wall_mm != null) L.push(`Estimated min wall: ~${occ.min_wall_mm} mm (APPROXIMATE — sampled).`);
  if (Array.isArray(occ.warnings) && occ.warnings.length) L.push(`Geometry warnings: ${occ.warnings.join(' | ')}`);
  L.push('[YOU MUST] Surface these as flags where they apply: a depth:diameter ≥ ~5 hole (deep-hole drilling — cost/lead-time); a min wall under ~1.5 mm (possible thin wall — verify, distortion risk); material removal ≳ 70% (cycle-time/material cost); a unit mislabel/scale warning (AMBER, confirm units — scrap-the-job risk); an assembly (clarify which part is quoted). These are deterministic — corroborate, do not override them.');
  return L.join('\n');
}

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

// ===== SOLIDWORKS (.sldprt/.sldasm) — CFB / OLE EXTRACTION (v1.9) =====
// SolidWorks files are Microsoft OLE Compound File Binary containers. They
// embed (a) an image preview thumbnail and (b) plaintext custom-property /
// summary streams (material, finish, part number, description, config notes).
// We unpack with the `cfb` library (add "cfb" to package.json dependencies),
// grab any PNG/JPEG preview to feed Claude's vision endpoint, and pull the
// readable property strings. STRICTLY ADDITIVE: any failure falls back to the
// existing ASCII-string extractor, so this can never break the current path.
//
// Returns { text, preview } where preview is { media, data(base64) } or null.
async function extractNativeCAD(buffer, filename, ext) {
  if (ext === 'sldprt' || ext === 'sldasm') {
    try {
      const CFB = await import('cfb');
      const container = CFB.read(buffer, { type: 'buffer' });
      const entries = container.FileIndex || [];
      let preview = null;
      const propStrings = [];

      for (const e of entries) {
        const nm = (e.name || '').toLowerCase();
        const bytes = e.content;
        if (!bytes || !bytes.length) continue;

        // (a) Embedded preview image — scan preview-ish streams for PNG/JPEG magic bytes
        if (!preview && /preview|thumbnail|png|jpe?g|bitmap|image/.test(nm)) {
          const isPng = bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4E && bytes[3] === 0x47;
          const isJpg = bytes[0] === 0xFF && bytes[1] === 0xD8 && bytes[2] === 0xFF;
          if (isPng || isJpg) {
            preview = { media: isPng ? 'image/png' : 'image/jpeg', data: Buffer.from(bytes).toString('base64') };
          }
        }

        // (b) Property / summary streams — extract readable text
        if (/summaryinformation|documentsummary|properties|custom|swdoc|configuration/.test(nm)) {
          const hits = Buffer.from(bytes).toString('latin1').match(/[\x20-\x7E]{4,120}/g) || [];
          propStrings.push(...hits);
        }
      }

      const uniqueProps = [...new Set(propStrings)]
        .filter(s => /[A-Za-z]{3,}/.test(s) && !/^[\x21-\x40\x5B-\x60\x7B-\x7E]+$/.test(s))
        .slice(0, 50);

      const sizeMB = (buffer.length / 1024 / 1024).toFixed(2);
      let text = `Native CAD file "${filename}" (${ext.toUpperCase()}, ${sizeMB} MB) — unpacked via OLE compound-file reader.\n\n`;
      if (uniqueProps.length) {
        text += `Custom-property / metadata streams (commonly hold material spec, finish, part number, description, configuration):\n${uniqueProps.join('\n')}\n\n`;
      } else {
        text += `No readable custom-property streams were found inside the file.\n\n`;
      }
      if (preview) {
        text += `An embedded preview thumbnail was extracted and is attached below as an image for rough visual inspection.\n\n`;
      }
      text += `--- ANALYZER GUIDANCE ---\n`;
      text += `The full 3D geometry, exact dimensions, and GD&T cannot be parsed from binary CAD. `;
      if (preview) {
        text += `The attached thumbnail is low-resolution and NOT dimensionally reliable — use it only for a coarse visual sanity check (general shape, obvious features). `;
      }
      text += `If this RFQ package does NOT include a companion PDF drawing, surface a clarification flag that visual confirmation of features, GD&T, surface finish, and tolerances is not possible from binary CAD alone, and recommend the customer attach a PDF drawing.`;

      return { text, preview };
    } catch (e) {
      console.log(`CFB parse failed for ${filename}; falling back to ASCII extraction: ${e?.message}`);
      // fall through
    }
  }

  // Fallback for all other binary CAD (.ipt/.iam/.catpart/.dwg/.x_b/etc.) or CFB failure
  return { text: extractBinaryMetadata(buffer, filename, ext), preview: null };
}

// ===== STANDARDS KNOWLEDGE BASE (v1.8) =====
// Extracts referenced spec numbers from RFQ text, looks them up in the
// standards_kb table, enriches any that are uncached (Claude Haiku 4.5 +
// web search, via /api/enrich-standard), and injects authoritative
// summaries into the prompt. Public-standard hallucination guard.
//
// Spec extraction is text-based: it scans the pdf-parse output + email body.
// Specs that appear ONLY in a scanned/image-only drawing (no extractable
// text) are caught by the model's Rule #9 logic instead, and will be
// cached the first time they appear in a text-extractable submission.

const SPEC_REGEX = new RegExp([
  'AMS-QQ-[A-Z]-\\d+',                              // AMS-QQ-P-416
  'QQ-[A-Z]-\\d+',                                  // QQ-P-416
  'SAE[\\s-]?AMS[\\s-]?(?:[A-Z]-)?\\d+(?:/\\d+)?[A-Z]?', // SAE-AMS-2430
  'SAE[\\s-]?J\\s?\\d+',                            // SAE J429
  'SAE[\\s-]?AS\\s?\\d+',                           // SAE AS33540
  'MIL-[A-Z]{1,4}-\\d+[A-Z]?(?:/\\d+)?',           // MIL-DTL-5541, MIL-A-8625
  'AMS\\s?\\d{3,4}(?:/\\d+)?[A-Z]?',               // AMS 2700, AMS2759/3
  'ASTM[\\s-]?[A-Z]\\s?\\d+[A-Z]?M?',             // ASTM A36, ASTM-B117
  'ASME[\\s-]?[A-Z]\\d+(?:\\.\\d+)*[A-Z]?',       // ASME Y14.5, ASME B46.1
  'AWS[\\s-]?[A-Z]\\d+\\.\\d+',                    // AWS D1.1
  'AS\\s?9\\d{3}[A-Z]?',                            // AS9100, AS9102D
  'AS\\s?\\d{3,5}',                                 // AS568, AS478
  'NAS\\s?\\d+',                                    // NAS410
  'AC7\\d{3}',                                      // AC7102
  'ISO\\s?-?\\s?\\d{3,5}(?:-\\d+)?',              // ISO 9001, ISO 2768-1
  'IATF\\s?\\d+',                                   // IATF 16949
  'FED-STD-\\d+',                                   // FED-STD-595
].join('|'), 'gi');

const MAX_SPECS_PER_RFQ = 5;

// Candidate canonical forms for DB lookup (handles space/hyphen variance)
function specCandidates(raw) {
  let s = raw.toUpperCase().trim().replace(/:\d{4}\b/, '');
  const noSpace = s.replace(/\s+/g, '');
  const hyphen = s.replace(/\s+/g, '-');
  const cands = new Set([noSpace, hyphen, s]);
  const revStripped = noSpace.replace(/([0-9])[A-Z]$/, '$1');
  if (revStripped !== noSpace) cands.add(revStripped);
  if (/^ISO/i.test(s)) {
    cands.add(hyphen.replace(/-\d+$/, ''));
    cands.add(noSpace.replace(/-\d+$/, ''));
  }
  return [...cands];
}

// Canonical storage form for a NEW spec not in the seed (prefer hyphenated)
function canonicalSpecForm(raw) {
  return raw.toUpperCase().trim().replace(/:\d{4}\b/, '').replace(/\s+/g, '-');
}

function extractSpecs(text) {
  if (!text) return [];
  const matches = text.match(SPEC_REGEX) || [];
  const seen = new Set();
  const out = [];
  for (const m of matches) {
    const cands = specCandidates(m);
    if (!seen.has(cands[0])) {
      seen.add(cands[0]);
      out.push({ raw: m, candidates: cands });
      if (out.length >= MAX_SPECS_PER_RFQ) break;
    }
  }
  return out;
}

// Look up extracted specs, enrich uncached ones (bounded wait — batch takes
// minutes downstream so ~20s here is acceptable and well under the 60s limit),
// and return the rows that have a usable summary.
async function resolveStandards(extracted, originUrl) {
  if (!extracted.length) return { cached: [], pending: [] };

  // Flatten all candidate forms for a single IN query
  const allCandidates = [...new Set(extracted.flatMap(e => e.candidates))];
  let rows = [];
  try {
    const { data } = await supabase
      .from('standards_kb')
      .select('spec_number, title, source_type, summary, enrichment_status')
      .in('spec_number', allCandidates);
    rows = data || [];
  } catch (e) {
    console.error('standards_kb lookup failed:', e?.message);
    return { cached: [], pending: [] };
  }

  const byKey = new Map(rows.map(r => [r.spec_number, r]));
  const cached = [];
  const toEnrich = [];   // canonical spec strings to call enrich on

  for (const item of extracted) {
    const matchKey = item.candidates.find(c => byKey.has(c));
    const row = matchKey ? byKey.get(matchKey) : null;
    if (row && row.enrichment_status === 'done' && row.summary) {
      cached.push(row);
      supabase.rpc('bump_standard_hit', { p_spec_number: row.spec_number }).then(() => {}).catch(() => {});
    } else {
      // Enrich under the matched key if it exists, else the canonical new form
      toEnrich.push(matchKey || canonicalSpecForm(item.raw));
    }
  }

  // Bounded parallel enrichment. Each fetch spins up its own serverless
  // invocation that completes independently even if we stop waiting — so
  // anything not ready in time still caches for the next RFQ.
  if (toEnrich.length) {
    const ENRICH_TIMEOUT_MS = 20000;
    const enrichCalls = toEnrich.map(spec =>
      fetch(`${originUrl}/api/enrich-standard`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ spec_number: spec }),
      }).then(r => r.json()).catch(() => null)
    );
    await Promise.race([
      Promise.allSettled(enrichCalls),
      new Promise(resolve => setTimeout(resolve, ENRICH_TIMEOUT_MS)),
    ]);

    // Re-query to pick up anything that finished within the window
    try {
      const { data: fresh } = await supabase
        .from('standards_kb')
        .select('spec_number, title, source_type, summary, enrichment_status')
        .in('spec_number', allCandidates);
      const freshDone = (fresh || []).filter(
        r => r.enrichment_status === 'done' && r.summary && !cached.some(c => c.spec_number === r.spec_number)
      );
      cached.push(...freshDone);
    } catch (e) { /* non-critical */ }
  }

  // Anything still not cached after the wait → list as pending for the prompt note
  const cachedKeys = new Set(cached.map(c => c.spec_number));
  const pending = [];
  for (const item of extracted) {
    const matchKey = item.candidates.find(c => cachedKeys.has(c));
    if (!matchKey) pending.push(item.raw.toUpperCase());
  }

  return { cached, pending: [...new Set(pending)] };
}

// Build the STANDARDS CONTEXT prompt block from resolved rows.
function buildStandardsBlock(cached, pending) {
  if (!cached.length && !pending.length) return '';

  const lines = [
    '=== STANDARDS CONTEXT (QuoteScout knowledge base) ===',
    'The following are authoritative summaries for standards referenced in this RFQ. Use these as the reference for these specific specs INSTEAD of your own training data, while still applying the "verify against current revision" caveat. For any spec NOT listed here, fall back to your normal Rule #9 public/customer-internal logic.',
    '',
  ];

  for (const row of cached) {
    const s = row.summary || {};
    lines.push(`[${row.spec_number}] ${row.title || ''}`.trim());
    if (s.scope) lines.push(`  Scope: ${s.scope}`);
    if (s.key_requirements) lines.push(`  Key requirements: ${s.key_requirements}`);
    if (s.inspection_reqs) lines.push(`  Inspection: ${s.inspection_reqs}`);
    if (s.process_notes) lines.push(`  Process notes: ${s.process_notes}`);
    if (s.common_pitfalls) lines.push(`  PITFALLS shops miss: ${s.common_pitfalls}`);
    if (s.current_revision_hint) lines.push(`  Revision: ${s.current_revision_hint}`);
    lines.push('');
  }

  if (pending.length) {
    lines.push(`Referenced but not yet in the KB (apply Rule #9 normally): ${pending.join(', ')}`);
    lines.push('');
  }

  lines.push('=== END STANDARDS CONTEXT ===');
  return lines.join('\n');
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
  "verdict": "READY_TO_QUOTE" | "QUOTE_WITH_ASSUMPTIONS" | "CLARIFICATIONS_REQUIRED" | "RECOMMEND_NO_BID",
  "verdict_reason": "ONE sentence explaining the verdict. Direct, no hedging. Example: 'Six referenced customer standards (IE-series, CPPI, CMR) are not supplied — pricing requires their content.' or 'No blocking unknowns identified; ready to quote against the provided package.'",
  "summary": "Executive summary, 3-5 sentences, written FOR AN ESTIMATOR who has 30 seconds. Lead with the bottom line, then the 2-3 most important findings, then what's driving cost. NO 'Go/No-Bid' language. NO 'safe to bid'. Concrete and specific.",
  "customer_clarifications": [
    {
      "question": "ONE short, direct question to ask the customer (under 25 words). Phrase it as the estimator would ask it on the phone, not as a legal interrogatory.",
      "priority": "BLOCKING" | "IMPORTANT" | "NICE_TO_HAVE",
      "why": "ONE short sentence on why this matters (under 25 words). Optional but recommended."
    }
  ],
  "flags": [
    {
      "severity": "RED" | "AMBER" | "YELLOW" | "PURPLE",
      "category": "compliance" | "sequence" | "dimensional" | "outside_service" | "inspection" | "material" | "cost" | "clarification",
      "title": "Short title (under 80 chars). What the issue IS, not what to do.",
      "description": "1-2 sentences. The technical reasoning. WHY this is a risk. NO action language here.",
      "recommendedAction": "Imperative, 1 sentence under 25 words. Start with a verb. Example: 'Confirm with customer whether revision X is the released production revision.'",
      "impact": "Short impact chip, 3-7 words. Examples: 'Lead-time risk · 2-6 wks' / '+4-8 hrs CMM time' / 'Cost driver · raw material' / 'Scope unclear' / 'Documentation only'.",
      "confidence": 0-100,
      "location": "page or section reference (e.g., 'page 3, note 4', 'title block', 'spec sheet section 2.1')",
      "estimatedCostRange": "optional cost range like '$2,000-$5,000' — only if you can quantify it"
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
  }
}

CRITICAL OUTPUT QUALITY RULES (these are what make the report ACTIONABLE vs ACADEMIC):

1. CONSOLIDATE CLARIFICATIONS. If 8 separate flags all say "obtain X from customer," consolidate those 8 asks into 8 entries in customer_clarifications. The flag descriptions should NOT re-state the question; the flags exist to explain the technical why, and the clarifications list exists to give the estimator a phone-ready checklist.

2. ACTION-FIRST FLAGS. Each flag's recommendedAction must be SHORT and IMPERATIVE. "Obtain IE2122 from customer and review all surface texture requirements before pricing" is 14 words and OK. "It is necessary to obtain the surface texture document from the customer at some point" is wrong: passive, vague, weak verb.

3. IMPACT IS A CHIP, NOT A PARAGRAPH. The impact field should fit on one line. Use telegraphic style: "+ 6-12 hrs inspection", "Cost driver · large blank stock", "Pre-quote blocker", "Documentation only", "Scope unclear".

4. SET THE VERDICT HONESTLY.
   - READY_TO_QUOTE: 0 RED, ≤ 2 AMBER, no BLOCKING clarifications. Estimator can price now.
   - QUOTE_WITH_ASSUMPTIONS: minor unknowns the estimator can document and price around.
   - CLARIFICATIONS_REQUIRED: BLOCKING clarifications exist. Must get customer answers before responsibly quoting. THIS IS THE DEFAULT FOR MOST INDUSTRIAL RFQs.
   - RECOMMEND_NO_BID: capability gaps (cert, equipment, certification), confidentiality issues, or scope so unclear pricing would be guessing. Be willing to say this when warranted.

5. PRIORITY ASSIGNMENT for clarifications:
   - BLOCKING: cannot responsibly quote without the answer (material spec, missing referenced standards, classification clearance, scope definition).
   - IMPORTANT: would meaningfully change the price (inspection scope, marking method, lead-time constraints).
   - NICE_TO_HAVE: helpful context but the estimator could quote against assumptions.

6. NO REDUNDANCY. If a flag's "recommendedAction" is just "ask customer Q," and Q is already in customer_clarifications, the recommendedAction in the flag should reference the clarification list instead: e.g., "See Clarification #3 in the customer questions list." This keeps the flag focused on technical reasoning.

7. DOLLARIZE COST IMPACT WHERE REASONABLE. The estimatedCostRange field should be populated whenever you can do real math, not only when explicitly asked. Examples of when to dollarize:
   - CMM inspection time: estimate hours, multiply by a $75-$150/hr inspection rate (or the shop's stated rate if provided), give a range.
   - Setup-driven cost on low-quantity runs: setup hours × shop rate ÷ EAU.
   - Scrap risk from tight tolerances: estimate scrap rate × material cost × quantity.
   - Outside-service cost: rough $/lb or $/part for heat treat, plating, anodize.
   - Lead-time-driven cost: expedite premiums (typically 15-40%).
   Format: "$X-$Y" or "$X-$Y per part" or "$X-$Y per lot of N". If you cannot quantify reasonably, omit the field — do not guess wildly. But when the math IS reasonable, include it. Estimators value $-anchored impact 10x more than vague "this will be expensive" language.

8. GAP ANALYSIS WHEN SHOP CONTEXT IS PROVIDED. If a SHOP CAPABILITY PROFILE block is present in the input, your flags must reference the shop's actual capabilities. Specifically:
   - Replace "Confirm NADCAP capability" with EITHER "Shop holds NADCAP heat-treat per profile — confirmed in scope" OR "Shop does NOT currently hold NADCAP per profile — this is a capability gap. Either pursue accreditation, sub-tier the work, or no-bid."
   - Replace generic CMM warnings with profile-aware ones: "Part envelope (Ø1254 mm) exceeds the shop's stated CMM travel (700×1000×600 mm) — large-platform or portable-arm CMM required, or sub-tier inspection."
   - Replace generic shop-rate references with the actual stated rate where given.
   - A flag that's purely generic when shop_profile context contradicts it (e.g., flagging "verify AS9100" when the shop says it holds AS9100) is a quality failure. Use the context.

9. STANDARDS HANDLING — distinguish PUBLIC standards (you have training data) from CUSTOMER-INTERNAL standards (you DO NOT).

PUBLIC-KNOWLEDGE STANDARDS — you may cite typical scope/requirements, but always add "verify against current revision since standards update periodically":
- AMS specs (AMS 2750 pyrometry, AMS 2404 EN plating, AMS-QQ-P-416, AMS-S-8949, etc.)
- MIL specs (MIL-A-8625 anodize, MIL-PRF-23377 primer, MIL-DTL-5541 chemfilm, MIL-STD-2073, etc.)
- ASTM (A36, A572, A240, B117 salt spray, E18 hardness, E8 tensile, F1941 plating, etc.)
- ASME (Y14.5 GD&T, B&PV codes, B89.4.X CMM accuracy, B46.1 surface texture, etc.)
- ISO (9001, 13485, 14001, 14644-1 cleanrooms, 17025, 27001, etc.)
- IATF 16949, AS9100D, AS9102, AS9120, AS6081, AS5553
- NADCAP audit criteria (AC7004, AC7102, AC7110 heat treat, AC7114 NDT, AC7116 welding, AC7117 chem processing, etc.)
- API specs (Q1, Q2, 5L, 6A, 7-1, etc.)
- ANSI, IEC, NACE MR0175/MR0103, NIST 800-171 / 800-53, NFPA, NSF/ANSI 51/61
- FAA regs, FDA 21 CFR, OSHA standards, DOT/DFARS clauses (252.204-7012, etc.)
- Material specs: UNS designations, ASTM grades, AMS material specs

CUSTOMER-INTERNAL STANDARDS — you have NO training data on the content. Never invent requirements. Examples:
- Caterpillar: IE-series (IE0170, IE2122, IE0507M, IE0421), CPPI, CMR, Y200, Y-series
- John Deere: DR, DS, JDM, JDV, "John Deere Production Pricing" terms
- Boeing: BAC, D6-XXXXX series, BSS, BPS
- GE: P-series (P29, P39, P50), S-series
- Ford: ES-XXXXX, WSS, WSK
- Honda: HES
- Toyota / Lexus: TS, TSM
- Lockheed: LM, STP
- Generic customer process codes: anything that's clearly an internal designation (alphanumeric like "CPPI", "CMR", "Y200", "DR-1234")

For customer-internal standards: explicitly state "[STANDARD] is a customer-internal specification — AI has no training data on its scope or requirements." Raise as a BLOCKING customer_clarification asking the customer to send the spec. NEVER speculate on the requirements of a customer-internal standard. Never write "this likely requires…" — only "this exists in the package and the AI cannot verify its content."

This rule applies even if the customer-internal standard's name LOOKS familiar (e.g., "IE2122" sounds vaguely like a public IEC spec — it is not, it is Caterpillar internal).

10. MATERIAL EXCLUSIONS ARE A HARD STOP. If the SHOP CAPABILITY PROFILE lists material exclusions (a "Hard No" / "material_exclusions" / "we do not cut" list) AND the RFQ calls for a material on that list, set verdict=RECOMMEND_NO_BID and raise a RED flag with category "material" titled "Material on shop exclusion list". State plainly which excluded material the RFQ requires. Do NOT soften this into "verify" language — the shop has already decided. Recommended action: "Decline or sub-tier — [material] is on the shop's exclusion list."

11. LEAD-TIME REALITY CHECK. If the SHOP CAPABILITY PROFILE provides a standard lead time and/or current backlog, AND the RFQ (drawing notes, PO, or email body) states a required delivery date or turnaround, compare them. If the requested window is shorter than the shop's lead time plus current backlog, raise a BLOCKING customer_clarification and an AMBER flag (category "clarification") noting the specific mismatch — e.g., "RFQ requests 3-week delivery; shop standard lead time is 8 weeks with ~4 weeks current backlog." Suggested clarification: "Can the delivery date flex, or is expedite pricing acceptable?" If no delivery date is stated in the RFQ, do not invent one — instead add a NICE_TO_HAVE clarification asking for the required delivery date.

12. PREFER THE STANDARDS CONTEXT BLOCK. If a "STANDARDS CONTEXT" block is present in the input, treat its summaries as the authoritative reference for those specific public standards (still note the revision caveat). When a standard appears both in that block and in your training knowledge, the block wins. This block exists to reduce the chance of citing a wrong or outdated requirement for a public spec.

13. SETUP-AMORTIZATION AT LOW QUANTITY (the highest-value cost flag). Setup is usually the dominant per-piece cost on small lots. When the order quantity or annual usage is small (roughly 10 pieces or fewer) AND the part implies long or multiple setups (multi-operation CNC, several work centers, multiple fixtures or orientations), raise a YELLOW flag with category "cost" titled to name the driver, e.g. "Setup-dominated cost at low quantity". In the description, explain that fixed setup hours spread over few pieces push per-piece cost far above the raw cut time, so a price built from cycle time alone will under-recover setup. recommendedAction: confirm the order quantity and whether setup is amortized across the lot or quoted as a one-time NRE line. Only if a shop rate AND a defensible setup-hours figure are available may you populate estimatedCostRange (setup hours times shop rate divided by quantity); otherwise omit it. Never state a price or a markup.

14. WORK-CENTER / SETUP COUNT. Every distinct in-house work center in the routing is its own setup, queue, and material-handling step, not only outside-service hand-offs. Infer the likely sequence of in-house work centers from the features (for example saw or cutoff, CNC mill, CNC turn, deburr, grind, inspection). When three or more distinct in-house setups are implied, raise a YELLOW flag with category "cost" noting the count of distinct setups as a cost and lead-time driver. Keep it a producibility signal, not a price.

15. ONE-TIME (NRE) CHECKLIST. Many real cost escapes are one-time charges the per-piece price never recovers. Check explicitly for, and surface any that the package implies but does not call out: CNC programming and first setup, dedicated workholding (soft jaws, fixtures, tombstones), special or form tooling, custom gaging, PPAP or PSW, and First Article (FAIR or AS9102). Consolidate these as customer_clarifications (priority IMPORTANT, or BLOCKING when pricing truly cannot proceed without the answer), each phrased as: confirm whether this one-time item is in scope and quoted as a separate NRE charge. Where an NRE item is clearly required (for example a brand-new CNC part with no existing program), you may also raise a YELLOW flag with category "cost".

16. PPAP AND FAIR BY LEVEL. PPAP cost and lead time scale heavily with the level. When PPAP or PSW is referenced, do not treat it generically: raise an AMBER flag with category "compliance" and a clarification asking the customer to confirm the PPAP level (1 through 5) and submission level, because documentation effort and timeline depend on it. Treat AS9102 FAIR as first-article documentation and flag its lead-time impact (typically several business days before production can ramp).

17. HP AND ENVELOPE FEASIBILITY AGAINST THE SHOP PROFILE. When a SHOP CAPABILITY PROFILE is present and lists equipment or a size envelope, sanity-check the work against it. If a required operation implies spindle horsepower, torque, table or swing size, bar capacity, or part weight beyond the shop machines listed, raise an AMBER flag with category "compliance" naming the specific mismatch (for example: roughing this material at this volume implies more spindle HP than the listed machines provide, or the part envelope exceeds the largest listed machine travel). If no profile is present, fall back to a PURPLE verify flag rather than assuming the shop can hold it.

18. MATERIAL UTILIZATION AND STOCK FORM. Stock form and yield drive material cost as much as grade does. Check whether the part geometry fits its likely stock form efficiently: bar or plate with high facing and cutoff loss, low pieces-per-bar yield, or a near-net shape (forging or casting) that would change the buy. When utilization looks poor or the stock form is ambiguous, raise a YELLOW flag with category "material", and if relevant a clarification on whether the customer supplies material or specifies a particular stock form. Do not quote a material price.

19. STANDARDIZED NO-QUOTE REASONS. When you set verdict to RECOMMEND_NO_BID, make verdict_reason cite the specific standard reason an estimator would use, drawn from this list: not equipped for a required operation; not suitable for present equipment; part too large for equipment; part too small for equipment; required certification or accreditation not held; export-controlled or confidentiality issue; or scope too unclear to quote responsibly. State plainly which reason applies and tie it to the SHOP CAPABILITY PROFILE when one is present.

If a flag is below 70% confidence, ALWAYS mark it PURPLE regardless of category.
If you cannot extract enough information to analyze, return {"verdict": "CLARIFICATIONS_REQUIRED", "verdict_reason": "Insufficient information in the package.", "summary": "Insufficient information in document. Please verify the file contains a complete RFQ.", "customer_clarifications": [], "flags": [], "dimensions": [], "flagCounts": {"red":0,"amber":0,"yellow":0,"purple":0}}.

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
    // ----- 1. Parse the JSON request (Storage refs + OCR text, not file bytes) -----
    let body = req.body;
    if (typeof body === 'string') { try { body = JSON.parse(body); } catch { body = {}; } }
    body = body || {};

    const email = (body.email || '').toString().trim().toLowerCase();
    const companyName = (body.company_name || '').toString().trim();
    const emailBodyRaw = (body.email_body || '').toString().trim();
    // Cap at 30KB to keep token cost bounded
    const emailBody = emailBodyRaw.slice(0, 30000);
    // Opt-in email delivery — checkbox on upload form, defaults to false.
    // Page-based URL is the primary delivery mechanism; email is optional.
    const wantsEmail = (body.wants_email || '').toString().toLowerCase() === 'true';
    // Optional shop capability profile — flips the AI from generic risk-listing
    // to gap analysis (capability gaps, equipment fit, cert deltas, $-impact vs shop rate).
    const shopProfileRaw = (body.shop_profile || '').toString().trim();
    const shopProfile = shopProfileRaw.slice(0, 20000);

    // Files are now STORAGE REFERENCES, not bytes: [{ path, name, type, size }].
    // The browser uploaded the bytes straight to Supabase Storage via signed URLs
    // (see /api/upload-url); each is downloaded and deleted in the loop below.
    const fileRefs = Array.isArray(body.files) ? body.files : [];

    // Labels arrive as a parallel array — same order as files.
    const labels = Array.isArray(body.labels) ? body.labels : [];

    // Client-side OCR text arrives as a parallel array too — same order as files,
    // empty string for non-image files. app.html runs Tesseract.js in the browser
    // on scanned/image drawings (the image itself still uploads for vision); this
    // text is used for the ITAR pre-screen, standards detection, and as a
    // supplementary cross-reference layer in the prompt.
    const ocrTexts = Array.isArray(body.ocr) ? body.ocr : [];

    if (!email) {
      return res.status(400).json({ error: 'Email is required.' });
    }
    if (fileRefs.length === 0 && !emailBody) {
      return res.status(400).json({ error: 'Provide at least one file or paste the RFQ email/notes (minimum ~30 characters).' });
    }
    if (fileRefs.length > 8) {
      return res.status(400).json({ error: 'Maximum 8 files per RFQ package.' });
    }

    // ----- 1.5 NDA ENFORCEMENT (server-side — the real gate) -----
    // The browser redirect in app.html guides honest users to sign first, but a
    // browser gate is bypassable (faked localStorage, or a direct POST straight
    // to this endpoint). THIS is the unbypassable enforcement: refuse to process
    // any upload from an email that has no nda_acceptances record. nda.js writes
    // that record (email stored lowercased) the moment a user signs the mutual
    // NDA — and we compare against the same lowercased `email` parsed above.
    // Placed before the file-read loop so a non-signer is rejected with zero work.
    try {
      // Uses the service-role client: nda_acceptances is RLS-protected with no
      // anon SELECT policy, so the public client would always come back empty
      // (which is what caused the "please sign the NDA" loop). The service-role
      // client bypasses RLS and reads the real row.
      const { data: ndaRows, error: ndaErr } = await supabaseAdmin
        .from('nda_acceptances')
        .select('email')
        .eq('email', email)
        .limit(1);

      if (ndaErr) {
        // GENUINE query error (NOT "no match found"). Don't punish a legitimate
        // signed customer for a transient DB blip — log it and let them through.
        // If Supabase were truly down, the job insert further below fails anyway.
        console.error('NDA verification query error (allowing through):', ndaErr.message);
      } else if (!ndaRows || ndaRows.length === 0) {
        // No acceptance on record for this email → block the upload outright.
        return res.status(403).json({
          error: 'Please sign the mutual NDA before uploading. It protects both sides — sign it once and your upload will go straight through.',
          nda_required: true,
        });
      }
    } catch (e) {
      console.error('NDA verification threw (allowing through):', e?.message);
    }

    // ----- 1.6 ABUSE / COST THROTTLE (protects against runaway Anthropic spend) -----
    // Layered, cheapest checks first. NONE of these replaces the HARD monthly spend
    // cap you set in the Anthropic Console — that cap is the only thing that makes a
    // catastrophic bill physically impossible. These stop casual abuse, scripts, and
    // accidental retry-loops from ever getting close to it. All three constants are
    // one-line edits. Each rejection is a 429 so the frontend can show "try later".
    const reqIp = (req.headers['x-forwarded-for'] || '').toString().split(',')[0].trim() || 'unknown';
    const DAILY_GLOBAL_CAP = 50;   // total analyses/day across ALL users (site-wide circuit breaker)
    const PER_EMAIL_DAILY  = 5;    // analyses/day per signed email
    const PER_IP_DAILY     = 8;    // analyses/day per originating IP
    try {
      const since = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();

      // (a) Site-wide daily ceiling — the circuit breaker (atomic counter in Supabase).
      const { data: capExceeded } = await supabase.rpc('analysis_cap_exceeded', { p_cap: DAILY_GLOBAL_CAP });
      if (capExceeded === true) {
        return res.status(429).json({
          error: 'QuoteScout has reached its daily analysis capacity. Please try again tomorrow.',
          rate_limited: true,
        });
      }

      // (b) per-email and (c) per-IP counts over the trailing 24h.
      const [emailRes, ipRes] = await Promise.all([
        supabase.from('analysis_jobs').select('job_id', { count: 'exact', head: true })
          .eq('user_email', email).gte('submitted_at', since),
        supabase.from('analysis_jobs').select('job_id', { count: 'exact', head: true })
          .eq('ip_address', reqIp).gte('submitted_at', since),
      ]);
      if ((emailRes.count || 0) >= PER_EMAIL_DAILY) {
        return res.status(429).json({
          error: `Daily limit reached for this account (${PER_EMAIL_DAILY} analyses/day during beta). Try again tomorrow, or reply to a report email to request a higher limit.`,
          rate_limited: true,
        });
      }
      if ((ipRes.count || 0) >= PER_IP_DAILY) {
        return res.status(429).json({
          error: 'Daily analysis limit reached from your network. Please try again tomorrow.',
          rate_limited: true,
        });
      }
    } catch (e) {
      // A throttle-check failure must NOT block legitimate users; the Anthropic spend
      // cap remains the hard ceiling if these checks ever error out.
      console.error('Rate-limit check error (allowing through):', e?.message);
    }

    // ----- 2. Read each file into memory, validate, run text pre-extraction -----
    let totalSize = 0;
    let totalPages = 0;

    for (let i = 0; i < fileRefs.length; i++) {
      const f = fileRefs[i] || {};
      const filename = f.name || `file-${i + 1}`;
      const classification = classifyFile(filename, f.type);

      if (classification.kind === 'unknown') {
        return res.status(400).json({
          error: `"${filename}" — file type ".${classification.ext}" not recognized. QuoteScout accepts PDF, images (PNG/JPG/etc.), DXF, STEP/STP, IGES/IGS, STL/OBJ/3MF, Parasolid, SolidWorks, Inventor, Creo, CATIA, AutoCAD DWG, Fusion 360, G-code, BOM spreadsheets, and most common RFQ formats.`,
        });
      }

      // Pull the bytes from Storage, then DELETE the object immediately — once the
      // buffer is in memory we never need the stored copy again, so nothing lingers.
      // The delete runs in `finally`, so it happens whether the download succeeds or
      // fails; an abandoned/failed object is also swept later by /api/cleanup-uploads.
      let buffer;
      try {
        buffer = await downloadFromStorage(f.path);
      } catch (dlErr) {
        console.error('storage download failed:', f.path, dlErr?.message);
        return res.status(502).json({ error: `Could not retrieve "${filename}" from storage — please re-upload and try again.` });
      } finally {
        try { await supabaseAdmin.storage.from(RFQ_BUCKET).remove([f.path]); }
        catch (delErr) { console.error('storage delete failed (cleanup cron will sweep):', f.path, delErr?.message); }
      }

      // Build the appropriate processing record for each file type
      const record = {
        buffer,
        name: filename,
        label: labels[i] || '',
        size: Number(f.size) || buffer.length,
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
        // For STEP files, additionally run the deterministic geometry probe and
        // attach a prompt-ready signals block (the model can't see STEP geometry
        // on its own). Non-fatal: a parse failure just means no signals block.
        if (classification.ext === 'step' || classification.ext === 'stp') {
          try {
            const signals = extractStepSignals(buffer.toString('latin1'), filename);
            if (signals && signals.ok) {
              record.stepSignals = signals;
              record.stepSummary = buildStepSummary(signals);
            }
          } catch (e) {
            console.error(`step-probe failed for ${filename} (non-fatal):`, e?.message);
          }
          // Stage B: true OCC topology (best-effort; null on timeout/error/disabled)
          record.occ = await probeOccGeometry(buffer, filename);
        }
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
        const nat = await extractNativeCAD(buffer, filename, classification.ext);
        record.extractedText = nat.text;
        record.previewImage = nat.preview; // { media, data } or null
      } else if (classification.kind === 'image') {
        // No server-side text extraction for images — but if the browser ran OCR
        // on this scan, use that text for the ITAR pre-screen and standards scan
        // (and, in content assembly below, as a supplementary text layer). The
        // image itself is still sent for full vision analysis.
        const ocr = (ocrTexts[i] || '').toString().trim();
        if (ocr) {
          record.ocrText = ocr.slice(0, 20000);
          record.extractedText = record.ocrText;
        }
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

    // ----- 3.5 Standards KB: extract referenced specs, resolve summaries -----
    // Scan the extractable text (pdf-parse output + email body) for referenced
    // standards, look them up / enrich them, and build a context block. This
    // runs before content assembly so the block can be injected into the prompt.
    let standardsBlock = '';
    try {
      const textCorpus = [
        emailBody,
        ...pdfBuffers.map(p => p.extractedText || ''),
      ].join('\n');
      const extracted = extractSpecs(textCorpus);
      if (extracted.length) {
        const originUrl = `https://${req.headers.host || 'quotescout.vercel.app'}`;
        const { cached, pending } = await resolveStandards(extracted, originUrl);
        standardsBlock = buildStandardsBlock(cached, pending);
      }
    } catch (e) {
      console.error('Standards resolution failed (non-fatal):', e?.message);
      standardsBlock = '';
    }

    // ----- 4. Build the multi-document content array for Claude -----
    // Pattern: [optional-email-body, text-header-1, document-1, text-header-2, document-2, ..., final-instruction]
    // The text headers tell Claude which document is which (label + filename), enabling
    // cross-document reasoning per the system prompt.
    const content = [];

    // Shop Capability Profile — when provided, the AI does gap analysis
    // (capabilities vs requirements) instead of generic risk-listing.
    // Goes FIRST in the content array because everything else is read
    // against this context.
    if (shopProfile) {
      content.push({
        type: 'text',
        text: `=== SHOP CAPABILITY PROFILE (provided by the estimator's shop) ===\nThis describes the shop's actual capabilities, certifications, equipment envelope, and outside-service vendors. Read it carefully. Your job is GAP ANALYSIS: for each risk you would normally flag generically, frame it against this shop's stated capabilities.\n\nSpecifically:\n- If the RFQ requires a certification the shop HOLDS, do NOT flag it as a capability risk. Mention it as confirmed in scope.\n- If the RFQ requires a certification or process the shop does NOT hold, flag it as a CAPABILITY GAP (severity AMBER or RED depending on importance), and explicitly note "Your shop does not currently hold X".\n- If a feature exceeds the shop's machine envelope, CMM travel, or material handling capacity, flag it as a capability gap with the specific dimension mismatch.\n- If the RFQ requires an outside service (heat treat, plating, anodize, etc.), check whether the shop has an AVL partner for it. If yes, mention it; if no/unclear, flag as AVL gap.\n- If a shop_rate is provided, use it to give DOLLARIZED cost estimates in estimatedCostRange where the math is reasonable (CMM time × rate, setup time × rate, etc.).\n- For materials the shop does NOT typically run, raise a YELLOW flag noting "Material outside typical commodities — verify pricing and availability against vendor history."\n\nThis SHOP CONTEXT applies to every flag you generate.\n\n${shopProfile}\n\n=== END OF SHOP CAPABILITY PROFILE ===\n`,
      });
    }

    // Standards KB context — authoritative summaries for any public specs
    // referenced in the RFQ. Placed high so the model reads it before the docs.
    if (standardsBlock) {
      content.push({ type: 'text', text: standardsBlock });
    }

    // Pasted email body / RFQ notes come next — they typically contain the actual
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
        // Supplementary browser-OCR transcription of this scan, if available.
        // Clearly subordinate to the model's own vision read of the image.
        if (entry.ocrText) {
          content.push({
            type: 'text',
            text: `=== OCR TEXT for "${entry.name}" (auto-transcribed in the user's browser; SUPPLEMENTARY) ===\nThis is an automated OCR transcription of the scanned image above. OCR on engineering drawings is imperfect — GD&T symbols, rotated callouts, stacked tolerances, and dense title-block tables transcribe poorly. Treat YOUR OWN reading of the image as primary; use this text only as a cross-reference to catch small or faint text. Where the OCR text and the image disagree, trust the image.\n\n${entry.ocrText}\n\n=== END OCR TEXT ===`,
          });
        }
      } else {
        // text-cad, binary-cad, office — already-extracted text content
        // For STEP files, lead with the deterministic geometry-signals block:
        // it gives the model geometry it otherwise cannot see, and its caveats
        // (unit/scale mislabel, assumed units, assembly envelope) must be
        // surfaced as flags — a unit error is a scrap-the-whole-job risk.
        if (entry.occ) {
          // Stage B available: inject the richer OCC geometry block (supersedes the
          // text-only step-probe summary for this file).
          content.push({ type: 'text', text: buildOccPromptBlock(entry.occ, entry.name) });
        } else if (entry.stepSummary) {
          content.push({
            type: 'text',
            text: `${entry.stepSummary}\n\n[HOW TO USE THESE SIGNALS] The block above is computed deterministically from the STEP geometry — you cannot otherwise see STEP geometry, so treat these as facts to reason from. Use the envelope to sanity-check size against the shop profile and machine travel; use the face mix and freeform share to judge turning vs. milling vs. 5-axis surface work and likely cycle-time; use the cylindrical-diameter list as candidate holes/bores/bosses to cross-check against drawing callouts. CRITICAL — if the "Caveats:" line reports any of the following, you MUST raise a corresponding flag rather than ignore it: (a) a possible unit mislabel / scale issue or assumed/ambiguous units → AMBER flag, category "dimensional", recommending the customer confirm units before quoting (this is a scrap-the-job risk); (b) an assembly file (envelope unreliable) → a clarification asking which part(s) are being quoted and requesting part-level files. These are deterministic findings to corroborate, not override.`,
          });
        }
        content.push({
          type: 'text',
          text: entry.extractedText || `(no extractable content from ${entry.name})`,
        });
        // If a SolidWorks preview thumbnail was extracted via CFB, attach it for vision
        if (entry.previewImage && entry.previewImage.data) {
          content.push({
            type: 'image',
            source: {
              type: 'base64',
              media_type: entry.previewImage.media || 'image/png',
              data: entry.previewImage.data,
            },
          });
        }
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

    // ----- 5. Submit to Anthropic Batch API (async) -----
    // Generate a custom_id matching the job_id we'll create in Supabase.
    // Anthropic processes the batch async (5-30 min typically, 24hr max).
    // The /api/job-status endpoint handles result retrieval + email.
    const { randomUUID } = await import('node:crypto');
    const jobId = randomUUID();

    let batch;
    try {
      batch = await anthropic.messages.batches.create({
        requests: [{
          custom_id: jobId,
          params: {
            model: MODEL,
            max_tokens: 8192, // bumped from 4096 — complex RFQs with many flags + compliance asks can produce 12-15 flags and ~6000 tokens of structured output
            system: SYSTEM_PROMPT,
            messages: [{ role: 'user', content }],
          },
        }],
      });
    } catch (err) {
      console.error('=== Anthropic batch submission failed ===');
      console.error(err?.message);
      console.error(err?.error);
      return res.status(502).json({
        error: 'Could not submit your RFQ to the AI service. This is usually transient — try again in 30 seconds. If it persists, check status.anthropic.com.',
        detail: (err?.message || '').slice(0, 300),
      });
    }

    // Count this successful, cost-incurring submission against the daily ceiling.
    // (Bumped only on a real submit, so rejected/failed requests don't burn budget.)
    supabase.rpc('bump_analysis_counter').then(() => {}).catch(() => {});

    // ----- 6. Clear file buffers from memory -----
    pdfBuffers = [];

    // ----- 7. Store the job in Supabase -----
    const fileDeletedAt = new Date().toISOString();
    const processingMs = Date.now() - startTime;
    const fileNames = fileRefs.map(f => (f && f.name) || 'unknown').join(' + ');

    let storedJob = null;
    try {
      // Rules context for the deterministic post-pass in job-status.js: per-STEP
      // geometry (OCC features preferred, step-probe signals as fallback) plus the
      // shop profile text. Derived geometry stats + the shop's own profile — NOT
      // the customer's CAD/drawing, which we still never store.
      const geometries = pdfBuffers
        .filter((p) => p.occ || p.stepSignals)
        .map((p) => ({ name: p.name, occ: p.occ || null, step_signals: p.occ ? null : (p.stepSignals || null) }));
      const rulesContext = (geometries.length || shopProfile)
        ? { v: 1, geometries, profile_text: shopProfile || null }
        : null;

      const jobRow = {
        job_id: jobId,
        user_email: email,
        company_name: companyName || null,
        batch_id: batch.id,
        status: 'queued',
        file_names: fileNames || (emailBody ? 'pasted email body only' : null),
        file_size_bytes: totalSize,
        email_body_length: emailBody.length,
        ai_model_used: MODEL,
        email_opt_in: wantsEmail,
        ip_address: reqIp,   // for per-IP abuse throttling (column added in migration_rate_limits)
      };
      if (rulesContext) jobRow.rules_context = rulesContext;
      let ins = await supabase.from('analysis_jobs').insert(jobRow).select('id, job_id').single();
      // Defensive: if a migration hasn't run yet, retry without the new column(s)
      // so job recording never breaks on a deploy-order mistake.
      if (ins.error && /rules_context/i.test(ins.error.message || '')) {
        delete jobRow.rules_context;
        ins = await supabase.from('analysis_jobs').insert(jobRow).select('id, job_id').single();
      }
      if (ins.error && /ip_address/i.test(ins.error.message || '')) {
        delete jobRow.ip_address;
        ins = await supabase.from('analysis_jobs').insert(jobRow).select('id, job_id').single();
      }
      if (ins.error) throw ins.error;
      storedJob = ins.data;
    } catch (e) {
      console.error('Supabase job insert failed:', e.message);
      // Job was submitted to Anthropic but not recorded — return batch ID so user can recover
      return res.status(500).json({
        error: 'Your RFQ was submitted to the AI but we failed to record the job. Save this batch ID and contact support: ' + batch.id,
        detail: e.message?.slice(0, 200),
      });
    }

    // ----- 8. Also log to legacy analysis_logs table (back-compat for analytics) -----
    try {
      await supabase
        .from('analysis_logs')
        .insert({
          email,
          company_name: companyName,
          file_name: fileNames || 'email body only',
          file_size_bytes: totalSize,
          file_pages: totalPages,
          ai_model_used: MODEL,
          processing_time_ms: processingMs,
          file_deleted_at: fileDeletedAt,
          status: 'submitted_async',
        });
    } catch (e) { /* non-critical */ }

    // ----- 9. Return job ID — frontend will poll /api/job-status -----
    return res.status(202).json({
      jobId,
      batchId: batch.id,
      status: 'queued',
      message: 'Analysis submitted. Results in ~5 minutes typical (24hr max). Bookmark this URL or keep the tab open.',
      submittedAt: new Date().toISOString(),
      fileCount: fileRefs.length,
      hasEmailBody: !!emailBody,
      wantsEmail,
    });

  } catch (err) {
    console.error('=== analyze.js error ===');
    console.error('Error type:', err?.constructor?.name);
    console.error('Error message:', err?.message);
    console.error('Error status:', err?.status);
    console.error('Error stack:', err?.stack);
    pdfBuffers = [];

    const errMsg = String(err?.message || err || 'unknown error');
    const status = Number(err?.status) || 0;

    // ----- Anthropic API rate limit -----
    if (status === 429 || /rate.?limit|too many requests/i.test(errMsg)) {
      return res.status(429).json({
        error: 'The AI service is rate-limited right now. Wait 30-60 seconds and try again.',
        detail: errMsg.slice(0, 200),
      });
    }

    // ----- Anthropic auth issue -----
    if (status === 401 || /authentication|invalid.*api.*key|unauthorized/i.test(errMsg)) {
      return res.status(500).json({
        error: 'The AI service rejected our credentials. The Anthropic API key may have expired or run out of credit. Check the API key + billing in console.anthropic.com.',
        detail: errMsg.slice(0, 200),
      });
    }

    // ----- PDF too large / too many pages / page render limits -----
    if (status === 400 && /page|pdf|too large|too many|image.*size|dimensions/i.test(errMsg)) {
      return res.status(400).json({
        error: 'One of the PDFs exceeds the AI\'s processing limits. Anthropic\'s caps: 100 pages per PDF, 32 MB per PDF, each page rendered as max 8000×8000 pixels. Try splitting the drawing into fewer pages or reducing scan resolution before re-uploading.',
        detail: errMsg.slice(0, 300),
      });
    }

    // ----- Anthropic 400 (other input issues) -----
    if (status === 400 || /invalid.*request|bad.*request/i.test(errMsg)) {
      return res.status(400).json({
        error: 'The AI service rejected the input. This usually means one of the files is in a format the AI can\'t process (corrupted PDF, encrypted PDF, very unusual image format).',
        detail: errMsg.slice(0, 300),
      });
    }

    // ----- Timeout (Vercel 60s function limit or Anthropic SDK timeout) -----
    if (/timeout|timed out|ETIMEDOUT|aborted|context deadline/i.test(errMsg)) {
      return res.status(504).json({
        error: 'The analysis took longer than 60 seconds and was cancelled. This usually happens with very large scanned PDFs that require image OCR on many pages. Try uploading fewer or smaller files, or split a multi-page drawing into parts.',
        detail: errMsg.slice(0, 200),
      });
    }

    // ----- Server-side Anthropic outage -----
    if (status >= 500 && status < 600) {
      return res.status(502).json({
        error: 'The AI service had an internal error. Wait a moment and try again. If it persists for more than a few minutes, check status.anthropic.com.',
        detail: errMsg.slice(0, 300),
      });
    }

    // ----- Fallback — surface the underlying error so the user can self-diagnose -----
    return res.status(500).json({
      error: 'Analysis failed: ' + errMsg.slice(0, 250) + (errMsg.length > 250 ? '...' : ''),
      detail: errMsg.slice(0, 500),
    });
  }
}
