#!/usr/bin/env node
/**
 * submit-batch.js
 * Reads pending URLs from CSV, fetches page content, builds an OpenAI
 * Batch API request file, uploads it, and submits the batch.
 * Saves batch metadata to data/pending_batch.json.
 * Marks processed URLs as batch_pending in the CSV.
 */

import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'fs';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, '..');
const CSV_FILE = join(ROOT, 'data/urls_discovered.csv');
const BATCH_FILE = join(ROOT, 'data/pending_batch.json');
const DAILY_LIMIT = parseInt(process.env.DAILY_LIMIT || '20', 10);
const OPENAI_API_KEY = process.env.OPENAI_API_KEY || process.env.OPENAI_KEY || '';
const OPENAI_MODEL = process.env.OPENAI_MODEL || 'gpt-4.1-mini';
const PER_SOURCE_CAP = 3;

// ── Site identity (optional multi-site support) ───────────────────────────────
const SITE_ID = process.env.SITE_ID || '';
let siteConfig = null;
if (SITE_ID) {
  const sitesPath = join(ROOT, 'sites/sites.config.json');
  if (existsSync(sitesPath)) {
    const all = JSON.parse(readFileSync(sitesPath, 'utf8'));
    siteConfig = all.sites.find(s => s.siteId === SITE_ID) || null;
    if (siteConfig) console.log(`Site identity: ${siteConfig.name} (${siteConfig.persona})`);
    else console.warn(`SITE_ID "${SITE_ID}" not found in sites.config.json — using default identity`);
  }
}

const CATEGORIES = [
  'tech', 'ai', 'business', 'finance', 'health', 'science',
  'world', 'sports', 'entertainment', 'travel', 'lifestyle',
  'education', 'environment', 'gaming',
];

// ── Page content fetcher ──────────────────────────────────────────────────────

