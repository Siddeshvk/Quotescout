// =====================================================================
// QuoteScout — /api/job-status
// =====================================================================
// Two callers:
//   - Frontend (active user): GET ?jobId=XXX every 30s
//   - External cron (cron-job.org): POST {} every 5 min
//
// What it does:
//   - If jobId provided: status of one specific job
//   - If no jobId: scan all queued/in_progress jobs, process completed ones
//
// Idempotency: once a job is 'complete', we never re-process or re-email it.
// =====================================================================

import { createClient } from '@supabase/supabase-js';
import Anthropic from '@anthropic-ai/sdk';
import nodemailer from 'nodemailer';

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_ANON_KEY
);

const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

const transporter = (process.env.GMAIL_USER && process.env.GMAIL_APP_PASSWORD)
  ? nodemailer.createTransport({
      host: 'smtp.gmail.com',
      port: 465,
      secure: true,
      auth: {
        user: process.env.GMAIL_USER,
        pass: process.env.GMAIL_APP_PASSWORD,
      },
    })
  : null;

// Gmail forces the From address to be your own account; only the display
// name is freely settable. FROM_EMAIL is therefore your Gmail address.
const FROM_EMAIL = process.env.GMAIL_USER || '';

export const config = { maxDuration: 60 };

export default async function handler(req, res) {
  try {
    let jobId = null;
    if (req.method === 'GET') {
      jobId = req.query?.jobId || null;
    } else if (req.method === 'POST') {
      const body = typeof req.body === 'string' ? JSON.parse(req.body || '{}') : (req.body || {});
      jobId = body.jobId || null;
    } else {
      return res.status(405).json({ error: 'Method not allowed. Use GET ?jobId=XXX or POST {}.' });
    }

    if (jobId) {
      const result = await processJob(jobId);
      return res.status(200).json(result);
    }

    // Cron mode — scan all pending jobs, process completed ones
    const { data: pendingJobs, error } = await supabase
      .from('analysis_jobs')
      .select('job_id')
      .in('status', ['queued', 'in_progress'])
      .lt('submitted_at', new Date(Date.now() - 60000).toISOString()) // older than 1 min
      .order('submitted_at', { ascending: true })
      .limit(10);

    if (error) {
      console.error('Pending jobs query failed:', error.message);
      return res.status(500).json({ error: 'Could not query pending jobs.', detail: error.message });
    }

    const processed = [];
    for (const job of (pendingJobs || [])) {
      try {
        const result = await processJob(job.job_id);
        processed.push({ jobId: job.job_id, status: result.status });
      } catch (e) {
        console.error(`Job ${job.job_id} processing failed:`, e.message);
        processed.push({ jobId: job.job_id, status: 'error', error: e.message });
      }
    }

    return res.status(200).json({
      scanned: pendingJobs?.length || 0,
      processed,
      timestamp: new Date().toISOString(),
    });

  } catch (err) {
    console.error('job-status error:', err);
    return res.status(500).json({ error: err.message?.slice(0, 300) });
  }
}

