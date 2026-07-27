#!/usr/bin/env node
/**
 * download-batch.js
 * Polls the pending OpenAI batch, downloads results when complete,
 * writes articles as Markdown, and updates the CSV.
 */

import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'fs';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, '..');
const CSV_FILE = join(ROOT, 'data/urls_discovered.csv');
const BATCH_FILE = join(ROOT, 'data/pending_batch.json');
const NEWS_DIR = join(ROOT, 'src/content/news');
const OPENAI_API_KEY = process.env.OPENAI_API_KEY || process.env.OPENAI_KEY || '';

const CATEGORIES = [
  'tech', 'ai', 'business', 'finance', 'health', 'science',
  'world', 'sports', 'entertainment', 'travel', 'lifestyle',
  'education', 'environment', 'gaming',
];

// ── OpenAI helpers ────────────────────────────────────────────────────────────

async function getBatchStatus(batchId) {
  const res = await fetch(`https://api.openai.com/v1/batches/${batchId}`, {
    headers: { 'Authorization': `Bearer ${OPENAI_API_KEY}` },
  });
  if (!res.ok) throw new Error(`Get batch failed: ${await res.text()}`);
  return await res.json();
}

async function downloadFile(fileId) {
  const res = await fetch(`https://api.openai.com/v1/files/${fileId}/content`, {
    headers: { 'Authorization': `Bearer ${OPENAI_API_KEY}` },
  });
  if (!res.ok) throw new Error(`Download file failed: ${await res.text()}`);
  return await res.text();
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

function titleToSlug(title) {
  return title.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 80);
}

function urlToSlug(url) {
  try {
    const segments = new URL(url).pathname.replace(/\/$/, '').split('/').filter(Boolean);
    return (segments[segments.length - 1] || 'article')
      .toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 80);
  } catch {
    return 'article';
  }
}

// ── Article parser ────────────────────────────────────────────────────────────

function parseArticle(raw, fallbackTitle, url, sourceName) {
  const get = (key) => {
    const m = raw.match(new RegExp(`^${key}:\\s*(.+)$`, 'm'));
    return m ? m[1].trim() : '';
  };

  const category = CATEGORIES.includes(get('CATEGORY')) ? get('CATEGORY') : 'tech';
  const title = get('TITLE') || fallbackTitle;
  const description = get('DESCRIPTION') || `Our take on: ${fallbackTitle}`;
  const summary = get('SUMMARY') || '';

  const factsMatch = raw.match(/^KEY_FACTS:\s*\n([\s\S]*?)(?=^ARTICLE:)/m);
  const keyFacts = factsMatch
    ? factsMatch[1].trim().split('\n').map(l => l.replace(/^[-*]\s*/, '').trim()).filter(Boolean)
    : [];

  const articleMatch = raw.match(/^ARTICLE:\s*\n([\s\S]*?)\nEND_ARTICLE/m);
  const attrMatch = raw.match(/^ATTRIBUTION:\s*\n([\s\S]*?)$/m);

  let body = articleMatch ? articleMatch[1].trim() : '';
  body = body.replace(/SOURCE_URL/g, url);

  const sourceLine = attrMatch ? attrMatch[1].trim() : `Originally reported by ${sourceName}.`;

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
    console.error('No OpenAI API key. Set OPENAI_API_KEY or OPENAI_KEY.');
    process.exit(1);
  }

  if (!existsSync(BATCH_FILE)) {
    console.log('No pending batch file found. Run submit-batch.js first.');
    return;
  }

  const batchMeta = JSON.parse(readFileSync(BATCH_FILE, 'utf8'));

  if (batchMeta.status !== 'submitted') {
    console.log(`Batch status is "${batchMeta.status}" — nothing to download.`);
    return;
  }

  console.log(`Checking batch ${batchMeta.batch_id}...`);
  const batch = await getBatchStatus(batchMeta.batch_id);
  console.log(`Status: ${batch.status} | Completed: ${batch.request_counts?.completed}/${batch.request_counts?.total}`);

  if (batch.status === 'failed' || batch.status === 'cancelled' || batch.status === 'expired') {
    console.error(`Batch ${batch.status}. Resetting batch_pending URLs to pending.`);
    const { headers, rows } = parseCSV(readFileSync(CSV_FILE, 'utf8'));
    for (const row of rows) {
      if (row.status === 'batch_pending') row.status = 'pending';
    }
    writeFileSync(CSV_FILE, serializeCSV(headers, rows), 'utf8');
    writeFileSync(BATCH_FILE, JSON.stringify({ ...batchMeta, status: batch.status }, null, 2), 'utf8');
    process.exit(1);
  }

  if (batch.status !== 'completed') {
    console.log(`Batch not ready yet (${batch.status}). Try again later.`);
    process.exit(0);
  }

  // Download results
  console.log(`\nDownloading results (file: ${batch.output_file_id})...`);
  const outputText = await downloadFile(batch.output_file_id);
  const results = outputText.trim().split('\n').map(line => JSON.parse(line));
  console.log(`Downloaded ${results.length} results.`);

  // Load CSV
  const { headers, rows } = parseCSV(readFileSync(CSV_FILE, 'utf8'));
  const urlMeta = batchMeta.url_meta;

  const pubDate = new Date().toISOString().split('T')[0];
  let generated = 0;
  let skipped = 0;
  let failed = 0;

  for (const result of results) {
    const customId = result.custom_id;
    const meta = urlMeta[customId];
    if (!meta) { console.warn(`Unknown custom_id: ${customId}`); continue; }

    const row = rows[meta.rowIndex];
    if (!row) continue;

    if (result.error) {
      console.error(`  ✗ ${meta.url}: ${result.error.message}`);
      row.status = 'failed';
      failed++;
      continue;
    }

    const raw = result.response?.body?.choices?.[0]?.message?.content?.trim() || '';
    if (!raw) {
      console.error(`  ✗ ${meta.url}: empty response`);
      row.status = 'failed';
      failed++;
      continue;
    }

    const { category, title, description, summary, keyFacts, body, sourceLine } = parseArticle(
      raw, meta.pageTitle, meta.url, meta.sourceName
    );

    if (!body || body.length < 200) {
      console.error(`  ✗ ${meta.url}: body too short (${body.length} chars)`);
      row.status = 'failed';
      failed++;
      continue;
    }

    let slug = titleToSlug(title);
    if (!slug) slug = urlToSlug(meta.url);

    // Skip if slug already exists (first come first served)
    if (existsSync(join(NEWS_DIR, category, `${slug}.md`))) {
      console.log(`  ⊘ Skipped (slug exists): ${category}/${slug}`);
      row.status = 'skipped';
      skipped++;
      continue;
    }

    const filePath = writeArticle({
      slug, category, title, description, summary, keyFacts, body, sourceLine,
      pubDate, sourceName: meta.sourceName, sourceUrl: meta.url,
    });

    row.status = 'processed';
    row.category = category;
    row.article_slug = `${category}/${slug}`;

    console.log(`  ✓ ${category}/${slug} (${body.split(' ').length} words)`);
    generated++;
  }

  writeFileSync(CSV_FILE, serializeCSV(headers, rows), 'utf8');

  // Mark batch as done
  writeFileSync(BATCH_FILE, JSON.stringify({ ...batchMeta, status: 'completed', completed_at: new Date().toISOString() }, null, 2), 'utf8');

  console.log(`\nDone. Generated: ${generated} | Skipped: ${skipped} | Failed: ${failed}`);
}

main().catch(e => { console.error(e); process.exit(1); });
