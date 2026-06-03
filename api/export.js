// =====================================================================
// QuoteScout — /api/export
// =====================================================================
// "Agent-disguised-as-SaaS" export endpoint. Takes a completed analysis
// (looked up by jobId) and a free-text target format description, then
// uses Claude Haiku to transform the structured JSON into whatever
// shape the user described.
//
// Why Haiku (not Sonnet): this is a format-transformation task. No
// reasoning required, just rewriting. Haiku 4.5 is ~3x faster and 5x
// cheaper than Sonnet, perfect for this. Still uses the batch-API
// 50% discount? No — batches are async, exports need to be sync. Pay
// the standard rate. It's still cheap.
//
// Body fields:
//   jobId (required)        — UUID of the completed analysis job
//   target_format (required) — free text: "JobBOSS XML import",
//                              "Paperless Parts CSV", "Plain-text email
//                              to customer summarizing the verdict", etc.
//
// Returns:
//   { generated: "<text>", target_format: "<echo>", model: "haiku-4-5" }
// =====================================================================

import { createClient } from '@supabase/supabase-js';
import Anthropic from '@anthropic-ai/sdk';

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_ANON_KEY
);

const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

const MODEL = 'claude-haiku-4-5-20251001';

export const config = { maxDuration: 30 };

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed. Use POST.' });
  }

  try {
    const body = typeof req.body === 'string' ? JSON.parse(req.body || '{}') : (req.body || {});
    const jobId = (body.jobId || '').toString().trim();
    const targetFormatRaw = (body.target_format || '').toString().trim();
    const targetFormat = targetFormatRaw.slice(0, 500); // cap at 500 chars

    // --- Estimator Pre-Fill preset --------------------------------------
    // When the requested format is the estimator routing worksheet, augment
    // the system prompt with an explicit spec. This stays inside QuoteScout's
    // no-price posture: it produces a routing + risk HEAD START, never costs,
    // hours, feeds/speeds, or a bid decision. Triggered by the app.html chip
    // or by the user typing any of: pre-fill, routing, worksheet, estimator,
    // microestimating, jobboss.
    const wantsPrefill = /pre-?fill|routing|worksheet|estimator|micro[\s-]?estimating|job\s?boss/i.test(targetFormat);
    const presetBlock = wantsPrefill ? [
      '',
      '',
      '=== ESTIMATOR PRE-FILL MODE (OVERRIDES GENERIC FORMATTING) ===',
      'The user wants an estimator worksheet: a head start they will key into their own estimating or ERP system (MicroEstimating, JobBOSS, Paperless Parts, Epicor, etc.). Produce a clean plain-text worksheet with the EXACT section headers below, in this order. Use only the data in the source JSON; do not invent content.',
      '',
      'HARD RULE FOR THIS MODE: never output cycle times, feeds, speeds, setup hours, run hours, pieces-per-hour, material prices, markups, or a bid / no-bid decision. This is a routing and risk head start; the estimator owns every number and prices it in their own system. If a value is not in the source JSON, do not fabricate it.',
      '',
      'SECTION 1 - VERDICT: one line, stating the source verdict and verdict_reason (light rephrasing for readability is fine).',
      '',
      'SECTION 2 - SUGGESTED ROUTING (estimator to confirm): an ordered list of the in-house work centers / operations the part appears to require, inferred from the flags, dimensions, and summary (for example: Saw / cutoff, CNC Mill, CNC Turn, Deburr, Grind, Inspection / FAI). Label the section clearly as suggested and unconfirmed. Do not include times or costs. If the geometry is too thin to infer routing, say so in one line instead of guessing.',
      '',
      'SECTION 3 - OUTSIDE SERVICES / VENDOR RFQ LIST: one line per outside operation that needs a vendor quote before pricing (heat treat, plating, anodize, NDT, coating, special process), naming the specific spec / type / class when the source has it. This is the list the estimator will fire vendor RFQs against.',
      '',
      'SECTION 4 - LIKELY ONE-TIME (NRE) CHARGES TO CONFIRM: bullet the one-time charges the package implies - CNC programming and first setup, workholding / soft jaws / fixtures, special or form tooling, custom gaging, PPAP (state the level if the source gives one), First Article / FAIR. Mark each as confirm. Pull only from the flags and clarifications present.',
      '',
      'SECTION 5 - MATERIAL AND STOCK NOTES: material grade / spec, stock-form and utilization notes, and any certification / traceability requirement, taken from the material-related flags.',
      '',
      'SECTION 6 - OPEN CLARIFICATIONS (ask before quoting): list the BLOCKING and IMPORTANT customer_clarifications as a phone-ready checklist.',
      '',
      'Close with one line: All items require verification by qualified engineering personnel before pricing. QuoteScout does not price jobs or recommend bids.',
      '=== END ESTIMATOR PRE-FILL MODE ===',
    ].join('\n') : '';
    // --------------------------------------------------------------------

    if (!jobId) {
      return res.status(400).json({ error: 'jobId is required.' });
    }
    if (!targetFormat) {
      return res.status(400).json({ error: 'target_format is required (describe what shape you want the analysis in).' });
    }

    // Look up the completed job
    const { data: job, error: jobErr } = await supabase
      .from('analysis_jobs')
      .select('id, job_id, status, result_verdict, result_verdict_reason, result_summary, result_clarifications, result_flags, result_counts, file_names, company_name, submitted_at, completed_at')
      .eq('job_id', jobId)
      .single();

    if (jobErr || !job) {
      return res.status(404).json({ error: 'Job not found. Make sure the analysis completed before exporting.' });
    }
    if (job.status !== 'complete') {
      return res.status(400).json({ error: `Job status is "${job.status}" — exports only work for completed analyses.` });
    }

    // Build the source data the AI will transform
    const sourceData = {
      analysis_id: job.id,
      analyzed_at: job.completed_at,
      submitted_at: job.submitted_at,
      company_name: job.company_name || null,
      file_names: job.file_names || null,
      verdict: job.result_verdict || null,
      verdict_reason: job.result_verdict_reason || '',
      summary: job.result_summary || '',
      customer_clarifications: job.result_clarifications || [],
      flag_counts: job.result_counts || { red: 0, amber: 0, yellow: 0, purple: 0 },
      flags: job.result_flags || [],
    };

    const systemPrompt = `You are a format-transformation agent for QuoteScout, a precision-manufacturing RFQ analysis tool.

You receive:
1. A structured JSON analysis result.
2. A free-text description of the target output format.

Your job: transform the JSON into the target format exactly as described.

RULES:
- Output ONLY the transformed content. No preamble, no explanation, no commentary, no "Here is your...", no markdown code fences around the entire output.
- Preserve ALL data faithfully. Do not summarize, omit, or invent fields beyond what the source contains.
- If the target format is structured (CSV, XML, JSON, YAML), produce syntactically valid output that a machine could parse.
- If the target format is human-readable (email, summary, briefing note), use the data to write professional, non-prescriptive prose.
- For ERP-import-style targets (JobBOSS, Paperless Parts, Epicor, MIE Trak, ProShop, etc.), produce a sensible templated format with clear field names. Add a brief inline comment at the top noting "Template format — adjust field mappings to match your ERP's exact import schema." This is honest: real ERP integrations require per-vendor sandbox testing; we generate a usable starting point.
- Never include API keys, internal job UUIDs, or anything that looks like authentication data.
- Never fabricate phone numbers, addresses, contact names, or pricing not present in the source data.
- If the target format request is unclear, make a reasonable assumption and proceed. Don't ask clarifying questions — just produce the best interpretation.

The source JSON will be provided as input. The target format description will tell you what to do with it.`;

    const userMessage = `TARGET FORMAT REQUESTED:
${targetFormat}

SOURCE ANALYSIS JSON:
\`\`\`json
${JSON.stringify(sourceData, null, 2)}
\`\`\`

Transform the source JSON into the requested target format now. Output only the transformed content.`;

    let response;
    try {
      response = await anthropic.messages.create({
        model: MODEL,
        max_tokens: 4096,
        system: systemPrompt + presetBlock,
        messages: [{ role: 'user', content: userMessage }],
      });
    } catch (e) {
      console.error('Export AI call failed:', e.message);
      return res.status(502).json({
        error: 'AI export agent failed. Try again in a moment, or use the JSON export and convert manually.',
        detail: e.message?.slice(0, 200),
      });
    }

    let generated = '';
    if (Array.isArray(response.content)) {
      for (const block of response.content) {
        if (block.type === 'text') generated += block.text;
      }
    }
    generated = generated.trim();

    // If the model wrapped the entire output in a markdown code fence,
    // strip it. (We told it not to, but Haiku occasionally does it anyway.)
    if (generated.startsWith('```')) {
      generated = generated.replace(/^```[a-z]*\s*\n?/, '').replace(/\n?```\s*$/, '').trim();
    }

    return res.status(200).json({
      generated,
      target_format: targetFormat,
      model: MODEL,
      analysis_id: job.id,
      generated_at: new Date().toISOString(),
    });
  } catch (err) {
    console.error('export.js handler error:', err);
    return res.status(500).json({ error: err.message?.slice(0, 200) || 'Unknown error.' });
  }
}
