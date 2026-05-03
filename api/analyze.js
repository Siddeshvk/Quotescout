// =====================================================================
// QuoteScout — /api/analyze
// =====================================================================
// This is the heart of the product. It receives a PDF upload, extracts
// the text, sends it to Claude API for risk analysis, logs metadata to
// Supabase, and returns a structured risk report.
//
// File flow:
//   1. PDF arrives via multipart/form-data
//   2. Text extracted in memory (pdf-parse)
//   3. ITAR keyword check — block defense work
//   4. Claude API call with the master risk-surfacing prompt
//   5. Response parsed as JSON
//   6. Metadata logged to Supabase (NOT the file content)
//   7. PDF buffer cleared from memory
//   8. Response returned to user
//
// What we store in Supabase: email, filename, file size, page count,
// flag counts, AI model, processing time, deletion timestamp.
// What we do NOT store: the PDF, the extracted text, the AI's full output.
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
    sizeLimit: '25mb',
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

LANGUAGE RULES (mandatory — never violate):
- NEVER say "this job is safe to bid" or "you should bid this"
- NEVER say "this job cannot be made" — say "requires verification"
- NEVER say "Go" or "No-Bid" — say "review recommended" or "high-risk flags present"
- ALWAYS include in mandatory disclaimer: "All flags require verification by qualified engineering personnel before pricing"
- Frame every flag as: "Risk identified: [description]. Confidence: [%]. Recommended action: [verify/calculate/confirm]"

FLAG SEVERITY DEFINITIONS:
- RED: Sequence physically impossible OR a confirmed missing compliance requirement
- AMBER: Compliance gap detected — requires shop to confirm certification or capability before committing
- YELLOW: Hidden cost risk — missing operation, unquoted outside service, or dimensional math required
- PURPLE: Low confidence (< 70%) — AI uncertain; human verification required before any action

THE 4 RISK CATEGORIES YOU MUST CHECK FOR:
1. Compliance Risk: certifications (AS9100, IATF 16949, NADCAP, DFARS), inspection requirements (100% inspection, CPK studies), processes (Nital Etch, Magnetic Particle) buried anywhere in the doc
2. Sequence Risk: operations that must happen in a specific order. Heat treat must precede finish grinding. Stress relief must precede finish machining. Nital Etch must follow aerospace grinding.
3. Dimensional Compensation Risk: Electroless Nickel adds 0.0002"-0.0005" per side. Hard Coat Anodize adds 0.0005"-0.001" per side. Threads must be cut undersize. Calculate pre-coat dimensions where applicable.
4. Outside Service Risk: heat treat, plating, Nital Etch, EDM, grinding — flag lead time and minimum lot charge risk for each.

OUTPUT FORMAT:
Return ONLY valid JSON. No preamble, no commentary, no markdown code fences. Use this exact schema:

{
  "flags": [
    {
      "severity": "RED" | "AMBER" | "YELLOW" | "PURPLE",
      "category": "compliance" | "sequence" | "dimensional" | "outside_service" | "inspection" | "material",
      "title": "Short title of the risk (under 80 chars)",
      "description": "1-3 sentences describing the risk. No prescriptive language.",
      "confidence": 0-100,
      "location": "page or section reference (e.g., 'page 3, note 4')",
      "estimatedCostRange": "optional cost range like '$2,000-$5,000'",
      "recommendedAction": "verify with [role] / calculate [thing] / confirm [cert]"
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
  "summary": "2-3 sentences. NO 'Go/No-Bid' language. NO 'safe to bid'. Just summarize what was found."
}

If a flag is below 70% confidence, ALWAYS mark it PURPLE regardless of category.
If you cannot extract enough information to analyze, return {"flags": [], "dimensions": [], "flagCounts": {"red":0,"amber":0,"yellow":0,"purple":0}, "summary": "Insufficient information in document. Please verify the file contains a complete RFQ."}.`;

// ===== MAIN HANDLER =====
export default async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed. Use POST.' });
  }

  const startTime = Date.now();
  let pdfBuffer = null;
  let extractedText = '';
  let logId = null;

  try {
    // ----- 1. Parse multipart form -----
    const form = formidable({
      maxFileSize: 25 * 1024 * 1024, // 25 MB
      keepExtensions: true,
    });

    const [fields, files] = await form.parse(req);

    const email = (fields.email?.[0] || '').trim().toLowerCase();
    const companyName = (fields.company_name?.[0] || '').trim();
    const file = files.file?.[0];

    if (!email) {
      return res.status(400).json({ error: 'Email is required.' });
    }
    if (!file) {
      return res.status(400).json({ error: 'File is required.' });
    }
    if (file.mimetype !== 'application/pdf' && !file.originalFilename?.toLowerCase().endsWith('.pdf')) {
      return res.status(400).json({ error: 'PDF only. Export your CAD as PDF first.' });
    }

    // ----- 2. Read file into memory, then immediately schedule deletion -----
    pdfBuffer = fs.readFileSync(file.filepath);
    // Delete the temp file from disk RIGHT NOW
    try { fs.unlinkSync(file.filepath); } catch (e) { /* ignore */ }

    // ----- 3. Extract text -----
    let pageCount = 0;
    try {
      const pdfData = await pdf(pdfBuffer);
      extractedText = pdfData.text || '';
      pageCount = pdfData.numpages || 0;
    } catch (err) {
      return res.status(400).json({
        error: 'Failed to read PDF. The file may be corrupted, password-protected, or scanned-only (no text layer). V1 supports text-based PDFs only.',
      });
    }

    if (extractedText.trim().length < 100) {
      return res.status(400).json({
        error: 'PDF has very little extractable text (under 100 characters). It may be a scanned image. Try saving the document as a text-based PDF first.',
      });
    }

    // ----- 4. ITAR / defense work block -----
    if (containsITARMarkers(extractedText)) {
      // Log the rejection but do not analyze
      try {
        await supabase.from('analysis_logs').insert({
          email,
          company_name: companyName,
          file_name: file.originalFilename || 'unknown.pdf',
          file_size_bytes: file.size,
          file_pages: pageCount,
          status: 'rejected_itar',
          error_message: 'Document contains ITAR/EAR/defense markers',
          file_deleted_at: new Date().toISOString(),
          ai_model_used: 'none',
        });
      } catch (e) { /* logging failure shouldn't block response */ }

      // Clear buffer
      pdfBuffer = null;
      extractedText = '';

      return res.status(400).json({
        error: 'This document contains markers (ITAR, EAR, DDTC, MIL-SPEC defense, classified, or CUI) that indicate it may be export-controlled or defense-related work. QuoteScout V1 is for non-ITAR commercial work only. ITAR-cleared infrastructure is planned for Phase 4 (Month 18+).',
      });
    }

    // ----- 5. Truncate very long documents -----
    // Claude has plenty of context, but we cap input to control costs.
    // ~30k chars ≈ 7-8k tokens, fits comfortably in budget.
    const MAX_CHARS = 30000;
    let truncated = false;
    if (extractedText.length > MAX_CHARS) {
      extractedText = extractedText.slice(0, MAX_CHARS);
      truncated = true;
    }

    // ----- 6. Call Claude API -----
    const userMessage = truncated
      ? `Analyze the following RFQ document for risks. NOTE: The document was truncated to the first ${MAX_CHARS} characters due to length — flag this in your summary.\n\n--- RFQ DOCUMENT ---\n${extractedText}\n--- END ---\n\nReturn the structured JSON risk report per the schema in your instructions.`
      : `Analyze the following RFQ document for risks.\n\n--- RFQ DOCUMENT ---\n${extractedText}\n--- END ---\n\nReturn the structured JSON risk report per the schema in your instructions.`;

    const response = await anthropic.messages.create({
      model: MODEL,
      max_tokens: 4096,
      system: SYSTEM_PROMPT,
      messages: [
        { role: 'user', content: userMessage },
      ],
    });

    // ----- 7. Clear text from memory -----
    extractedText = '';
    pdfBuffer = null;

    // ----- 8. Parse the AI response -----
    let aiText = '';
    if (Array.isArray(response.content)) {
      for (const block of response.content) {
        if (block.type === 'text') aiText += block.text;
      }
    }

    // Strip markdown fences if the model wrapped the JSON
    aiText = aiText.trim();
    if (aiText.startsWith('```')) {
      aiText = aiText.replace(/^```(?:json)?\s*/, '').replace(/\s*```$/, '');
    }

    let parsed;
    try {
      parsed = JSON.parse(aiText);
    } catch (e) {
      // If parsing fails, return a graceful error
      console.error('Failed to parse AI JSON:', aiText.slice(0, 500));
      return res.status(500).json({
        error: 'AI returned malformed response. Please try again. If this persists, the document may be too unusual for our V1 prompts.',
      });
    }

    // ----- 9. Compute counts (defensive) -----
    const counts = { red: 0, amber: 0, yellow: 0, purple: 0 };
    (parsed.flags || []).forEach(f => {
      const s = (f.severity || 'PURPLE').toLowerCase();
      if (counts[s] !== undefined) counts[s]++;
    });
    parsed.flagCounts = counts;

    // ----- 10. Log metadata to Supabase (no file content) -----
    const fileDeletedAt = new Date().toISOString();
    const processingMs = Date.now() - startTime;

    try {
      const { data: log, error: logErr } = await supabase
        .from('analysis_logs')
        .insert({
          email,
          company_name: companyName,
          file_name: file.originalFilename || 'unknown.pdf',
          file_size_bytes: file.size,
          file_pages: pageCount,
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
      // Logging failure should NOT block returning the analysis to the user
      console.error('Supabase log failed:', e.message);
    }

    // ----- 11. Return result -----
    return res.status(200).json({
      ...parsed,
      analysisId: logId,
      fileDeletedAt,
      modelUsed: MODEL,
      processingMs,
    });

  } catch (err) {
    console.error('analyze.js error:', err);
    // Always clear sensitive data on error
    pdfBuffer = null;
    extractedText = '';
    return res.status(500).json({
      error: 'Analysis failed. Please try again. If this persists, contact the QuoteScout team.',
      detail: process.env.NODE_ENV === 'development' ? err.message : undefined,
    });
  }
}
