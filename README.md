# quotescout
QuoteScout V1
QuoteScout V1

AI tool for RFQ risk analysis in manufacturing.

Upload a PDF → get risks before you quote.

What it does
Reads RFQ PDFs (including scanned drawings)
Flags risks:
🔴 High-risk issues
🟠 Missing/unclear requirements
🟡 Things to double-check
Requires NDA before use
Does NOT store uploaded files
What it does NOT do
No pricing
No cycle times
No quoting

This is a risk detection tool, not an estimating system.

Stack
Frontend: HTML / CSS / JS
Backend: Vercel serverless
DB: Supabase (NDA + logs)
AI: Claude (Anthropic API)
Setup
1. Add environment variables (Vercel)

ANTHROPIC_API_KEY=your_key
SUPABASE_URL=https://xxxx.supabase.co
SUPABASE_ANON_KEY=your_key

⚠️ No /rest/v1/, no quotes, no trailing slash

2. Supabase (important)

Enable insert policy:

CREATE POLICY "Allow insert"
ON nda_acceptances
FOR INSERT
TO anon
WITH CHECK (true);
3. Deploy
Push to GitHub
Import into Vercel
Deploy
Flow
User accepts NDA
Uploads PDF
AI analyzes document
Returns risk flags
File is discarded
Known Issues
Large PDFs may be slow (up to 60s)
Single document only (no multi-file RFQs yet)
Purpose

Catch what estimators miss under time pressure.

Status

V1 – early stage, testing with real RFQs