// =====================================================================
// Core processing logic — checks one job's status, fetches results if
// done, sends email + stores result.
// =====================================================================
async function processJob(jobId) {
  // 1. Look up the job
  const { data: job, error: jobErr } = await supabase
    .from('analysis_jobs')
    .select('*')
    .eq('job_id', jobId)
    .single();

  if (jobErr || !job) {
    return { status: 'not_found', error: 'Job not found.' };
  }

  // 2. If already complete or failed, return cached state
  if (job.status === 'complete') {
    return {
      status: 'complete',
      analysis: {
        verdict: job.result_verdict || null,
        verdictReason: job.result_verdict_reason || '',
        summary: job.result_summary || '',
        clarifications: job.result_clarifications || [],
        flags: job.result_flags || [],
        flagCounts: job.result_counts || { red: 0, amber: 0, yellow: 0, purple: 0 },
      },
      analysisId: job.id,
      submittedAt: job.submitted_at,
      completedAt: job.completed_at,
      emailSentAt: job.email_sent_at,
      wantsEmail: !!job.email_opt_in,
    };
  }

  if (job.status === 'failed') {
    return {
      status: 'failed',
      error: job.error_message || 'Analysis failed.',
      submittedAt: job.submitted_at,
    };
  }

  // 3. Check Anthropic batch status
  let batch;
  try {
    batch = await anthropic.messages.batches.retrieve(job.batch_id);
  } catch (e) {
    console.error(`Batch retrieve failed for ${job.batch_id}:`, e.message);
    return {
      status: job.status,
      error: 'Could not check AI service. Will retry on next poll.',
      submittedAt: job.submitted_at,
    };
  }

  // 4. Still processing
  if (batch.processing_status === 'in_progress') {
    if (job.status === 'queued') {
      await supabase.from('analysis_jobs').update({ status: 'in_progress' }).eq('job_id', jobId);
    }
    return {
      status: 'in_progress',
      submittedAt: job.submitted_at,
      message: 'Analysis still processing. Most complete in 5-30 minutes.',
    };
  }

  // 5. Canceled or expired
  if (batch.processing_status === 'canceled' || batch.processing_status === 'expired') {
    await supabase.from('analysis_jobs').update({
      status: 'failed',
      error_message: `Batch ${batch.processing_status}`,
      completed_at: new Date().toISOString(),
    }).eq('job_id', jobId);
    return {
      status: 'failed',
      error: `The AI service marked this batch as ${batch.processing_status}. This is rare — please re-submit the RFQ.`,
    };
  }

  // 6. Ended — fetch results
  if (batch.processing_status === 'ended') {
    let analysisResult = null;
    let resultError = null;

    try {
      // Anthropic returns results as a JSONL stream
      const stream = await anthropic.messages.batches.results(job.batch_id);
      for await (const item of stream) {
        if (item.custom_id !== jobId) continue;

        if (item.result.type === 'succeeded') {
          // Parse the AI text response
          const message = item.result.message;
          let aiText = '';
          if (Array.isArray(message.content)) {
            for (const block of message.content) {
              if (block.type === 'text') aiText += block.text;
            }
          }
          aiText = aiText.trim();

          // Strip code fences
          if (aiText.startsWith('```')) {
            aiText = aiText.replace(/^```(?:json)?\s*/, '').replace(/\s*```$/, '').trim();
          }

          const parseAttempt = tryParseAIResponse(aiText, message.stop_reason);
          if (parseAttempt.ok) {
            analysisResult = parseAttempt.data;
            if (parseAttempt.recovered) {
              console.warn(`Job ${jobId}: AI response was truncated, recovered ${parseAttempt.flagsRecovered} complete flags. stop_reason=${message.stop_reason}`);
            }
          } else {
            resultError = `${parseAttempt.error}\n\nstop_reason=${message.stop_reason || 'unknown'}\nResponse started: "${aiText.slice(0, 200)}"\nResponse ended: "${aiText.slice(-200)}"`;
          }
        } else if (item.result.type === 'errored') {
          resultError = `AI service error: ${item.result.error?.message || item.result.error?.type || 'unknown'}`;
        } else if (item.result.type === 'canceled') {
          resultError = 'AI request was canceled.';
        } else if (item.result.type === 'expired') {
          resultError = 'AI request expired without completion.';
        }
        break;
      }

      if (!analysisResult && !resultError) {
        resultError = 'No matching result found in batch output.';
      }
    } catch (e) {
      resultError = `Could not retrieve batch results: ${e.message?.slice(0, 200)}`;
    }

    if (resultError) {
      await supabase.from('analysis_jobs').update({
        status: 'failed',
        error_message: resultError.slice(0, 1000),
        completed_at: new Date().toISOString(),
      }).eq('job_id', jobId);
      return { status: 'failed', error: resultError };
    }

    // 7. Handle vision-detected ITAR (parsed from AI response)
    if (analysisResult.itar_detected === true) {
      await supabase.from('analysis_jobs').update({
        status: 'failed',
        error_message: 'Vision-detected ITAR/export-control markers in document(s).',
        completed_at: new Date().toISOString(),
      }).eq('job_id', jobId);
      return {
        status: 'failed',
        error: 'This document contains markers (ITAR, EAR, DDTC, MIL-SPEC defense, classified, or CUI) that indicate it may be export-controlled or defense-related work. QuoteScout is for non-ITAR commercial work only.',
      };
    }

    // 8. Compute flag counts
    const flags = Array.isArray(analysisResult.flags) ? analysisResult.flags : [];
    const counts = { red: 0, amber: 0, yellow: 0, purple: 0 };
    flags.forEach(f => {
      const s = (f.severity || 'PURPLE').toLowerCase();
      if (counts[s] !== undefined) counts[s]++;
    });

    // 9. Update job to complete (idempotent — atomic upsert)
    const completedAt = new Date().toISOString();
    const verdict = typeof analysisResult.verdict === 'string' ? analysisResult.verdict : null;
    const verdictReason = analysisResult.verdict_reason || '';
    const clarifications = Array.isArray(analysisResult.customer_clarifications)
      ? analysisResult.customer_clarifications
      : [];
    const updates = {
      status: 'complete',
      result_summary: analysisResult.summary || '',
      result_flags: flags,
      result_counts: counts,
      result_flag_count: flags.length,
      result_verdict: verdict,
      result_verdict_reason: verdictReason,
      result_clarifications: clarifications,
      completed_at: completedAt,
    };

    // 10. Send email ONLY IF user opted in AND we haven't already sent
    // (Idempotent — every poll checks email_sent_at)
    if (job.email_opt_in && !job.email_sent_at && transporter) {
      try {
        await sendReportEmail({
          to: job.user_email,
          companyName: job.company_name,
          fileNames: (job.file_names || '').split(' + ').filter(Boolean),
          analysisId: job.id,
          counts,
          flags,
          summary: analysisResult.summary || '',
          verdict,
          verdictReason,
          clarifications,
        });
        updates.email_sent_at = completedAt;
      } catch (e) {
        console.error(`Email send failed for job ${jobId}:`, e.message);
        // Continue — analysis is still complete, just no email
      }
    }

    // Defensive: if the migration v1.6 hasn't run yet, Supabase will reject
    // the unknown columns. Catch and retry without the new fields so old
    // deployments still work.
    let updateResult = await supabase.from('analysis_jobs').update(updates).eq('job_id', jobId);
    if (updateResult.error && /result_verdict|result_clarifications/.test(updateResult.error.message || '')) {
      console.warn('Migration v1.6 not applied yet — falling back to legacy column set.');
      delete updates.result_verdict;
      delete updates.result_verdict_reason;
      delete updates.result_clarifications;
      await supabase.from('analysis_jobs').update(updates).eq('job_id', jobId);
    }

    return {
      status: 'complete',
      analysis: {
        verdict,
        verdictReason,
        summary: analysisResult.summary || '',
        clarifications,
        flags,
        flagCounts: counts,
      },
      analysisId: job.id,
      submittedAt: job.submitted_at,
      completedAt,
      emailSentAt: updates.email_sent_at || null,
      wantsEmail: !!job.email_opt_in,
    };
  }

  // Fallback — unknown status
  return {
    status: 'in_progress',
    submittedAt: job.submitted_at,
    message: `AI service returned status: ${batch.processing_status}. Will retry.`,
  };
}

