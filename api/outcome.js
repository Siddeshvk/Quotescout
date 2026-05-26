// =====================================================================
// QuoteScout — /api/outcome
// =====================================================================
// Receives outcome feedback for an analysis. The /outcome.html page
// posts here.
//
// Body fields:
//   analysis_id (required) — links the feedback to the analysis row
//   outcome (required)     — won | lost | no_bid | pending | other
//   missed_requirement     — optional text. "What did the AI miss?"
//   would_have_quoted_higher — optional boolean. ROI signal.
//   email                  — optional, only if user wants follow-up
//
// All feedback goes into the outcome_feedback table.
// Requires migrations v1.0 (table) and v1.7 (new columns) to be run.
// =====================================================================

import { createClient } from '@supabase/supabase-js';

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_ANON_KEY
);

export const config = { maxDuration: 10 };

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed. Use POST.' });
  }

  try {
    const body = typeof req.body === 'string' ? JSON.parse(req.body || '{}') : (req.body || {});

    const analysisId = (body.analysis_id ?? '').toString().trim();
    const outcome = (body.outcome || '').toString().trim().toLowerCase();
    const missedRequirement = body.missed_requirement
      ? body.missed_requirement.toString().slice(0, 5000)
      : null;
    let wouldHaveQuotedHigher = null;
    if (typeof body.would_have_quoted_higher === 'boolean') {
      wouldHaveQuotedHigher = body.would_have_quoted_higher;
    }
    const email = body.email ? body.email.toString().trim().toLowerCase() : null;

    if (!analysisId) {
      return res.status(400).json({ error: 'analysis_id is required.' });
    }

    const VALID_OUTCOMES = ['won', 'lost', 'no_bid', 'pending', 'other'];
    if (!VALID_OUTCOMES.includes(outcome)) {
      return res.status(400).json({ error: 'outcome must be one of: ' + VALID_OUTCOMES.join(', ') });
    }

    // analysis_id may be a numeric ID (analysis_logs.id / analysis_jobs.id)
    // or a UUID job_id. Store as text to accommodate both.
    const insertPayload = {
      analysis_id: analysisId,
      outcome,
      missed_requirement: missedRequirement,
      would_have_quoted_higher: wouldHaveQuotedHigher,
      email,
      submitted_at: new Date().toISOString(),
    };

    // Defensive insert: if migration v1.7 hasn't run yet, the unknown
    // columns will cause an error. Retry without them so legacy
    // deployments keep working.
    let { error } = await supabase.from('outcome_feedback').insert(insertPayload);
    if (error && /missed_requirement|would_have_quoted_higher/.test(error.message || '')) {
      console.warn('Migration v1.7 not applied — falling back to legacy column set.');
      delete insertPayload.missed_requirement;
      delete insertPayload.would_have_quoted_higher;
      ({ error } = await supabase.from('outcome_feedback').insert(insertPayload));
    }

    if (error) {
      console.error('outcome.js insert error:', error.message);
      return res.status(500).json({
        error: 'Could not save your feedback. Try again in a moment.',
        detail: error.message?.slice(0, 200),
      });
    }

    return res.status(200).json({ ok: true });
  } catch (err) {
    console.error('outcome.js handler error:', err);
    return res.status(500).json({ error: err.message?.slice(0, 200) || 'Unknown error.' });
  }
}
