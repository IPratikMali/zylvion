#!/usr/bin/env node
/**
 * generate-articles.js
 * Reads pending URLs from data/urls_discovered.csv, generates opinion articles
 * via OpenAI, writes them as Markdown to src/content/news/{category}/{slug}.md,
 * and marks URLs as processed in the CSV.
 */

import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'fs';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, '..');
const CSV_FILE = join(ROOT, 'data/urls_discovered.csv');
const NEWS_DIR = join(ROOT, 'src/content/news');
const DAILY_LIMIT = parseInt(process.env.DAILY_LIMIT || '20', 10);
const OPENAI_API_KEY = process.env.OPENAI_API_KEY || process.env.OPENAI_KEY || '';
const OPENAI_MODEL = process.env.OPENAI_MODEL || 'gpt-4.1-mini';

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

// ── Page content fetcher ─────────────────────────────────────────────────────

async function fetchPageContent(url) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), 15000);
  try {
    const res = await fetch(url, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (compatible; NewsBot/1.0)',
        'Accept': 'text/html',
      },
      signal: ctrl.signal,
      redirect: 'follow',
    });
    clearTimeout(t);
    if (!res.ok) return null;
    const html = await res.text();

    // Extract <title>
    const titleMatch = html.match(/<title[^>]*>([^<]+)<\/title>/i);
    const pageTitle = titleMatch ? titleMatch[1].replace(/\s*[|\-–]\s*.+$/, '').trim() : '';

    // Extract meta description
    const metaMatch = html.match(/<meta[^>]+name=["']description["'][^>]+content=["']([^"']+)["']/i)
      || html.match(/<meta[^>]+content=["']([^"']+)["'][^>]+name=["']description["']/i);
    const metaDesc = metaMatch ? metaMatch[1].trim() : '';

    // Extract og:title and og:description
    const ogTitle = (html.match(/<meta[^>]+property=["']og:title["'][^>]+content=["']([^"']+)["']/i) || [])[1] || '';
    const ogDesc = (html.match(/<meta[^>]+property=["']og:description["'][^>]+content=["']([^"']+)["']/i) || [])[1] || '';

    // Extract readable body text — strip scripts/styles/nav, get paragraphs
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
    // Handle quoted fields
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
  const headerLine = headers.join(',');
  const dataLines = rows.map(r => headers.map(h => escape(r[h] ?? '')).join(','));
  return [headerLine, ...dataLines].join('\n') + '\n';
}

function loadCSV() {
  if (!existsSync(CSV_FILE)) return { headers: [], rows: [] };
  return parseCSV(readFileSync(CSV_FILE, 'utf8'));
}

function saveCSV(headers, rows) {
  writeFileSync(CSV_FILE, serializeCSV(headers, rows), 'utf8');
}

// ── Slug generation ───────────────────────────────────────────────────────────

function urlToSlug(url) {
  try {
    const path = new URL(url).pathname.replace(/\/$/, '');
    const segments = path.split('/').filter(Boolean);
    const last = segments[segments.length - 1] || 'article';
    return last
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, 80);
  } catch {
    return 'article-' + Date.now();
  }
}

function titleToSlug(title) {
  return title
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 80);
}

function extractSourceInfo(url) {
  try {
    const u = new URL(url);
    const path = u.pathname.replace(/\/$/, '');
    const segments = path.split('/').filter(Boolean);
    const slug = segments[segments.length - 1] || '';
    const pageTitle = slug.replace(/[-_]/g, ' ').replace(/\b\w/g, c => c.toUpperCase());
    return { domain: u.hostname.replace(/^www\./, ''), pageTitle };
  } catch {
    return { domain: url, pageTitle: '' };
  }
}

// ── OpenAI ────────────────────────────────────────────────────────────────────

async function callOpenAI(messages) {
  if (!OPENAI_API_KEY) throw new Error('No OpenAI API key');
  const res = await fetch('https://api.openai.com/v1/chat/completions', {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${OPENAI_API_KEY}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      model: OPENAI_MODEL,
      temperature: 0.75,
      max_tokens: 1800,
      messages,
    }),
  });
  if (!res.ok) {
    const err = await res.text();
    throw new Error(`OpenAI ${res.status}: ${err.slice(0, 200)}`);
  }
  const data = await res.json();
  return data.choices?.[0]?.message?.content?.trim() || '';
}

async function generateArticle(url, sourceName) {
  const { domain, pageTitle: slugTitle } = extractSourceInfo(url);
  const categoryList = CATEGORIES.join(', ');

  console.log(`  Fetching page content...`);
  const page = await fetchPageContent(url);
  const pageTitle = page?.pageTitle || slugTitle;
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

  const raw = await callOpenAI([
    { role: 'system', content: systemPrompt },
    { role: 'user', content: userPrompt },
  ]);

  // Parse response
  const get = (key) => {
    const m = raw.match(new RegExp(`^${key}:\\s*(.+)$`, 'm'));
    return m ? m[1].trim() : '';
  };

  const category = CATEGORIES.includes(get('CATEGORY')) ? get('CATEGORY') : 'tech';
  const title = get('TITLE') || pageTitle;
  const description = get('DESCRIPTION') || `Our take on: ${pageTitle}`;
  const summary = get('SUMMARY') || '';

  // Parse key facts list
  const factsMatch = raw.match(/^KEY_FACTS:\s*\n([\s\S]*?)(?=^ARTICLE:)/m);
  const keyFacts = factsMatch
    ? factsMatch[1].trim().split('\n').map(l => l.replace(/^[-*]\s*/, '').trim()).filter(Boolean)
    : [];

  const articleMatch = raw.match(/^ARTICLE:\s*\n([\s\S]*?)\nEND_ARTICLE/m);
  const sourceMatch = raw.match(/^ATTRIBUTION:\s*\n([\s\S]*?)$/m);

  // Replace SOURCE_URL placeholder with real URL
  let body = articleMatch ? articleMatch[1].trim() : raw;
  body = body.replace(/SOURCE_URL/g, url);

  const sourceLine = sourceMatch ? sourceMatch[1].trim() : `Originally reported by ${sourceName}.`;

  return { category, title, description, summary, keyFacts, body, sourceLine };
}

// ── Markdown writer ───────────────────────────────────────────────────────────

function writeArticle({ slug, category, title, description, summary, keyFacts, body, sourceLine, pubDate, sourceName, sourceUrl }) {
  const dir = join(NEWS_DIR, category);
  mkdirSync(dir, { recursive: true });

  const factsYaml = keyFacts.length
    ? `keyFacts:\n${keyFacts.map(f => `  - ${JSON.stringify(f)}`).join('\n')}\n`
    : '';

  const frontmatter = `---
title: ${JSON.stringify(title)}
description: ${JSON.stringify(description)}
summary: ${JSON.stringify(summary)}
${factsYaml}pubDate: ${pubDate}
category: ${category}
source: ${JSON.stringify(sourceUrl)}
sourceSite: ${JSON.stringify(sourceName)}
draft: false
---

`;

  const content = frontmatter + body + `\n\n---\n\n${sourceLine}\n`;
  const filePath = join(dir, `${slug}.md`);
  writeFileSync(filePath, content, 'utf8');
  return filePath;
}

// ── Main ──────────────────────────────────────────────────────────────────────

async function main() {
  if (!OPENAI_API_KEY) {
    console.error('No OpenAI API key found. Set OPENAI_API_KEY or OPENAI_KEY secret.');
    process.exit(1);
  }
  console.log(`Model: ${OPENAI_MODEL} | Limit: ${DAILY_LIMIT} articles`);

  const { headers, rows } = loadCSV();
  const pending = rows.filter(r => r.status === 'pending');
  console.log(`Pending URLs: ${pending.length} | Processing up to ${DAILY_LIMIT}`);

  // Cap at 5 articles per source per run
  const PER_SOURCE_CAP = 3;
  const sourceCounts = {};
  const toProcess = [];
  for (const row of pending) {
    if (toProcess.length >= DAILY_LIMIT) break;
    const count = sourceCounts[row.source] || 0;
    if (count >= PER_SOURCE_CAP) continue;
    sourceCounts[row.source] = count + 1;
    toProcess.push(row);
  }
  console.log(`After per-source cap (${PER_SOURCE_CAP}/source): ${toProcess.length} to process`);

  let generated = 0;

  for (const row of toProcess) {
    const url = row.url;
    console.log(`\n[${generated + 1}/${toProcess.length}] ${url}`);

    try {
      const { category, title, description, summary, keyFacts, body, sourceLine } = await generateArticle(url, row.source);
      // Slug comes from OUR generated title, not the source URL
      let slug = titleToSlug(title);
      if (!slug) slug = urlToSlug(url);
      const pubDate = new Date().toISOString().split('T')[0];

      // First come first served — skip if our slug already exists
      if (existsSync(join(NEWS_DIR, category, `${slug}.md`))) {
        console.log(`  ⊘ Skipped (slug exists): ${slug}`);
        row.status = 'skipped';
        continue;
      }

      const filePath = writeArticle({
        slug, category, title, description, summary, keyFacts, body, sourceLine,
        pubDate, sourceName: row.source, sourceUrl: url,
      });

      // Update CSV row
      row.status = 'processed';
      row.category = category;
      row.article_slug = `${category}/${slug}`;

      console.log(`  ✓ ${category}/${slug} → ${filePath}`);
      generated++;
    } catch (e) {
      console.error(`  ✗ Failed: ${e.message}`);
      row.status = 'failed';
    }

    // Small pause between OpenAI calls
    await new Promise(r => setTimeout(r, 500));
  }

  saveCSV(headers, rows);
  console.log(`\nDone. Generated ${generated} articles.`);
  console.log(`CSV updated: ${CSV_FILE}`);
}

main().catch(e => { console.error(e); process.exit(1); });
