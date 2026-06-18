// api/nda.js
// Records a Mutual NDA acceptance.
//
// Why this exists: /api/analyze refuses any upload whose email has no row in the
// `nda_acceptances` table (its server-side NDA gate). This endpoint writes that
// row, so it's what actually unblocks a signer. public/nda.html POSTs JSON here
// the moment someone signs.
//
// Contract (kept deliberately simple and matched to nda.html):
//   POST /api/nda   Content-Type: application/json
//   body: { email | work_email, name?, company? | company_name?, ... }
//   -> 200 { ok: true }            (written, or already on record)
//   -> 400 { error }               (missing/invalid email)
//   -> 405 { error }               (non-POST)
//   -> 500 { error, detail }       (DB/permission problem — detail aids debugging)
//
// The email is stored LOWERCASED so it matches the lowercased lookup analyze.js
// does. Idempotent: re-signing the same email is a no-op success, never a dup error.

import { createClient } from '@supabase/supabase-js';

// Same project + key analyze.js uses (which already inserts into other tables,
// so this key can write).
const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_ANON_KEY
);

// NOTE: no `bodyParser: false` here (unlike analyze.js) — we WANT Vercel to parse
// the JSON body into req.body.

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    res.setHeader('Allow', 'POST');
    return res.status(405).json({ error: 'Method not allowed.' });
  }

  // Tolerate a string body just in case the platform didn't pre-parse it.
  let body = req.body;
  if (typeof body === 'string') {
    try { body = JSON.parse(body); } catch { body = {}; }
  }
  body = body || {};

  const email = String(body.email || body.work_email || '').toLowerCase().trim();
  if (!email || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
    return res.status(400).json({ error: 'A valid work email is required to sign.' });
  }

  const company = String(body.company || body.company_name || '').trim() || null;
  const ip = String(req.headers['x-forwarded-for'] || req.socket?.remoteAddress || '')
    .split(',')[0].trim() || null;

  try {
    // Already on record? No-op success (lets people re-sign harmlessly).
    const { data: existing, error: selErr } = await supabase
      .from('nda_acceptances')
      .select('email')
      .eq('email', email)
      .limit(1);
    if (selErr) throw selErr;
    if (existing && existing.length) {
      return res.status(200).json({ ok: true, already: true });
    }

    // Best-effort insert WITH audit columns (mirrors analyze.js's naming:
    // company_name, ip_address). If the table doesn't have those columns, fall
    // back to the one column analyze.js actually relies on — email — so the gate
    // works regardless of the rest of the schema.
    let insErr = null;
    ({ error: insErr } = await supabase
      .from('nda_acceptances')
      .insert({ email, company_name: company, ip_address: ip }));
    if (insErr) {
      const { error: minErr } = await supabase
        .from('nda_acceptances')
        .insert({ email });
      if (minErr) throw minErr;
    }

    return res.status(200).json({ ok: true });
  } catch (e) {
    const msg = (e && e.message) ? e.message : String(e);
    console.error('NDA acceptance write failed:', msg);
    // `detail` is surfaced so a failure (RLS policy, missing column, etc.) is
    // diagnosable from the browser network tab instead of being a silent 500.
    return res.status(500).json({ error: 'Could not record the signature.', detail: msg });
  }
}