async function fetchPageContent(url) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), 15000);
  try {
    const res = await fetch(url, {
      headers: { 'User-Agent': 'Mozilla/5.0 (compatible; NewsBot/1.0)', 'Accept': 'text/html' },
      signal: ctrl.signal,
      redirect: 'follow',
    });
    clearTimeout(t);
    if (!res.ok) return null;
    const html = await res.text();

    const titleMatch = html.match(/<title[^>]*>([^<]+)<\/title>/i);
    const pageTitle = titleMatch ? titleMatch[1].replace(/\s*[|\-–]\s*.+$/, '').trim() : '';
    const metaMatch = html.match(/<meta[^>]+name=["']description["'][^>]+content=["']([^"']+)["']/i)
      || html.match(/<meta[^>]+content=["']([^"']+)["'][^>]+name=["']description["']/i);
    const metaDesc = metaMatch ? metaMatch[1].trim() : '';
    const ogTitle = (html.match(/<meta[^>]+property=["']og:title["'][^>]+content=["']([^"']+)["']/i) || [])[1] || '';
    const ogDesc = (html.match(/<meta[^>]+property=["']og:description["'][^>]+content=["']([^"']+)["']/i) || [])[1] || '';
    const cleaned = html
      .replace(/<script[\s\S]*?<\/script>/gi, '')
      .replace(/<style[\s\S]*?<\/style>/gi, '')
      .replace(/<nav[\s\S]*?<\/nav>/gi, '')
      .replace(/<header[\s\S]*?<\/header>/gi, '')
      .replace(/<footer[\s\S]*?<\/footer>/gi, '')
      .replace(/<[^>]+>/g, ' ')
      .replace(/\s{2,}/g, ' ')
      .trim();

    return {
      pageTitle: ogTitle || pageTitle,
      description: ogDesc || metaDesc,
      bodyText: cleaned.slice(0, 3000),
    };
  } catch {
    clearTimeout(t);
    return null;
  }
}

// ── CSV helpers ───────────────────────────────────────────────────────────────

function parseCSV(text) {
  const lines = text.trim().split('\n');
  if (lines.length < 2) return { headers: lines[0]?.split(',') || [], rows: [] };
  const headers = lines[0].split(',').map(h => h.trim());
  const rows = lines.slice(1).map(line => {
    const values = [];
    let cur = '', inQuote = false;
    for (const ch of line) {
      if (ch === '"') { inQuote = !inQuote; continue; }
      if (ch === ',' && !inQuote) { values.push(cur.trim()); cur = ''; continue; }
      cur += ch;
    }
    values.push(cur.trim());
    const obj = {};
    headers.forEach((h, i) => obj[h] = values[i] ?? '');
    return obj;
  });
  return { headers, rows };
}

function serializeCSV(headers, rows) {
  const escape = v => (v.includes(',') || v.includes('"') || v.includes('\n'))
    ? `"${v.replace(/"/g, '""')}"` : v;
  return [headers.join(','), ...rows.map(r => headers.map(h => escape(r[h] ?? '')).join(','))].join('\n') + '\n';
}

// ── Slug helpers ──────────────────────────────────────────────────────────────

function extractSourceInfo(url) {
  try {
    const u = new URL(url);
    const segments = u.pathname.replace(/\/$/, '').split('/').filter(Boolean);
    const slug = segments[segments.length - 1] || '';
    const pageTitle = slug.replace(/[-_]/g, ' ').replace(/\b\w/g, c => c.toUpperCase());
    return { domain: u.hostname.replace(/^www\./, ''), pageTitle };
  } catch {
    return { domain: url, pageTitle: '' };
  }
}

// ── Prompt builder ────────────────────────────────────────────────────────────

function buildMessages(url, sourceName, page) {
  const { domain, pageTitle: slugTitle } = extractSourceInfo(url);
  const categoryList = CATEGORIES.join(', ');

  const sourceExcerpt = page
    ? `Page title: ${page.pageTitle}\nMeta description: ${page.description}\nPage content excerpt:\n${page.bodyText}`
    : `(Could not fetch page — use URL slug "${slugTitle}" as the topic basis)`;

  const siteName = siteConfig?.name || 'Demo News Aggregator';
  const siteAngleBlock = siteConfig
    ? `\nEDITORIAL IDENTITY:\n${siteConfig.systemPromptAddition}\n`
    : '';

  const systemPrompt = `You are a senior journalist at ${siteName} writing SEO-optimised original news pieces.
${siteAngleBlock}
WRITING RULES:
1. Do not open with "[Company] announced," "According to," or "A new report has found."
2. Maximum 3 lines per paragraph.
3. Zero em dashes anywhere.
4. Headline under 70 chars, sentence case, angle-driven. Primary keyword in first 60 chars.
5. At least one analytical point not in original source.
6. Build around angle, don't summarize in order.
7. Closing: verdict, open question, or pattern close.
8. Total article body 450-550 words. Do not stop early.
9. No exclamation points. No speculation presented as fact.
10. Use ## subheadings for all named sections.
11. CONTEXTUAL LINK: Somewhere in the body (not the opening paragraph, not a call-to-action), embed exactly one markdown link to the source URL. The anchor text must be a natural phrase from the sentence — a specific claim, figure, or detail from the source. Never use "read more", "click here", "full story", "original article", or the page title as anchor text. Example: "the company's [decision to cut 2,000 roles](SOURCE_URL) came without warning" — not "see the [full article](SOURCE_URL)".

ANGLE — choose one and commit to it:
1. Industry implication: what this means for a specific audience
2. The overlooked detail: something the original glossed over
3. The practical takeaway: convert the story to actionable advice
4. The broader context: connect this to a larger trend
5. The skeptical read: apply critical analysis to a claim

VOICE: First-person plural ("we", "our read") for analysis OR objective third-person. Never mix within a paragraph.`;

  const userPrompt = `Source URL: ${url}
Source site: ${sourceName} (${domain})
Available categories: ${categoryList}

SOURCE CONTENT:
${sourceExcerpt}

---

Write a complete SEO-structured news piece. Format EXACTLY as below (no code fences, no extra text):

CATEGORY: <one word from: ${categoryList}>
TITLE: <headline under 70 chars, sentence case, primary keyword in first 60 chars>
DESCRIPTION: <150-155 chars: primary keyword + what happened + your angle>
SUMMARY: <2-3 sentence executive summary of your angle and key takeaway>
KEY_FACTS:
- <fact 1 from source, with context>
- <fact 2 from source, with context>
- <fact 3 from source, with context>
ARTICLE:
<opening paragraph: state your angle immediately, 60-80 words, hook the reader — NO source link here>

## <Section heading with secondary keyword>
<context + facts woven with analysis, 90-110 words, 2-3 paragraphs max 3 lines each — embed the contextual link somewhere in this section using SOURCE_URL as the URL placeholder>

## <Section heading with LSI keyword>
<implications or deeper analysis, 90-110 words, at least one forward-looking sentence>

## <Section heading>
<practical or critical angle, 70-90 words, concrete — give reader something to do or think about>

<closing paragraph: verdict or open question, 60-80 words, strong final sentence, NO heading>
END_ARTICLE
ATTRIBUTION:
Originally reported by ${sourceName}.`;

  return [
    { role: 'system', content: systemPrompt },
    { role: 'user', content: userPrompt },
  ];
}

// ── OpenAI Batch API ──────────────────────────────────────────────────────────

async function uploadBatchFile(jsonlContent) {
  const blob = new Blob([jsonlContent], { type: 'application/octet-stream' });
  const form = new FormData();
  form.append('purpose', 'batch');
  form.append('file', blob, 'batch_input.jsonl');

  const res = await fetch('https://api.openai.com/v1/files', {
    method: 'POST',
    headers: { 'Authorization': `Bearer ${OPENAI_API_KEY}` },
    body: form,
  });
  if (!res.ok) throw new Error(`File upload failed: ${await res.text()}`);
  return (await res.json()).id;
}

async function submitBatch(fileId) {
  const res = await fetch('https://api.openai.com/v1/batches', {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${OPENAI_API_KEY}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      input_file_id: fileId,
      endpoint: '/v1/chat/completions',
      completion_window: '24h',
    }),
  });
  if (!res.ok) throw new Error(`Batch submit failed: ${await res.text()}`);
  return await res.json();
}

// ── Main ──────────────────────────────────────────────────────────────────────

async function main() {
  if (!OPENAI_API_KEY) {
    console.error('No OpenAI API key. Set OPENAI_API_KEY or OPENAI_KEY.');
    process.exit(1);
  }

  // Check if there's already a pending batch
  if (existsSync(BATCH_FILE)) {
    const existing = JSON.parse(readFileSync(BATCH_FILE, 'utf8'));
    if (existing.status === 'submitted') {
      console.log(`Batch ${existing.batch_id} already pending (submitted ${existing.submitted_at}). Skipping.`);
      return;
    }
  }

  const { headers, rows } = (() => {
    if (!existsSync(CSV_FILE)) return { headers: [], rows: [] };
    return parseCSV(readFileSync(CSV_FILE, 'utf8'));
  })();

  const pending = rows.filter(r => r.status === 'pending');
  console.log(`Pending URLs: ${pending.length} | Limit: ${DAILY_LIMIT} | Cap: ${PER_SOURCE_CAP}/source`);

  const sourceCounts = {};
  const toProcess = [];
  for (const row of pending) {
    if (toProcess.length >= DAILY_LIMIT) break;
    const count = sourceCounts[row.source] || 0;
    if (count >= PER_SOURCE_CAP) continue;
    sourceCounts[row.source] = count + 1;
    toProcess.push(row);
  }

  if (toProcess.length === 0) {
    console.log('No pending URLs after per-source cap. Nothing to submit.');
    return;
  }
  console.log(`After per-source cap: ${toProcess.length} to submit`);

  // Build batch requests — fetch page content first
  const requests = [];
  const urlMeta = {}; // custom_id -> {url, sourceName, pageTitle}

  for (let i = 0; i < toProcess.length; i++) {
    const row = toProcess[i];
    const customId = `article-${i}`;
    console.log(`[${i + 1}/${toProcess.length}] Fetching content: ${row.url}`);

    const page = await fetchPageContent(row.url);
    const { pageTitle: slugTitle } = extractSourceInfo(row.url);
    const pageTitle = page?.pageTitle || slugTitle;

    urlMeta[customId] = { url: row.url, sourceName: row.source, pageTitle, rowIndex: rows.indexOf(row) };

    requests.push(JSON.stringify({
      custom_id: customId,
      method: 'POST',
      url: '/v1/chat/completions',
      body: {
        model: OPENAI_MODEL,
        temperature: 0.75,
        max_tokens: 1800,
        messages: buildMessages(row.url, row.source, page),
      },
    }));

    // Small pause between page fetches
    await new Promise(r => setTimeout(r, 300));
  }

  const jsonlContent = requests.join('\n');
  console.log(`\nUploading batch file (${requests.length} requests)...`);
  const fileId = await uploadBatchFile(jsonlContent);
  console.log(`File uploaded: ${fileId}`);

  console.log('Submitting batch...');
  const batch = await submitBatch(fileId);
  console.log(`Batch submitted: ${batch.id} | Status: ${batch.status}`);

  // Save batch metadata
  mkdirSync(join(ROOT, 'data'), { recursive: true });
  writeFileSync(BATCH_FILE, JSON.stringify({
    batch_id: batch.id,
    file_id: fileId,
    submitted_at: new Date().toISOString(),
    status: 'submitted',
    url_count: requests.length,
    url_meta: urlMeta,
  }, null, 2), 'utf8');

  // Mark URLs as batch_pending in CSV
  for (const [customId, meta] of Object.entries(urlMeta)) {
    rows[meta.rowIndex].status = 'batch_pending';
  }
  writeFileSync(CSV_FILE, serializeCSV(headers, rows), 'utf8');

  console.log(`\nDone. Batch ${batch.id} submitted with ${requests.length} articles.`);
  console.log('Run download-batch.js in ~12 hours to collect results.');
}

main().catch(e => { console.error(e); process.exit(1); });