// =====================================================================
// Email helper (same shape as analyze.js originally had)
// =====================================================================
async function sendReportEmail({ to, companyName, fileNames, analysisId, counts, flags, summary, verdict, verdictReason, clarifications }) {
  const fileList = (fileNames || []).join(', ') || '(pasted email body)';
  const totalFlags = (counts.red || 0) + (counts.amber || 0) + (counts.yellow || 0) + (counts.purple || 0);

  const verdictMeta = {
    READY_TO_QUOTE: { label: 'Ready to quote', bg: '#dcfce7', fg: '#166534', icon: '✓' },
    QUOTE_WITH_ASSUMPTIONS: { label: 'Quote with assumptions', bg: '#fef3c7', fg: '#92400e', icon: '⚠' },
    CLARIFICATIONS_REQUIRED: { label: 'Clarifications required', bg: '#fef3c7', fg: '#92400e', icon: '?' },
    RECOMMEND_NO_BID: { label: 'Recommend no-bid', bg: '#fee2e2', fg: '#991b1b', icon: '✕' },
  };
  const v = verdictMeta[verdict] || null;
  const verdictHtml = v ? `
    <div style="background: ${v.bg}; padding: 14px 18px; border-radius: 6px; margin-bottom: 20px;">
      <div style="font-size: 11px; letter-spacing: 0.08em; color: ${v.fg}; font-weight: 700; text-transform: uppercase;">${v.icon} Verdict</div>
      <div style="font-size: 18px; font-weight: 600; color: ${v.fg}; margin-top: 4px;">${v.label}</div>
      ${verdictReason ? `<div style="font-size: 13px; color: ${v.fg}; margin-top: 6px; opacity: 0.9;">${escapeHtml(verdictReason)}</div>` : ''}
    </div>` : '';

  const clarsArr = Array.isArray(clarifications) ? clarifications : [];
  const priorityColor = {
    BLOCKING: '#b91c1c',
    IMPORTANT: '#b45309',
    NICE_TO_HAVE: '#555',
  };
  const clarsHtml = clarsArr.length > 0 ? `
    <div style="border: 1px solid #e5dfd0; border-radius: 6px; padding: 14px 18px; margin: 16px 0; background: white;">
      <div style="font-size: 11px; font-weight: 700; letter-spacing: 0.08em; color: #1a1816; margin-bottom: 10px; text-transform: uppercase;">📞 Ask the Customer (${clarsArr.length})</div>
      <ol style="margin: 0; padding-left: 20px;">
        ${clarsArr.map(c => `
          <li style="margin-bottom: 10px; line-height: 1.5;">
            <div style="font-size: 14px; color: #1a1816;">${escapeHtml(c.question || '')}</div>
            ${c.priority ? `<span style="display: inline-block; font-size: 10px; letter-spacing: 0.06em; color: ${priorityColor[c.priority] || '#555'}; font-weight: 700; margin-top: 2px;">${(c.priority || '').replace('_', ' ')}</span>` : ''}
            ${c.why ? `<div style="font-size: 12px; color: #666; margin-top: 2px;">${escapeHtml(c.why)}</div>` : ''}
          </li>`).join('')}
      </ol>
    </div>` : '';

  const flagHtml = (flags || []).slice(0, 30).map(f => {
    const sevColor = {
      RED: '#b91c1c',
      AMBER: '#b45309',
      YELLOW: '#a16207',
      PURPLE: '#7c3aed',
    }[(f.severity || 'PURPLE').toUpperCase()] || '#555';
    const conf = (typeof f.confidence === 'number') ? `${f.confidence}%` : '—';
    return `
<div style="border-left: 3px solid ${sevColor}; padding: 12px 16px; margin: 12px 0; background: #fafafa; border-radius: 0 4px 4px 0;">
  <div style="font-size: 10px; font-weight: 700; color: ${sevColor}; letter-spacing: 0.08em;">${(f.severity || '').toUpperCase()} · ${(f.category || '').toUpperCase()} · ${conf}</div>
  <div style="font-weight: 600; margin-top: 6px; font-size: 15px;">${escapeHtml(f.title || '')}</div>
  ${f.recommendedAction ? `<div style="font-size: 13px; color: #1a1816; margin-top: 8px; padding: 8px 10px; background: white; border-radius: 3px; border-left: 2px solid ${sevColor};"><strong style="font-size: 11px; letter-spacing: 0.06em; text-transform: uppercase; color: ${sevColor};">Action: </strong>${escapeHtml(f.recommendedAction)}</div>` : ''}
  ${f.description ? `<div style="font-size: 13px; margin-top: 8px; color: #555; line-height: 1.5;">${escapeHtml(f.description)}</div>` : ''}
  <div style="margin-top: 8px; display: flex; flex-wrap: wrap; gap: 8px; font-size: 11px; color: #777;">
    ${f.impact ? `<span style="background: #f0e9d6; color: #5a4520; padding: 3px 8px; border-radius: 3px; font-weight: 600;">${escapeHtml(f.impact)}</span>` : ''}
    ${f.location ? `<span>📍 ${escapeHtml(f.location)}</span>` : ''}
  </div>
</div>`;
  }).join('');

  const outcomeUrl = analysisId
    ? `https://quotescout.vercel.app/outcome.html?id=${encodeURIComponent(analysisId)}`
    : null;

  const html = `
<div style="font-family: -apple-system, system-ui, 'Segoe UI', sans-serif; max-width: 680px; margin: 0 auto; color: #1a1a1a; line-height: 1.55; padding: 16px;">
  <div style="border-bottom: 2px solid #1a1a1a; padding-bottom: 12px; margin-bottom: 20px;">
    <h2 style="font-weight: 600; font-size: 20px; margin: 0;">QuoteScout — Risk Report</h2>
    <div style="font-size: 13px; color: #666; margin-top: 4px;">${escapeHtml(fileList)}${companyName ? ` · ${escapeHtml(companyName)}` : ''}</div>
  </div>

  ${verdictHtml}

  <div style="background: #f5f1e8; padding: 14px 18px; border-left: 3px solid #7d3a30; margin-bottom: 16px; border-radius: 0 4px 4px 0;">
    <div style="font-size: 11px; font-weight: 700; color: #7d3a30; letter-spacing: 0.08em;">EXECUTIVE SUMMARY</div>
    <div style="margin-top: 6px; font-size: 14px;">${escapeHtml(summary || 'See flags below.')}</div>
  </div>

  ${clarsHtml}

  <div style="display: flex; gap: 10px; flex-wrap: wrap; margin: 20px 0 8px;">
    <span style="background: #fef2f2; color: #b91c1c; padding: 5px 11px; border-radius: 4px; font-size: 12px; font-weight: 700;">RED ${counts.red || 0}</span>
    <span style="background: #fffbeb; color: #b45309; padding: 5px 11px; border-radius: 4px; font-size: 12px; font-weight: 700;">AMBER ${counts.amber || 0}</span>
    <span style="background: #fefce8; color: #a16207; padding: 5px 11px; border-radius: 4px; font-size: 12px; font-weight: 700;">YELLOW ${counts.yellow || 0}</span>
    <span style="background: #f5f3ff; color: #7c3aed; padding: 5px 11px; border-radius: 4px; font-size: 12px; font-weight: 700;">PURPLE ${counts.purple || 0}</span>
  </div>

  <h3 style="font-size: 15px; margin-top: 20px; color: #333;">Detailed Findings (${totalFlags})</h3>
  ${flagHtml || '<p style="color: #777;">No flags surfaced.</p>'}

  <div style="background: #fafafa; border: 1px solid #e5e5e5; padding: 14px; margin-top: 24px; font-size: 13px; color: #555;">
    <strong>Mandatory disclaimer:</strong> All flags require verification by qualified engineering personnel before pricing. QuoteScout does not price jobs, guarantee manufacturability, or replace engineering judgment.
  </div>

  ${outcomeUrl ? `
  <div style="margin-top: 24px; padding: 16px; border: 1px dashed #999; text-align: center;">
    <p style="margin: 0 0 12px;"><strong>Help us improve.</strong> When this RFQ closes, tell us what happened.</p>
    <a href="${outcomeUrl}" style="background: #1a1a1a; color: white; padding: 10px 20px; text-decoration: none; border-radius: 4px; display: inline-block; font-weight: 500;">Track this outcome →</a>
    <p style="margin: 12px 0 0; font-size: 12px; color: #777;">This is the data loop. Every outcome reported makes the system sharper for the next shop.</p>
  </div>` : ''}

  <hr style="border: none; border-top: 1px solid #eee; margin: 32px 0 16px;">
  <p style="font-size: 12px; color: #888;">QuoteScout · risk-surfacing engine for precision manufacturing RFQs · Built by Sid K · Reply to this email with feedback or to talk shop.</p>
</div>`;

  await transporter.sendMail({
    from: `"QuoteScout" <${FROM_EMAIL}>`,
    to,
    subject: `QuoteScout risk report — ${fileList.length > 60 ? (fileNames?.[0] || 'package') + ' + others' : fileList} (${totalFlags} flags)`,
    html,
  });
}

