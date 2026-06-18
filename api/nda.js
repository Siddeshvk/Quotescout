// =====================================================================
// QuoteScout — /api/nda
// =====================================================================
// Records each user's NDA + Terms + Privacy acceptance into Supabase.
// This is the legal record that the user agreed to terms before
// uploading any documents.
//
// The acceptance is timestamped and stamped with their IP + user agent
// for audit trail purposes.
// =====================================================================

import { createClient } from '@supabase/supabase-js';

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_ANON_KEY
);

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed.' });
  }

  try {
    const {
      full_name,
      email,
      company_name,
      job_title,
      nda_version,
      terms_version,
      privacy_version,
    } = req.body || {};

    // Validation
    if (!full_name || !email || !company_name) {
      return res.status(400).json({ error: 'Name, email, and company are required.' });
    }
    if (!email.includes('@') || email.length < 5) {
      return res.status(400).json({ error: 'Please enter a valid email address.' });
    }

    // Capture IP + user agent for audit
    const ip = (req.headers['x-forwarded-for'] || req.connection?.remoteAddress || '')
      .toString()
      .split(',')[0]
      .trim();
    const userAgent = req.headers['user-agent'] || '';

    const { error } = await supabase.from('nda_acceptances').insert({
      full_name: full_name.trim(),
      email: email.trim().toLowerCase(),
      company_name: company_name.trim(),
      job_title: (job_title || '').trim(),
      nda_version: nda_version || '1.0',
      terms_version: terms_version || '1.0',
      privacy_version: privacy_version || '1.0',
      ip_address: ip,
      user_agent: userAgent,
    });

    if (error) {
      console.error('Supabase NDA insert failed:', error);
      return res.status(500).json({ error: 'Could not record acceptance. Please try again.' });
    }

    return res.status(200).json({ success: true });
  } catch (err) {
    console.error('nda.js error:', err);
    return res.status(500).json({ error: 'Server error. Please try again.' });
  }
}
