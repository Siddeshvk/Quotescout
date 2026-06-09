// =====================================================================
// QuoteScout — /api/health
// =====================================================================
// Keep-alive + status check. Two jobs:
//   1. Touch the Supabase database so the free-tier project never hits
//      its 7-day inactivity pause. (A paused project is unreachable
//      until you manually click "Restore" in the Supabase dashboard, so
//      the goal is to PREVENT the pause, not recover from it.)
//   2. Give you one URL to confirm the API + DB are awake before a demo.
//
// HOW TO KEEP IT ALIVE (pick one):
//   A) Free external monitor (recommended, zero config risk):
//      UptimeRobot -> add an HTTP(s) monitor pointing at
//      https://quotescout.vercel.app/api/health  every 5 minutes.
//      This both keeps the DB awake AND keeps this function warm.
//   B) Native Vercel Cron (no third party, but daily only on Hobby):
//      add this to vercel.json:  "crons":[{"path":"/api/health","schedule":"0 7 * * *"}]
//
// A plain homepage ping does NOT count as DB activity. This route runs a
// real (tiny, read-only) query, which is what resets the inactivity timer.
//
// Returns 200 when the DB answered, 503 when it did not — so your monitor
// doubles as a "the database is down / paused" alarm. Read-only; no secrets.
// =====================================================================

import { createClient } from '@supabase/supabase-js';

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_ANON_KEY
);

export const config = { maxDuration: 10 };

export default async function handler(req, res) {
  const startedAt = Date.now();
  let dbOk = false;
  let dbError = null;

  try {
    // Tiny read against a table that always exists (the seeded standards KB).
    // head:true returns no rows — we only care that Postgres was touched.
    const { error } = await supabase
      .from('standards_kb')
      .select('spec_number', { count: 'exact', head: true });

    if (error) {
      dbError = error.message || String(error);
    } else {
      dbOk = true;
    }
  } catch (e) {
    dbError = (e && e.message) ? e.message : String(e);
  }

  res.setHeader('Cache-Control', 'no-store');
  return res.status(dbOk ? 200 : 503).json({
    ok: dbOk,
    db: dbOk ? 'awake' : 'unreachable',
    db_error: dbError ? dbError.slice(0, 200) : null,
    ms: Date.now() - startedAt,
    at: new Date().toISOString(),
  });
}
