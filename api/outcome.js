// =====================================================================
// QuoteScout — /api/outcome
// =====================================================================
// Receives outcome feedback for an earlier analysis. This endpoint is the
// data loop for Moat #2 (per master plan § 2.4): proprietary RFQ-risk to
// production-outcome dataset. Without this, no moat forms.
//
// Payload:
//   { analysisId, outcome, notes, missedFlags? }
//   outcome ∈ ['quoted_won_clean', 'quoted_won_with_issue', 'quoted_lost',
//              'no_bid', 'in_progress']
// =====================================================================

import { createClient } from '@supabase/supabase-js';

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_ANON_KEY
);

const VALID_OUTCOMES = [
  'quoted_won_clean',
  'quoted_won_with_issue',
  'quoted_lost',
  'no_bid',
  'in_progress',
];

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed. Use POST.' });
  }

  try {
    let body = req.body;
    if (typeof body === 'string') body = JSON.parse(body);

    const {
      analysisId,
      outcome,
      notes,
      missedFlags,
      changeOrderOccurred,
      wasQuoted,
      wasWon,
    } = body || {};

    if (!analysisId) {
      return res.status(400).json({ error: 'analysisId is required.' });
    }
    if (!outcome || !VALID_OUTCOMES.includes(outcome)) {
      return res.status(400).json({
        error: `outcome must be one of: ${VALID_OUTCOMES.join(', ')}`,
      });
    }

    // Map the categorical outcome to the booleans that the master-plan
    // spec called out, so the dataset is queryable both ways.
    const wasQuotedDerived = wasQuoted ?? (outcome.startsWith('quoted_'));
    const wasWonDerived = wasWon ?? (outcome === 'quoted_won_clean' || outcome === 'quoted_won_with_issue');
    const changeOrderDerived = changeOrderOccurred ?? (outcome === 'quoted_won_with_issue');

    const ip = (req.headers['x-forwarded-for'] || '').toString().split(',')[0].trim();
    const ua = (req.headers['user-agent'] || '').toString().slice(0, 500);

    const { error } = await supabase.from('outcome_feedback').insert({
      analysis_id: analysisId,
      outcome,
      was_quoted: wasQuotedDerived,
      was_won: wasWonDerived,
      change_order_occurred: changeOrderDerived,
      missed_flags: Array.isArray(missedFlags) ? missedFlags.join('\n') : null,
      notes: typeof notes === 'string' ? notes.slice(0, 2000) : null,
      ip_address: ip || null,
      user_agent: ua || null,
    });

    if (error) {
      console.error('Supabase outcome insert failed:', error);
      return res.status(500).json({ error: 'Could not record outcome. Please try again.' });
    }

    return res.status(200).json({ received: true });

  } catch (err) {
    console.error('outcome.js error:', err);
    return res.status(500).json({
      error: 'Could not record outcome. Please try again.',
    });
  }
}
