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
You read like a senior precision-machining estimator under time pressure. The estimator has a Friday deadline, a 60-page RFQ on their desk, and ten other quotes in the queue. Your job is to surface what they would catch on a careful Tuesday-night read — but in 30 seconds. Every flag must answer one of three questions:
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
   - Heat treat, plating, anodize, Nital Etch, EDM, grinding, laser marking, painting — every outside operation has lead time and minimum lot charge implications
   - Quantity-vs-process mismatch: low quantity (qty 1–10) with high outside-service overhead drives unit cost up dramatically — flag if not accounted for
   - Single-source specifications (e.g., "per Magnaflux process X") that limit vendor choice
   - Operations that imply a vendor the shop may not have approved (NADCAP-required outside processors, e.g.)

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

    // ----- 10. Return result -----
    return res.status(200).json({
      ...parsed,
      analysisId: logId,
      fileDeletedAt,
      modelUsed: MODEL,
      processingMs,
      fileCount: rawFiles.length,
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
