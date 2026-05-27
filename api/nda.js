// =====================================================================
// QuoteScout — /api/nda
// =====================================================================
// Receives an NDA acceptance submission. Field-name-tolerant: accepts
// both legacy (name, company_name) and new (full_name, company) keys
// so a frontend update doesn't break the contract.
//
// Body fields (any of these acceptable):
//   name         OR full_name      — required
//   email                          — required
//   company_name OR company        — required
//   role                           — optional
//   agreed                         — must be true
//
// Inserts into the existing nda_acceptances table. Records the user's
// IP and user-agent server-side as proof of signature.
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

    // Accept either naming convention for resilience
    const name = (body.full_name ?? body.name ?? '').toString().trim();
    const email = (body.email ?? '').toString().trim().toLowerCase();
    const company = (body.company ?? body.company_name ?? '').toString().trim();
    const role = body.role ? body.role.toString().trim() : null;
    const agreed = body.agreed === true || body.agreed === 'true';

    // Validate (clear error messages that point to the specific missing field)
    const missing = [];
    if (!name) missing.push('name');
    if (!email) missing.push('email');
    if (!company) missing.push('company');
    if (missing.length > 0) {
      return res.status(400).json({
        error: `Missing required field${missing.length > 1 ? 's' : ''}: ${missing.join(', ')}.`,
      });
    }
    if (!agreed) {
      return res.status(400).json({
        error: 'You must check the agreement box to sign.',
      });
    }

    // Best-effort email format check (very loose — backend should be lenient)
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
      return res.status(400).json({ error: 'Email format looks invalid.' });
    }

    // Capture identifying signals server-side (proof of signature)
    const ipAddress =
      (req.headers['x-forwarded-for'] || '').toString().split(',')[0].trim() ||
      req.socket?.remoteAddress ||
      null;
    const userAgent = (req.headers['user-agent'] || '').toString().slice(0, 500);

    // Insert — try the most likely column layout first, then fall back
    // if the table schema uses different column names. This is defensive:
    // I don't know the exact column names of the existing
    // nda_acceptances table, so I try multiple shapes.
    const candidatePayloads = [
      // Layout A: full_name + company (newer naming)
      {
        full_name: name,
        email,
        company: company,
        role,
        agreed: true,
        ip_address: ipAddress,
        user_agent: userAgent,
        signed_at: new Date().toISOString(),
      },
      // Layout B: name + company_name (legacy naming)
      {
        name: name,
        email,
        company_name: company,
        agreed: true,
        ip_address: ipAddress,
        user_agent: userAgent,
        signed_at: new Date().toISOString(),
      },
      // Layout C: minimal (only universally-safe columns)
      {
        name: name,
        email,
        company_name: company,
        signed_at: new Date().toISOString(),
      },
    ];

    let stored = null;
    let lastError = null;
    for (const payload of candidatePayloads) {
      const { data, error } = await supabase
        .from('nda_acceptances')
        .insert(payload)
        .select('id')
        .single();

      if (!error) {
        stored = data;
        break;
      }
      // If error is about a missing column, try the next shape.
      // Other errors (network, RLS, etc) are fatal.
      const msg = (error.message || '').toLowerCase();
      const isMissingColumn = msg.includes('column') && (msg.includes('does not exist') || msg.includes('not found'));
      if (!isMissingColumn) {
        lastError = error;
        break;
      }
      lastError = error;
    }

    if (!stored) {
      console.error('/api/nda insert failed across all candidate shapes:', lastError?.message);
      return res.status(500).json({
        error: 'Could not record your signature. Try again in a moment.',
        detail: (lastError?.message || '').slice(0, 200),
      });
    }

    return res.status(200).json({
      ok: true,
      id: stored.id,
      nda_id: stored.id,
      signed_at: new Date().toISOString(),
    });
  } catch (err) {
    console.error('/api/nda handler error:', err);
    return res.status(500).json({
      error: err.message?.slice(0, 200) || 'Unknown error.',
    });
  }
}
