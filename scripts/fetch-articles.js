#!/usr/bin/env node
// scripts/fetch-articles.js
// Fetches articles from RSS feeds + sitemaps, uses OpenAI for sitemap title/desc generation.
// Run by GitHub Actions; writes src/data/articles.json

import { readFileSync, writeFileSync, existsSync } from 'fs';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const OUT_FILE = join(__dirname, '../src/data/articles.json');
const MAX_ARTICLES = 1000;
const MAX_PER_SOURCE = 60;   // cap articles per source for variety
const FETCH_TIMEOUT_MS = 12000;
// Accept either secret name
const OPENAI_API_KEY = process.env.OPENAI_API_KEY || process.env.OPENAI_KEY || '';

const SOURCES = [
  { name: 'WebTechnoto',   rss: 'https://webtechnoto.com/rss.xml',        sitemap: 'https://webtechnoto.com/sitemap.xml' },
  { name: 'GeekiSquad',   rss: 'https://geekisquad.com/rss.xml',         sitemap: 'https://geekisquad.com/sitemap.xml' },
  { name: 'OmniGuru',     rss: 'https://omniguru.net/rss.xml',           sitemap: 'https://omniguru.in/sitemap.xml' },
  { name: 'M2SoftTech',   rss: 'https://m2softtech.com/rss.xml',         sitemap: 'https://m2softtech.com/sitemap.xml' },
  { name: 'TechAuditOrg', rss: 'https://tech-audit.org/rss.xml',         sitemap: 'https://techaudit.in/sitemap.xml' },
  { name: 'DevMatrix',    rss: 'https://www.devmatrix.us.com/rss.xml',   sitemap: 'https://devmatrix.dev/sitemap.xml' },
  { name: 'KnowCasino',   rss: '',                                        sitemap: 'https://knowcasino.org/sitemap.xml' },
  { name: 'TechForthy',   rss: 'https://techforthy.com/rss.xml',         sitemap: 'https://techforthy.com/sitemap.xml' },
  { name: 'DevelopNSolve',rss: '',                                        sitemap: 'https://developnsolve.com/sitemap.xml' },
  { name: 'TechUvy',      rss: 'https://techuvy.com/rss.xml',            sitemap: 'https://techuvy.com/sitemap.xml' },
  { name: 'WebDroid',     rss: 'https://webidroid.com/rss.xml',          sitemap: 'https://webidroid.com/sitemap.xml' },
  { name: 'FactBharat',   rss: 'https://factbharat.com/rss.xml',         sitemap: 'https://factbharat.com/sitemap.xml' },
  { name: 'SmartXox',     rss: 'https://smartxox.com/rss.xml',           sitemap: 'https://smartxox.in/sitemap.xml' },
];

// ── Helpers ──────────────────────────────────────────────────────────────────

async function fetchText(url) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), FETCH_TIMEOUT_MS);
  try {
    const res = await fetch(url, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (compatible; NewsAggregator/1.0)',
        'Accept': '*/*',
      },
      signal: ctrl.signal,
      redirect: 'follow',
    });
    clearTimeout(t);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return await res.text();
  } catch (e) {
    clearTimeout(t);
    throw e;
  }
}

