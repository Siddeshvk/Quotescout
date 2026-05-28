// /api/enrich-standard.js
// On-demand standards enrichment using Claude Haiku 4.5 + web search
// Idempotent. Self-rate-limiting. Caches forever.

const Anthropic = require('@anthropic-ai/sdk');
const { createClient } = require('@supabase/supabase-js');

const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_ANON_KEY);

const DAILY_CAP = 50;          // hard ceiling per day to avoid budget runaway
const MAX_OUTPUT_TOKENS = 1200; // summary should be tight, ~400 tokens of useful content

// Map Haiku 4.5 token pricing (in USD) - update if pricing changes
// As of May 2026 estimates: $1.00 / $5.00 per M tokens input/output
const PRICE_INPUT_PER_M = 1.00;
const PRICE_OUTPUT_PER_M = 5.00;

module.exports = async (req, res) => {
  // CORS
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();

  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  let specNumber;
  try {
    specNumber = (req.body?.spec_number || '').trim().toUpperCase();
  } catch (e) {
    return res.status(400).json({ error: 'Invalid body' });
  }

  if (!specNumber || specNumber.length < 3 || specNumber.length > 50) {
    return res.status(400).json({ error: 'spec_number required, length 3-50' });
  }

  // 1) Lookup existing row
  const { data: existing, error: lookupErr } = await supabase
    .from('standards_kb')
    .select('*')
    .eq('spec_number', specNumber)
    .maybeSingle();

  if (lookupErr) {
    console.error('Lookup error', lookupErr);
    return res.status(500).json({ error: 'DB lookup failed' });
  }

  // 2) Cache hit - return immediately
  if (existing && existing.enrichment_status === 'done' && existing.summary) {
    return res.status(200).json({
      cached: true,
      spec_number: specNumber,
      summary: existing.summary,
      source_type: existing.source_type,
    });
  }

  // 3) Daily cap check
  const { data: capExceeded } = await supabase.rpc('enrichment_cap_exceeded', { p_daily_cap: DAILY_CAP });
  if (capExceeded) {
    return res.status(429).json({
      error: 'Daily enrichment cap reached',
      retry_after: 'tomorrow',
    });
  }

  // 4) Mark as enriching (lock)
  await supabase
    .from('standards_kb')
    .upsert(
      {
        spec_number: specNumber,
        title: existing?.title || specNumber,
        enrichment_status: 'enriching',
        last_seen_at: new Date().toISOString(),
      },
      { onConflict: 'spec_number' }
    );

  // 5) Call Claude Haiku 4.5 with web search tool
  const systemPrompt = `You are a precision-manufacturing standards researcher. Given a specification number, research it via web search and return a TIGHT structured summary suitable for a CNC machine shop estimator.

CRITICAL RULES:
- Use web_search to find authoritative sources (DLA ASSIST, EverySpec, official SAE/ASTM/ASME pages, NIST).
- If the spec is a CUSTOMER-INTERNAL standard (Boeing BAC, Ford WSS, John Deere JDS-G, Caterpillar 1E/CPPI, GE P/ES, Pratt PWA, Honda HES, Toyota TS, etc.), DO NOT invent content. Return source_type=CUSTOMER_INTERNAL and a one-line note saying "Obtain controlled document from customer."
- If the spec is genuinely unfindable, return source_type=UNKNOWN.
- Keep each field 1-3 sentences. Total output under 400 tokens of useful content.
- Be specific about numeric thresholds, classes, types, methods - those are what shops need.
- Return ONLY valid JSON. No prose before or after.

OUTPUT SCHEMA:
{
  "source_type": "PUBLIC" | "CUSTOMER_INTERNAL" | "UNKNOWN",
  "category_detail": "string - e.g. 'Type II Class 1A chromate conversion - clear, non-conductive'",
  "scope": "string - what the spec covers",
  "key_requirements": "string - chemistry/mechanicals/dimensional/process thresholds",
  "inspection_reqs": "string - required test methods, sampling, acceptance criteria",
  "process_notes": "string - pre/post treatments, temperature, time, fixturing, masking",
  "common_pitfalls": "string - hidden costs, rework risks, quality escapes shops typically miss",
  "supersedes": "string or null - predecessor specs",
  "current_revision_hint": "string - latest revision if known, or 'verify with customer'",
  "sources_used": ["array of URLs cited"]
}`;

  const userPrompt = `Research specification: ${specNumber}

If you cannot find authoritative information after web search, return source_type=UNKNOWN with a brief explanation in scope. Do not fabricate.`;

  let claudeResp;
  try {
    claudeResp = await anthropic.messages.create({
      model: 'claude-haiku-4-5-20251001',
      max_tokens: MAX_OUTPUT_TOKENS,
      system: systemPrompt,
      tools: [
        {
          type: 'web_search_20250305',
          name: 'web_search',
          max_uses: 3,
        },
      ],
      messages: [{ role: 'user', content: userPrompt }],
    });
  } catch (e) {
    console.error('Claude API error:', e);
    await supabase
      .from('standards_kb')
      .update({ enrichment_status: 'failed' })
      .eq('spec_number', specNumber);
    return res.status(500).json({ error: 'Enrichment API call failed', detail: String(e?.message || e) });
  }

  // 6) Extract text content (web_search returns multiple block types)
  const textBlocks = (claudeResp.content || [])
    .filter((b) => b.type === 'text')
    .map((b) => b.text)
    .join('\n');

  // 7) Parse JSON (strip fences if present)
  let parsed;
  try {
    const cleaned = textBlocks.replace(/```json\s*/gi, '').replace(/```\s*$/g, '').trim();
    parsed = JSON.parse(cleaned);
  } catch (e) {
    console.error('Parse error', e, 'text was:', textBlocks);
    await supabase
      .from('standards_kb')
      .update({ enrichment_status: 'failed' })
      .eq('spec_number', specNumber);
    return res.status(500).json({ error: 'Failed to parse enrichment output' });
  }

  // 8) Compute cost
  const inputTokens = claudeResp.usage?.input_tokens || 0;
  const outputTokens = claudeResp.usage?.output_tokens || 0;
  const cost =
    (inputTokens * PRICE_INPUT_PER_M) / 1_000_000 +
    (outputTokens * PRICE_OUTPUT_PER_M) / 1_000_000;

  // 9) Save
  const sourceType = ['PUBLIC', 'CUSTOMER_INTERNAL', 'UNKNOWN'].includes(parsed.source_type)
    ? parsed.source_type
    : 'UNKNOWN';

  const { error: saveErr } = await supabase
    .from('standards_kb')
    .update({
      summary: parsed,
      source_type: sourceType,
      enrichment_status: sourceType === 'CUSTOMER_INTERNAL' ? 'skip' : 'done',
      last_enriched_at: new Date().toISOString(),
      enrichment_cost: cost,
      revision_note: parsed.current_revision_hint || 'Verify current revision with customer.',
    })
    .eq('spec_number', specNumber);

  if (saveErr) {
    console.error('Save error', saveErr);
    return res.status(500).json({ error: 'Failed to save enrichment' });
  }

  // 10) Bump the daily cost counter
  await supabase.rpc('bump_enrichment_counter', { p_cost: cost });

  return res.status(200).json({
    cached: false,
    spec_number: specNumber,
    summary: parsed,
    source_type: sourceType,
    cost_usd: cost.toFixed(4),
  });
};
