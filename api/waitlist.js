// =====================================================================
// QuoteScout — /api/waitlist (with module-load diagnostics)
// =====================================================================

import { createClient } from '@supabase/supabase-js';
import { Resend } from 'resend';

console.log('=== waitlist.js module load ===');
console.log('RESEND_API_KEY present:', !!process.env.RESEND_API_KEY);
console.log('RESEND_API_KEY length:', (process.env.RESEND_API_KEY || '').length);
console.log('RESEND_API_KEY starts with re_:', (process.env.RESEND_API_KEY || '').startsWith('re_'));
console.log('RESEND_FROM_EMAIL value:', JSON.stringify(process.env.RESEND_FROM_EMAIL));
console.log('SUPABASE_URL present:', !!process.env.SUPABASE_URL);
console.log('SUPABASE_ANON_KEY present:', !!process.env.SUPABASE_ANON_KEY);

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_ANON_KEY
);

const resend = process.env.RESEND_API_KEY
  ? new Resend(process.env.RESEND_API_KEY)
  : null;

console.log('Resend client created:', !!resend);

const FROM_EMAIL = process.env.RESEND_FROM_EMAIL || 'reports@quotescout.com';
console.log('Effective FROM_EMAIL:', FROM_EMAIL);

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

    console.log(`[waitlist] handling submission for: ${email}`);

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
        console.log(`[waitlist] ${email} already exists — re-sending cheat sheet anyway.`);
      } else {
        console.error('[waitlist] Supabase insert failed:', error);
      }
    } else {
      console.log(`[waitlist] Supabase insert OK for ${email}`);
    }

    // Email send (await this one so we can see what happens in logs)
    if (resend) {
      console.log(`[waitlist] About to call Resend.emails.send for ${email} from ${FROM_EMAIL}`);
      try {
        const sendResult = await resend.emails.send({
          from: `QuoteScout <${FROM_EMAIL}>`,
          to: email,
          subject: 'Your Sequence Risk Cheat Sheet — QuoteScout',
          html: `
<div style="font-family: -apple-system, system-ui, sans-serif; max-width: 560px; margin: 0 auto; color: #1a1a1a; line-height: 1.55;">
  <h2 style="font-weight: 600; font-size: 22px; margin: 0 0 16px;">Your Sequence Risk Cheat Sheet</h2>
  <p>Thanks for joining the QuoteScout waitlist. Here's the one-pager you signed up for — twelve precision-machining estimating risks that quietly destroy margin.</p>
  <p><a href="https://quotescout.vercel.app/cheat-sheet.html" style="background: #1a1a1a; color: white; padding: 12px 24px; text-decoration: none; border-radius: 4px; display: inline-block; font-weight: 500;">Open the Cheat Sheet →</a></p>
  <p style="font-size: 14px; color: #555;">When you're ready to scan a real RFQ, the analyzer is live: <a href="https://quotescout.vercel.app/" style="color: #7d3a30;">quotescout.vercel.app</a> — free for the first 500 shops, NDA on the next page.</p>
  <hr style="border: none; border-top: 1px solid #eee; margin: 24px 0;">
  <p style="font-size: 13px; color: #777;">— Sid, QuoteScout<br>Reply to this email if you have questions or RFQs you'd like analyzed.</p>
</div>`,
        });
        console.log('[waitlist] Resend send result:', JSON.stringify(sendResult));
      } catch (sendErr) {
        console.error('[waitlist] Resend send threw:', sendErr?.message, sendErr);
      }
    } else {
      console.warn('[waitlist] resend is null — RESEND_API_KEY likely missing at module load');
    }

    return res.status(200).json({ received: true });

  } catch (err) {
    console.error('[waitlist] handler error:', err);
    return res.status(500).json({ error: 'Could not save your email. Please try again.' });
  }
}
