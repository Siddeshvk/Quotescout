// =====================================================================
// QuoteScout — /api/cleanup-uploads
// =====================================================================
// Safety net for the ONE gap in "deleted immediately after analysis": a user who
// gets signed URLs, uploads, but then abandons WITHOUT clicking Analyze (so
// analyze.js never runs its delete). This sweeps any object in `rfq-uploads`
// older than MAX_AGE and removes it.
//
// The happy path is already covered: analyze.js deletes each file in a `finally`
// the moment it finishes reading it. This job only mops up orphans.
//
// Trigger via Vercel Cron (add to vercel.json). On Hobby, Cron runs at most once
// per day — that's fine, because orphans are harmless (private bucket, no access)
// and are swept on the next run. Gated by CRON_SECRET so it can't be triggered by
// randoms; Vercel Cron sends `Authorization: Bearer ${CRON_SECRET}` automatically.
// =====================================================================

import { createClient } from '@supabase/supabase-js';

const supabaseAdmin = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_ANON_KEY
);

const BUCKET = 'rfq-uploads';
const ROOT = 'uploads';
const MAX_AGE_MS = 60 * 60 * 1000; // 1 hour — older than this is an abandoned orphan

export default async function handler(req, res) {
  // Only Vercel Cron (or a manual call carrying the secret) may run this.
  const auth = req.headers['authorization'] || '';
  if (process.env.CRON_SECRET && auth !== `Bearer ${process.env.CRON_SECRET}`) {
    return res.status(401).json({ error: 'Unauthorized' });
  }

  const cutoff = Date.now() - MAX_AGE_MS;
  let scanned = 0;
  let removed = 0;

  try {
    // Batch folders live at uploads/{batchId}/. List them, then their files.
    const { data: folders, error: e1 } = await supabaseAdmin
      .storage.from(BUCKET)
      .list(ROOT, { limit: 1000, sortBy: { column: 'name', order: 'asc' } });
    if (e1) throw e1;

    for (const folder of folders || []) {
      if (!folder || !folder.name) continue;
      const prefix = `${ROOT}/${folder.name}`;
      const { data: objs, error: e2 } = await supabaseAdmin
        .storage.from(BUCKET)
        .list(prefix, { limit: 1000 });
      if (e2) { console.error('list', prefix, e2.message); continue; }

      const toRemove = [];
      for (const o of objs || []) {
        if (!o || !o.name) continue;
        scanned++;
        const created = new Date(o.created_at || o.updated_at || 0).getTime();
        // Remove if we can't determine age (no timestamp) or it's past the cutoff.
        if (!created || created < cutoff) toRemove.push(`${prefix}/${o.name}`);
      }

      if (toRemove.length) {
        const { error: e3 } = await supabaseAdmin.storage.from(BUCKET).remove(toRemove);
        if (e3) console.error('remove batch', prefix, e3.message);
        else removed += toRemove.length;
      }
    }

    return res.status(200).json({ ok: true, scanned, removed });
  } catch (e) {
    console.error('cleanup-uploads error:', e && e.message);
    return res.status(500).json({ ok: false, error: e && e.message });
  }
}
