// =====================================================================
// QuoteScout — /api/upload-url
// =====================================================================
// Part of the direct-to-Storage upload path that bypasses Vercel's 4.5 MB
// request-body limit. The browser calls this (tiny JSON in/out, so no body-limit
// issue) to get a short-lived SIGNED UPLOAD URL for each file, then PUTs the bytes
// STRAIGHT to Supabase Storage — never through this function. analyze.js later
// downloads each object (service-role), processes it, and DELETES it immediately.
//
// Access model: the bucket `rfq-uploads` is PRIVATE. This endpoint uses the
// service-role key to mint the signed URLs; the browser uploads with the signed
// URL (pre-authorized, no key needed). No anon Storage policy is required.
//
// Requires: SUPABASE_SERVICE_ROLE_KEY set in Vercel, and a private bucket named
// `rfq-uploads`. Requires @supabase/supabase-js v2 (createSignedUploadUrl).
// =====================================================================

import { createClient } from '@supabase/supabase-js';

const supabaseAdmin = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_ANON_KEY
);

const BUCKET = 'rfq-uploads';
const MAX_FILE_BYTES = 50 * 1024 * 1024; // 50 MB per file (also enforced on the bucket)
const MAX_FILES = 8;

// Reduce a filename to a safe Storage key segment (keeps extension).
function safeName(name) {
  const cleaned = String(name || 'file')
    .replace(/[^a-zA-Z0-9._-]/g, '_')
    .replace(/_{2,}/g, '_')
    .slice(0, 120);
  return cleaned || 'file';
}

function uuid() {
  return (globalThis.crypto && globalThis.crypto.randomUUID)
    ? globalThis.crypto.randomUUID()
    : `${Date.now()}-${Math.random().toString(16).slice(2)}`;
}

export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed.' });

  // Body is small JSON; Vercel parses it into req.body (guard for a string too).
  let body = req.body;
  if (typeof body === 'string') { try { body = JSON.parse(body); } catch { body = {}; } }
  body = body || {};

  const email = (body.email || '').toString().trim().toLowerCase();
  const files = Array.isArray(body.files) ? body.files : [];

  if (!email) return res.status(400).json({ error: 'Email required.' });
  if (!files.length) return res.status(400).json({ error: 'No files provided.' });
  if (files.length > MAX_FILES) {
    return res.status(400).json({ error: `Too many files (max ${MAX_FILES}).` });
  }

  // NDA gate — same enforcement as analyze.js: only signers get upload URLs.
  // Uses the service-role client so the RLS-protected nda_acceptances read works.
  try {
    const { data: ndaRows, error: ndaErr } = await supabaseAdmin
      .from('nda_acceptances')
      .select('email')
      .eq('email', email)
      .limit(1);
    if (ndaErr) {
      console.error('upload-url NDA check error (allowing through):', ndaErr.message);
    } else if (!ndaRows || ndaRows.length === 0) {
      return res.status(403).json({
        error: 'Please sign the mutual NDA before uploading. It protects both sides — sign it once and your upload will go straight through.',
        nda_required: true,
      });
    }
  } catch (e) {
    console.error('upload-url NDA check threw (allowing through):', e && e.message);
  }

  // One folder per upload batch: uploads/{batchId}/{safe filename}
  const batchId = uuid();
  const uploads = [];

  for (let i = 0; i < files.length; i++) {
    const f = files[i];
    const size = Number(f && f.size) || 0;
    if (size > MAX_FILE_BYTES) {
      return res.status(413).json({
        error: `"${f && f.name}" is ${(size / 1048576).toFixed(1)} MB — over the ${MAX_FILE_BYTES / 1048576} MB per-file limit.`,
      });
    }

    // Index-prefix keeps two files with the same name from colliding in the batch.
    const path = `uploads/${batchId}/${i}-${safeName(f && f.name)}`;
    const { data, error } = await supabaseAdmin.storage.from(BUCKET).createSignedUploadUrl(path);
    if (error) {
      console.error('createSignedUploadUrl failed:', error.message);
      return res.status(500).json({ error: 'Could not create an upload URL.', detail: error.message });
    }

    uploads.push({
      name: (f && f.name) || null,
      path: data.path || path,        // pass back to /api/analyze
      token: data.token,              // for supabase-js uploadToSignedUrl(path, token, file)
      signedUrl: data.signedUrl,      // for a raw PUT of the file bytes
    });
  }

  // Signed upload URLs are short-lived (Supabase default ~2h). The browser should
  // upload immediately, then hand the `path`s (not the bytes) to /api/analyze.
  return res.status(200).json({ bucket: BUCKET, batchId, uploads });
}