function escapeHtml(s) {
  if (typeof s !== 'string') return '';
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

// =====================================================================
// Robust AI-response parser. Handles three scenarios:
//   1. Clean JSON → direct parse
//   2. JSON wrapped in prose / fences → extract outermost {...}
//   3. JSON truncated mid-flag-array (max_tokens hit) → salvage complete
//      flags, append "]}", and parse the recovered structure.
//
// Returns: { ok: true, data, recovered?, flagsRecovered? } OR { ok: false, error }
// =====================================================================
function tryParseAIResponse(text, stopReason) {
  // Strategy 1: parse as-is
  try {
    return { ok: true, data: JSON.parse(text) };
  } catch (e1) {
    // continue to recovery
  }

  // Strategy 2: extract outermost {...}
  const firstBrace = text.indexOf('{');
  const lastBrace = text.lastIndexOf('}');
  if (firstBrace !== -1 && lastBrace > firstBrace) {
    try {
      return { ok: true, data: JSON.parse(text.slice(firstBrace, lastBrace + 1)) };
    } catch (e2) {
      // continue to recovery
    }
  }

  // Strategy 3: truncated flags-array recovery.
  // Only attempt if response looks like it was cut off mid-generation
  // (stop_reason='max_tokens' is the strongest signal, but we also try
  // when the text starts with '{' but doesn't end cleanly with '}').
  const looksTruncated = stopReason === 'max_tokens'
    || (firstBrace !== -1 && (lastBrace === -1 || lastBrace < text.length - 50));

  if (!looksTruncated || firstBrace === -1) {
    return {
      ok: false,
      error: `JSON parse failed and response doesn't look recoverably truncated.`,
    };
  }

  const partial = text.slice(firstBrace);

  // Locate the "flags": [ ... ] array opening
  const flagsKeyMatch = partial.match(/"flags"\s*:\s*\[/);
  if (!flagsKeyMatch) {
    return {
      ok: false,
      error: 'JSON parse failed and no "flags" array found to recover.',
    };
  }

  const arrayOpenIdx = partial.indexOf('[', flagsKeyMatch.index);
  if (arrayOpenIdx === -1) {
    return { ok: false, error: 'Could not locate flags array opening bracket.' };
  }

  // Walk the array, tracking depth and string-state, to find the last
  // complete flag object (i.e. the last balanced `{...}` at depth 1).
  let depth = 0;
  let inString = false;
  let escapeNext = false;
  let lastCompleteFlagEnd = -1;

  for (let i = arrayOpenIdx + 1; i < partial.length; i++) {
    const c = partial[i];
    if (escapeNext) { escapeNext = false; continue; }
    if (c === '\\') { escapeNext = true; continue; }
    if (c === '"') { inString = !inString; continue; }
    if (inString) continue;
    if (c === '{') depth++;
    else if (c === '}') {
      depth--;
      if (depth === 0) lastCompleteFlagEnd = i;
    }
  }

  if (lastCompleteFlagEnd === -1) {
    // Array opened but no complete flag inside — recover with empty array
    const empty = partial.slice(0, arrayOpenIdx + 1) + ']}';
    try {
      const parsed = JSON.parse(empty);
      return { ok: true, data: parsed, recovered: true, flagsRecovered: 0 };
    } catch {
      return { ok: false, error: 'No complete flags to recover and stub parse also failed.' };
    }
  }

  // Reconstruct: everything up to and including last complete flag, + ]}
  const reconstructed = partial.slice(0, lastCompleteFlagEnd + 1) + ']}';

  try {
    const parsed = JSON.parse(reconstructed);
    // Count how many flags survived
    const flagsRecovered = Array.isArray(parsed.flags) ? parsed.flags.length : 0;

    // Add a marker so the email/UI can show that the analysis was truncated
    parsed._truncated = true;
    if (!parsed.summary) {
      parsed.summary = `[Analysis truncated by token limit — ${flagsRecovered} complete flags recovered. The AI hit its output cap. Re-submit with fewer files or a more targeted email body for a complete analysis.]`;
    } else {
      parsed.summary = `[TRUNCATED — ${flagsRecovered} flags recovered] ` + parsed.summary;
    }

    return { ok: true, data: parsed, recovered: true, flagsRecovered };
  } catch (e) {
    return {
      ok: false,
      error: `Truncation recovery parse failed: ${e.message?.slice(0, 150)}`,
    };
  }
}