function decodeEntities(str) {
  if (!str) return '';
  return str
    .replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"').replace(/&#039;/g, "'").replace(/&apos;/g, "'")
    .replace(/&#(\d+);/g, (_, n) => String.fromCharCode(Number(n)))
    .replace(/&#x([0-9a-f]+);/gi, (_, h) => String.fromCharCode(parseInt(h, 16)));
}

function stripHtml(str) {
  if (!str) return '';
  return str
    .replace(/<!\[CDATA\[([\s\S]*?)\]\]>/gi, '$1')
    .replace(/<script[\s\S]*?<\/script>/gi, '')
    .replace(/<style[\s\S]*?<\/style>/gi, '')
    .replace(/<[^>]+>/g, ' ')
    .replace(/\s{2,}/g, ' ').trim();
}

function getTag(xml, tag) {
  let m = xml.match(new RegExp(`<${tag}[^>]*>\\s*<!\\[CDATA\\[([\\s\\S]*?)\\]\\]>\\s*<\\/${tag}>`, 'i'));
  if (m && m[1].trim()) return m[1].trim();
  m = xml.match(new RegExp(`<${tag}[^>]*>([\\s\\S]*?)<\\/${tag}>`, 'i'));
  if (m) { const v = stripHtml(m[1]).trim(); if (v) return v; }
  return '';
}

function extractLink(chunk) {
  let m = chunk.match(/<link[^>]+rel=["']alternate["'][^>]+href=["']([^"']+)["']/i);
  if (m) return m[1].trim();
  m = chunk.match(/<link[^>]+href=["']([^"']+)["'][^>]*\/?>/i);
  if (m) return m[1].trim();
  m = chunk.match(/<link[^>]*>\s*([^\s<][^<]*?)\s*<\/link>/i);
  if (m && m[1].startsWith('http')) return m[1].trim();
  m = chunk.match(/<link[^>]*><!\[CDATA\[([\s\S]*?)\]\]><\/link>/i);
  if (m) return m[1].trim();
  m = chunk.match(/<guid[^>]*>([^<]+)<\/guid>/i);
  if (m && m[1].trim().startsWith('http')) return m[1].trim();
  return '';
}

// ── RSS parsing ───────────────────────────────────────────────────────────────

function parseRss(xml, sourceName) {
  const items = [];
  const isAtom = /<entry[\s>]/i.test(xml);
  const tag = isAtom ? 'entry' : 'item';
  const re = new RegExp(`<${tag}[\\s>]([\\s\\S]*?)<\\/${tag}>`, 'gi');
  let m;
  while ((m = re.exec(xml)) !== null) {
    const chunk = m[1];
    const title = decodeEntities(getTag(chunk, 'title'));
    const link = extractLink(chunk);
    if (!title || !link) continue;
    const rawDesc =
      getTag(chunk, 'content:encoded') || getTag(chunk, 'description') ||
      getTag(chunk, 'summary') || getTag(chunk, 'content');
    const description = decodeEntities(stripHtml(rawDesc)).slice(0, 250);
    const pubDate =
      getTag(chunk, 'pubDate') || getTag(chunk, 'published') ||
      getTag(chunk, 'updated') || getTag(chunk, 'dc:date') || '';
    const author = decodeEntities(getTag(chunk, 'dc:creator') || getTag(chunk, 'author'));
    const category = decodeEntities(getTag(chunk, 'category'));
    items.push({ title, link, description, pubDate, author, category, source: sourceName, via: 'rss' });
  }
  return items;
}

// ── Sitemap parsing ───────────────────────────────────────────────────────────

function parseSitemap(xml) {
  const urls = [];
  // Handle sitemap index (list of sitemaps)
  const isSitemapIndex = /<sitemapindex/i.test(xml);
  if (isSitemapIndex) {
    const re = /<loc[^>]*>([^<]+)<\/loc>/gi;
    let m;
    while ((m = re.exec(xml)) !== null) urls.push(m[1].trim());
    return { isSitemapIndex: true, urls };
  }
  // Regular sitemap
  const re = /<url>([\s\S]*?)<\/url>/gi;
  let m;
  while ((m = re.exec(xml)) !== null) {
    const chunk = m[1];
    const loc = chunk.match(/<loc[^>]*>([^<]+)<\/loc>/i)?.[1]?.trim();
    const lastmod = chunk.match(/<lastmod[^>]*>([^<]+)<\/lastmod>/i)?.[1]?.trim() || '';
    if (loc) urls.push({ loc, lastmod });
  }
  return { isSitemapIndex: false, urls };
}

function isArticleUrl(url) {
  // Filter out pagination, tag, category, author, search, feed, home pages
  const skip = /\/(page\/|tag\/|tags\/|category\/|categories\/|author\/|search\/|feed\/|wp-content\/|wp-admin\/|\?|#)/i;
  if (skip.test(url)) return false;
  // Must have a slug-like path (at least one path segment with a dash or word chars)
  const path = new URL(url).pathname.replace(/\/$/, '');
  const segments = path.split('/').filter(Boolean);
  if (segments.length < 1) return false;
  const last = segments[segments.length - 1];
  // Must look like an article (has a word, not just numbers)
  return /[a-z]/i.test(last) && last.length > 3;
}

function slugToTitle(url) {
  try {
    const path = new URL(url).pathname.replace(/\/$/, '');
    const segments = path.split('/').filter(Boolean);
    const slug = segments[segments.length - 1];
    return slug.replace(/[-_]/g, ' ').replace(/\b\w/g, c => c.toUpperCase());
  } catch { return url; }
}

// ── OpenAI batch title+desc generation ───────────────────────────────────────

async function generateTitlesAndDescs(urlsWithSources) {
  if (!OPENAI_API_KEY || urlsWithSources.length === 0) {
    // Fallback: use slug as title
    return urlsWithSources.map(({ url, source }) => ({
      url,
      source,
      title: slugToTitle(url),
      description: '',
    }));
  }

  const results = [];
  const BATCH = 20; // URLs per OpenAI request

  for (let i = 0; i < urlsWithSources.length; i += BATCH) {
    const batch = urlsWithSources.slice(i, i + BATCH);
    const prompt = batch.map((item, idx) =>
      `${idx + 1}. URL: ${item.url}`
    ).join('\n');

    try {
      const res = await fetch('https://api.openai.com/v1/chat/completions', {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${OPENAI_API_KEY}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          model: 'gpt-4o-mini',
          temperature: 0.3,
          messages: [
            {
              role: 'system',
              content: `You are a tech news editor. Given a list of article URLs, generate a concise, accurate title and a 1-sentence description for each article based on the URL slug. Return a JSON array with objects: { "title": "...", "description": "..." }. Match the array length to the input list exactly.`,
            },
            {
              role: 'user',
              content: `Generate titles and descriptions for these ${batch.length} article URLs:\n\n${prompt}\n\nReturn only a JSON array of ${batch.length} objects.`,
            },
          ],
          response_format: { type: 'json_object' },
        }),
      });

      if (!res.ok) throw new Error(`OpenAI HTTP ${res.status}`);
      const data = await res.json();
      const content = data.choices?.[0]?.message?.content;
      const parsed = JSON.parse(content);
      const arr = Array.isArray(parsed) ? parsed : (parsed.articles || parsed.results || Object.values(parsed)[0]);

      batch.forEach((item, idx) => {
        results.push({
          url: item.url,
          source: item.source,
          title: arr[idx]?.title || slugToTitle(item.url),
          description: arr[idx]?.description || '',
        });
      });
    } catch (e) {
      console.error(`OpenAI batch failed:`, e.message);
      batch.forEach(item => {
        results.push({
          url: item.url,
          source: item.source,
          title: slugToTitle(item.url),
          description: '',
        });
      });
    }

    // Rate limit pause between batches
    if (i + BATCH < urlsWithSources.length) {
      await new Promise(r => setTimeout(r, 1000));
    }
  }

  return results;
}

// ── Fetch sitemap articles for one source ─────────────────────────────────────

async function fetchSitemapXml(baseUrl) {
  // Try common sitemap paths in order
  const candidates = [
    baseUrl,
    baseUrl.replace(/\/sitemap\.xml$/, '/sitemap_index.xml'),
    baseUrl.replace(/\/sitemap\.xml$/, '/sitemap-index.xml'),
    baseUrl.replace(/\/sitemap\.xml$/, '/post-sitemap.xml'),
    baseUrl.replace(/\/sitemap\.xml$/, '/news-sitemap.xml'),
  ];
  for (const url of candidates) {
    try {
      const xml = await fetchText(url);
      if (xml.includes('<urlset') || xml.includes('<sitemapindex')) return xml;
    } catch {}
  }
  return null;
}

async function fetchSitemapUrls(source) {
  const xml = await fetchSitemapXml(source.sitemap);
  if (!xml) {
    console.warn(`  Sitemap ${source.name}: all paths failed`);
    return [];
  }

  const { isSitemapIndex, urls } = parseSitemap(xml);

  if (isSitemapIndex) {
    const childUrls = [];
    for (const childUrl of urls.slice(0, 5)) {
      try {
        const childXml = await fetchText(childUrl);
        const { urls: childEntries } = parseSitemap(childXml);
        childUrls.push(...childEntries);
      } catch {}
    }
    return childUrls;
  }

  return urls;
}

// ── Main ──────────────────────────────────────────────────────────────────────

async function main() {
  if (OPENAI_API_KEY) {
    console.log(`OpenAI key found (${OPENAI_API_KEY.slice(0, 7)}...)`);
  } else {
    console.warn('No OpenAI key found — checked OPENAI_API_KEY and OPENAI_KEY. Sitemap titles will use URL slugs.');
  }

  // Load existing articles to avoid re-processing
  let existing = [];
  if (existsSync(OUT_FILE)) {
    try { existing = JSON.parse(readFileSync(OUT_FILE, 'utf8')); } catch {}
  }
  const existingUrls = new Set(existing.map(a => a.link));

  console.log(`Existing articles: ${existing.length}`);

  // ── 1. Fetch RSS feeds ────────────────────────────────────────────────────
  console.log('\nFetching RSS feeds...');
  const rssResults = await Promise.allSettled(
    SOURCES.map(async source => {
      if (!source.rss) return [];
      try {
        const xml = await fetchText(source.rss);
        const items = parseRss(xml, source.name).slice(0, MAX_PER_SOURCE);
        console.log(`  RSS ${source.name}: ${items.length} items`);
        return items;
      } catch (e) {
        console.warn(`  RSS ${source.name}: FAILED - ${e.message}`);
        return [];
      }
    })
  );

  const rssArticles = rssResults.flatMap(r => r.status === 'fulfilled' ? r.value : []);
  console.log(`RSS total: ${rssArticles.length} articles`);

  // ── 2. Fetch sitemaps ─────────────────────────────────────────────────────
  console.log('\nFetching sitemaps...');
  const sitemapUrlsPerSource = await Promise.allSettled(
    SOURCES.map(source => fetchSitemapUrls(source).then(urls => ({ source, urls })))
  );

  // Collect new sitemap URLs not already in RSS or existing
  const rssUrls = new Set(rssArticles.map(a => a.link));
  const newSitemapEntries = [];

  for (let i = 0; i < sitemapUrlsPerSource.length; i++) {
    const r = sitemapUrlsPerSource[i];
    if (r.status !== 'fulfilled') continue;
    const { source, urls } = r.value;
    let added = 0;
    for (const entry of urls) {
      const url = typeof entry === 'string' ? entry : entry.loc;
      if (!url) continue;
      if (!isArticleUrl(url)) continue;
      if (rssUrls.has(url)) continue;   // already in RSS
      if (existingUrls.has(url)) continue; // already processed
      const lastmod = typeof entry === 'object' ? entry.lastmod : '';
      newSitemapEntries.push({ url, source: source.name, lastmod });
      added++;
    }
    console.log(`  Sitemap ${source.name}: ${added} new URLs`);
  }

  console.log(`New sitemap URLs to process: ${newSitemapEntries.length}`);

  // ── 3. Generate titles/descs for new sitemap URLs via OpenAI ─────────────
  let sitemapArticles = [];
  if (newSitemapEntries.length > 0) {
    console.log(`\nGenerating titles/descs via OpenAI (${OPENAI_API_KEY ? 'API key found' : 'NO KEY - using slugs'})...`);
    // Limit to 100 new entries per run to control cost
    const toProcess = newSitemapEntries.slice(0, 100);
    const generated = await generateTitlesAndDescs(
      toProcess.map(e => ({ url: e.url, source: e.source }))
    );
    sitemapArticles = generated.map((g, idx) => ({
      title: g.title,
      link: g.url,
      description: g.description,
      pubDate: toProcess[idx].lastmod || '',
      author: '',
      category: '',
      source: g.source,
      via: 'sitemap',
    }));
    console.log(`Generated ${sitemapArticles.length} sitemap articles`);
  }

  // ── 4. Merge, deduplicate, sort ───────────────────────────────────────────
  const allNew = [...rssArticles, ...sitemapArticles];
  const newUrls = new Set(allNew.map(a => a.link));

  // Keep existing that aren't in new RSS (stale RSS items preserved)
  const kept = existing.filter(a => !newUrls.has(a.link)).slice(0, 200);

  const merged = [...allNew, ...kept];

  // Deduplicate by link
  const seen = new Set();
  const deduped = merged.filter(a => {
    if (seen.has(a.link)) return false;
    seen.add(a.link);
    return true;
  });

  deduped.sort((a, b) => {
    const da = a.pubDate ? new Date(a.pubDate).getTime() : 0;
    const db = b.pubDate ? new Date(b.pubDate).getTime() : 0;
    return db - da;
  });

  const final = deduped.slice(0, MAX_ARTICLES);

  writeFileSync(OUT_FILE, JSON.stringify(final, null, 2));
  console.log(`\nWrote ${final.length} articles to ${OUT_FILE}`);

  // Summary
  const bySource = {};
  for (const a of final) bySource[a.source] = (bySource[a.source] || 0) + 1;
  console.log('\nArticles per source:');
  for (const [src, count] of Object.entries(bySource).sort()) {
    console.log(`  ${src}: ${count}`);
  }
}

main().catch(e => { console.error(e); process.exit(1); });
