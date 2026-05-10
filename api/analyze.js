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

// ===== ITAR KEYWORD FILTER =====
// Per master plan Section 10 risk register: block ITAR-adjacent work.
const ITAR_KEYWORDS = [
  'ITAR', 'EAR', 'DDTC', 'USML', 'munitions list',
  'DFARS 252.204-7012', 'DFARS 252.204-7019',
  'classified', 'secret//', 'top secret',
  'export controlled', 'export-controlled',
  'controlled unclassified information',
  'CUI//SP-EXPT', 'CUI//EXPT',
];

function containsITARMarkers(text) {
  if (!text) return false;
  const upper = text.toUpperCase();
  return ITAR_KEYWORDS.some(kw => upper.includes(kw.toUpperCase()));
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
   - Certifications buried anywhere: AS9100, IATF 16949, NADCAP, ISO 13485, DFARS, ITAR/EAR markers
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
    if (rawFiles.length === 0) {
      return res.status(400).json({ error: 'At least one file is required.' });
    }
    if (rawFiles.length > 8) {
      return res.status(400).json({ error: 'Maximum 8 files per RFQ package.' });
    }

    // ----- 2. Read each file into memory, validate, run text pre-extraction -----
    let totalSize = 0;
    let totalPages = 0;
    let combinedTextForITAR = '';

    for (let i = 0; i < rawFiles.length; i++) {
      const file = rawFiles[i];

      if (file.mimetype !== 'application/pdf' &&
          !file.originalFilename?.toLowerCase().endsWith('.pdf')) {
        return res.status(400).json({
          error: `"${file.originalFilename}" is not a PDF. PDF only in V1 — export your CAD as PDF first.`,
        });
      }

      const buffer = fs.readFileSync(file.filepath);
      try { fs.unlinkSync(file.filepath); } catch (e) { /* ignore */ }

      // Best-effort text extraction for ITAR pre-screen and metadata.
      // If extraction fails (scanned/image-only), Claude vision handles it later.
      let pageCount = 0;
      let extractedText = '';
      try {
        const pdfData = await pdf(buffer);
        extractedText = pdfData.text || '';
        pageCount = pdfData.numpages || 0;
      } catch (err) {
        console.log(`Text extraction failed for ${file.originalFilename}; relying on Claude vision.`);
      }

      pdfBuffers.push({
        buffer,
        name: file.originalFilename || `document-${i + 1}.pdf`,
        label: labels[i] || '',
        size: file.size,
        pages: pageCount,
        extractedText,
      });

      totalSize += file.size;
      totalPages += pageCount;
      combinedTextForITAR += extractedText + '\n';
    }

    if (totalSize > 50 * 1024 * 1024) {
      return res.status(400).json({ error: 'Total package size exceeds 50 MB. Remove a file or compress.' });
    }

    // ----- 3. ITAR / defense work block (text-based pre-screen) -----
    if (containsITARMarkers(combinedTextForITAR)) {
      try {
        await supabase.from('analysis_logs').insert({
          email,
          company_name: companyName,
          file_name: pdfBuffers.map(p => p.name).join(' + '),
          file_size_bytes: totalSize,
          file_pages: totalPages,
          status: 'rejected_itar',
          error_message: 'Document contains ITAR/EAR/defense markers',
          file_deleted_at: new Date().toISOString(),
          ai_model_used: 'none',
        });
      } catch (e) { /* logging failure shouldn't block response */ }

      pdfBuffers = [];

      return res.status(400).json({
        error: 'This document contains markers (ITAR, EAR, DDTC, MIL-SPEC defense, classified, or CUI) that indicate it may be export-controlled or defense-related work. QuoteScout V1 is for non-ITAR commercial work only. ITAR-cleared infrastructure is planned for Phase 4 (Month 18+).',
      });
    }

    // ----- 4. Build the multi-document content array for Claude -----
    // Pattern: [text-header-1, document-1, text-header-2, document-2, ..., final-instruction]
    // The text headers tell Claude which document is which (label + filename), enabling
    // cross-document reasoning per the system prompt.
    const content = [];

    if (pdfBuffers.length > 1) {
      content.push({
        type: 'text',
        text: `This RFQ package contains ${pdfBuffers.length} documents. Treat them as ONE package. Cross-reference across them. Surface conflicts between documents as flags.\n`,
      });
    }

    pdfBuffers.forEach((entry, idx) => {
      const labelDisplay = LABEL_DISPLAY[entry.label] || 'Unlabeled';
      content.push({
        type: 'text',
        text: `=== Document ${idx + 1} of ${pdfBuffers.length}: "${entry.name}" (labeled: ${labelDisplay}) ===`,
      });
      content.push({
        type: 'document',
        source: {
          type: 'base64',
          media_type: 'application/pdf',
          data: entry.buffer.toString('base64'),
        },
      });
    });

    content.push({
      type: 'text',
      text: pdfBuffers.length > 1
        ? 'Analyze all of the above documents as one RFQ package. Cross-reference across documents. Read everything: title blocks, revision blocks, notes, dimensions, callouts, stamps, attached specs. Return the structured JSON risk report per the schema in your instructions.'
        : 'Analyze the attached RFQ document for manufacturing risks. The document may be a text-based PDF, a scanned image, a CAD drawing, or a mix. Read everything: title blocks, revision blocks, notes, dimensions, callouts, stamps. Return the structured JSON risk report per the schema in your instructions.',
    });

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
