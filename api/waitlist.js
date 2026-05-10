// =====================================================================

// QuoteScout — /api/waitlist

// =====================================================================

// Captures email addresses from visitors who aren't ready to upload an

// RFQ but want the Sequence Risk Cheat Sheet and updates. This is the

// soft-conversion path — most visitors won't upload on day one.

// =====================================================================

import { createClient } from '@supabase/supabase-js';

import { Resend } from 'resend';

const supabase = createClient(

  process.env.SUPABASE_URL,

  process.env.SUPABASE_ANON_KEY

);

const resend = process.env.RESEND_API_KEY

  ? new Resend(process.env.RESEND_API_KEY)

  : null;

const FROM_EMAIL = process.env.RESEND_FROM_EMAIL || 'reports@quotescout.com';

export default async function handler(req, res) {

  if (req.method !== 'POST') {

    return res.status(405).json({ error: 'Method not allowed. Use POST.' });

  }

  try {

    let body = req.body;

    if (typeof body === 'string') body = JSON.parse(body);

    const email = (body?.email || '').trim().toLowerCase();

    const company = (body?.company || '').trim().slice(0, 200);

    const role = (body?.role || '').trim().slice(0, 100);

    if (!email || !email.includes('@')) {

      return res.status(400).json({ error: 'A valid email is required.' });

    }

    const ip = (req.headers['x-forwarded-for'] || '').toString().split(',')[0].trim();

    // Idempotent: if email already exists, treat as success

  const { error } = await supabase.from('waitlist').insert({

  email,

  company_name: company || null,

  role: role || null,

  ip_address: ip || null,

  source: 'homepage',

});

if (error) {

  const isDuplicate = error.code === '23505' ||

                      error.message?.toLowerCase().includes('duplicate');

  if (isDuplicate) {

    console.log(`Waitlist: ${email} already exists — re-sending cheat sheet anyway.`);

  } else {

    console.error('Supabase waitlist insert failed:', error);

  }

  // Either way, soft-fail and continue to email send

}

    // Fire-and-forget: send the cheat sheet link via email

    if (resend) {

      resend.emails.send({

        from: `QuoteScout <${FROM_EMAIL}>`,

        to: email,

        subject: 'Your Sequence Risk Cheat Sheet — QuoteScout',

        html: `

<div style="font-family: -apple-system, system-ui, sans-serif; max-width: 560px; margin: 0 auto; color: #1a1a1a; line-height: 1.55;">

  <h2 style="font-weight: 600; font-size: 22px; margin: 0 0 16px;">Your Sequence Risk Cheat Sheet</h2>

  <p>Thanks for joining the QuoteScout waitlist. Here's the one-pager you signed up for — ten precision-machining sequence risks that quietly destroy margin.</p>

  <p><a href="https://quotescout.vercel.app/cheat-sheet.html" style="background: #1a1a1a; color: white; padding: 12px 24px; text-decoration: none; border-radius: 4px; display: inline-block; font-weight: 500;">Open the Cheat Sheet →</a></p>

  <p style="font-size: 14px; color: #555;">When you're ready to scan a real RFQ, the analyzer is live: <a href="https://quotescout.vercel.app/" style="color: #7d3a30;">quotescout.vercel.app</a> — free for the first 500 shops, NDA on the next page.</p>

  <hr style="border: none; border-top: 1px solid #eee; margin: 24px 0;">

  <p style="font-size: 13px; color: #777;">— Sid, QuoteScout<br>Reply to this email if you have questions or RFQs you'd like analyzed.</p>

</div>`,

      }).catch(e => console.error('Resend send failed:', e?.message));

    }

    return res.status(200).json({ received: true });

  } catch (err) {

    console.error('waitlist.js error:', err);

    return res.status(500).json({ error: 'Could not save your email. Please try again.' });

  }

}
