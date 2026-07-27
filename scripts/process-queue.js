#!/usr/bin/env node
/**
 * process-queue.js
 * Reads data/article_queue.txt, finds URLs not yet in article_queue_done.txt,
 * generates an article for each via OpenAI, and marks them done.
 */

import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'fs';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, '..');
const QUEUE_FILE = join(ROOT, 'data/article_queue.txt');
const DONE_FILE  = join(ROOT, 'data/article_queue_done.txt');
const NEWS_DIR   = join(ROOT, 'src/content/news');
const OPENAI_API_KEY = process.env.OPENAI_API_KEY || process.env.OPENAI_KEY || '';
const OPENAI_MODEL   = process.env.OPENAI_MODEL || 'gpt-4.1-mini';

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

// ── Queue helpers ─────────────────────────────────────────────────────────────

function readLines(file) {
  if (!existsSync(file)) return [];
  return readFileSync(file, 'utf8')
    .split('\n')
    .map(l => l.trim())
    .filter(l => l && !l.startsWith('#'));
}

function appendDone(url) {
  const line = url + '\n';
  if (existsSync(DONE_FILE)) {
    const current = readFileSync(DONE_FILE, 'utf8');
    writeFileSync(DONE_FILE, current + line, 'utf8');
  } else {
    writeFileSync(DONE_FILE, '# Processed queue URLs — managed automatically, do not edit manually.\n' + line, 'utf8');
  }
}

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
    const ogDesc  = (html.match(/<meta[^>]+property=["']og:description["'][^>]+content=["']([^"']+)["']/i) || [])[1] || '';
    const cleaned = html
      .replace(/<script[\s\S]*?<\/script>/gi, '')
      .replace(/<style[\s\S]*?<\/style>/gi, '')
      .replace(/<nav[\s\S]*?<\/nav>/gi, '')
      .replace(/<header[\s\S]*?<\/header>/gi, '')
      .replace(/<footer[\s\S]*?<\/footer>/gi, '')
      .replace(/<[^>]+>/g, ' ')
      .replace(/\s{2,}/g, ' ')
      .trim();
    return { pageTitle: ogTitle || pageTitle, description: ogDesc || metaDesc, bodyText: cleaned.slice(0, 3000) };
  } catch {
    clearTimeout(t);
    return null;
  }
}

// ── Slug helpers ──────────────────────────────────────────────────────────────

function extractSourceInfo(url) {
  try {
    const u = new URL(url);
    const segments = u.pathname.replace(/\/$/, '').split('/').filter(Boolean);
    const slug = segments[segments.length - 1] || '';
    const pageTitle = slug.replace(/[-_]/g, ' ').replace(/\b\w/g, c => c.toUpperCase());
    return { domain: u.hostname.replace(/^www\./, ''), sourceName: u.hostname.replace(/^www\./, ''), pageTitle };
  } catch {
    return { domain: url, sourceName: url, pageTitle: '' };
  }
}

function titleToSlug(title) {
  return title.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 80);
}

function urlToSlug(url) {
  try {
    const path = new URL(url).pathname.replace(/\/$/, '');
    const seg = path.split('/').filter(Boolean).pop() || 'article';
    return seg.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 80);
  } catch {
    return 'article-' + Date.now();
  }
}

// ── OpenAI ────────────────────────────────────────────────────────────────────

async function callOpenAI(messages) {
  if (!OPENAI_API_KEY) throw new Error('No OpenAI API key');
  const res = await fetch('https://api.openai.com/v1/chat/completions', {
    method: 'POST',
    headers: { 'Authorization': `Bearer ${OPENAI_API_KEY}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ model: OPENAI_MODEL, temperature: 0.75, max_tokens: 1800, messages }),
  });
  if (!res.ok) throw new Error(`OpenAI ${res.status}: ${(await res.text()).slice(0, 200)}`);
  return (await res.json()).choices?.[0]?.message?.content?.trim() || '';
}

async function generateArticle(url) {
  const { domain, sourceName, pageTitle: slugTitle } = extractSourceInfo(url);
  const categoryList = CATEGORIES.join(', ');

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
11. CONTEXTUAL LINK: Somewhere in the body (not the opening paragraph, not a call-to-action), embed exactly one markdown link to the source URL. The anchor text must be a natural phrase from the sentence — a specific claim, figure, or detail from the source. Never use "read more", "click here", "full story", "original article", or the page title as anchor text.

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

  const get = key => { const m = raw.match(new RegExp(`^${key}:\\s*(.+)$`, 'm')); return m ? m[1].trim() : ''; };
  const category = CATEGORIES.includes(get('CATEGORY')) ? get('CATEGORY') : 'tech';
  const title = get('TITLE') || pageTitle;
  const description = get('DESCRIPTION') || `Our take on: ${pageTitle}`;
  const summary = get('SUMMARY') || '';
  const factsMatch = raw.match(/^KEY_FACTS:\s*\n([\s\S]*?)(?=^ARTICLE:)/m);
  const keyFacts = factsMatch
    ? factsMatch[1].trim().split('\n').map(l => l.replace(/^[-*]\s*/, '').trim()).filter(Boolean)
    : [];
  const articleMatch = raw.match(/^ARTICLE:\s*\n([\s\S]*?)\nEND_ARTICLE/m);
  const sourceMatch  = raw.match(/^ATTRIBUTION:\s*\n([\s\S]*?)$/m);
  let body = articleMatch ? articleMatch[1].trim() : raw;
  body = body.replace(/SOURCE_URL/g, url);
  const sourceLine = sourceMatch ? sourceMatch[1].trim() : `Originally reported by ${sourceName}.`;

  return { category, title, description, summary, keyFacts, body, sourceLine, sourceName, domain };
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
  writeFileSync(join(dir, `${slug}.md`), frontmatter + body + `\n\n---\n\n${sourceLine}\n`, 'utf8');
}

// ── Main ──────────────────────────────────────────────────────────────────────

async function main() {
  if (!OPENAI_API_KEY) {
    console.error('No OpenAI API key. Set OPENAI_API_KEY or OPENAI_KEY.');
    process.exit(1);
  }

  const queued = readLines(QUEUE_FILE);
  const done   = new Set(readLines(DONE_FILE));
  const pending = queued.filter(url => !done.has(url));

  console.log(`Queue: ${queued.length} total | ${done.size} done | ${pending.length} pending`);
  if (pending.length === 0) {
    console.log('Nothing new in queue. Exiting.');
    return;
  }

  let generated = 0;
  for (const url of pending) {
    console.log(`\n[${generated + 1}/${pending.length}] ${url}`);
    try {
      const { category, title, description, summary, keyFacts, body, sourceLine, sourceName } = await generateArticle(url);
      let slug = titleToSlug(title);
      if (!slug) slug = urlToSlug(url);
      const pubDate = new Date().toISOString().split('T')[0];

      if (existsSync(join(NEWS_DIR, category, `${slug}.md`))) {
        console.log(`  ⊘ Slug already exists: ${category}/${slug} — marking done anyway`);
        appendDone(url);
        continue;
      }

      writeArticle({ slug, category, title, description, summary, keyFacts, body, sourceLine, pubDate, sourceName, sourceUrl: url });
      appendDone(url);
      console.log(`  ✓ ${category}/${slug}`);
      generated++;
    } catch (e) {
      console.error(`  ✗ Failed: ${e.message}`);
      // Not marked done — will retry next run
    }
    await new Promise(r => setTimeout(r, 500));
  }

  console.log(`\nDone. Generated ${generated} articles from queue.`);
}

main().catch(e => { console.error(e); process.exit(1); });
