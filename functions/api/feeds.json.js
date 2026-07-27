const RSS_FEEDS = [
  { name: 'DevMatrix', url: 'https://www.devmatrix.us.com/rss.xml' },
  { name: 'WebTechnoto', url: 'https://webtechnoto.com/rss.xml' },
  { name: 'M2SoftTech', url: 'https://m2softtech.com/rss.xml' },
  { name: 'WebDroid', url: 'https://webidroid.com/rss.xml' },
  { name: 'TechForthy', url: 'https://techforthy.com/rss.xml' },
  { name: 'GeekiSquad', url: 'https://geekisquad.com/rss.xml' },
  { name: 'TechAuditOrg', url: 'https://tech-audit.org/rss.xml' },
  { name: 'TechUvy', url: 'https://techuvy.com/rss.xml' },
  { name: 'SmartXox', url: 'https://smartxox.com/rss.xml' },
  { name: 'OmniGuru', url: 'https://omniguru.net/rss.xml' },
  { name: 'FactBharat', url: 'https://factbharat.com/rss.xml' },
];

function decodeEntities(str) {
  if (!str) return '';
  return str
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#039;/g, "'")
    .replace(/&apos;/g, "'")
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
    .replace(/\s{2,}/g, ' ')
    .trim();
}

function getTag(xml, tag) {
  let m = xml.match(new RegExp(`<${tag}[^>]*>\\s*<!\\[CDATA\\[([\\s\\S]*?)\\]\\]>\\s*<\\/${tag}>`, 'i'));
  if (m && m[1].trim()) return m[1].trim();
  m = xml.match(new RegExp(`<${tag}[^>]*>([\\s\\S]*?)<\\/${tag}>`, 'i'));
  if (m) {
    const v = stripHtml(m[1]).trim();
    if (v) return v;
  }
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

function parseFeed(xml, sourceName) {
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
      getTag(chunk, 'content:encoded') ||
      getTag(chunk, 'description') ||
      getTag(chunk, 'summary') ||
      getTag(chunk, 'content');

    const description = decodeEntities(stripHtml(rawDesc)).slice(0, 250);
    const pubDate =
      getTag(chunk, 'pubDate') ||
      getTag(chunk, 'published') ||
      getTag(chunk, 'updated') ||
      getTag(chunk, 'dc:date') ||
      '';
    const author = decodeEntities(getTag(chunk, 'dc:creator') || getTag(chunk, 'author'));
    const category = decodeEntities(getTag(chunk, 'category'));

    items.push({ title, link, description, pubDate, author, category, source: sourceName });
  }
  return items;
}

async function fetchFeed(feed) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 10000);
  try {
    const res = await fetch(feed.url, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (compatible; NewsAggregator/1.0)',
        'Accept': 'application/rss+xml, application/atom+xml, application/xml, text/xml, */*',
        'Cache-Control': 'no-cache',
      },
      redirect: 'follow',
      signal: controller.signal,
    });
    clearTimeout(timer);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const text = await res.text();
    const items = parseFeed(text, feed.name);
    return { feed: feed.name, items, itemCount: items.length, bytes: text.length };
  } catch (err) {
    clearTimeout(timer);
    throw new Error(`${feed.name}: ${err.message}`);
  }
}

export async function onRequest(context) {
  const url = new URL(context.request.url);
  const debug = url.searchParams.has('debug');

  const results = await Promise.allSettled(RSS_FEEDS.map(fetchFeed));

  const articles = [];
  const feedStatus = [];

  for (const r of results) {
    if (r.status === 'fulfilled') {
      articles.push(...r.value.items);
      feedStatus.push({ feed: r.value.feed, ok: true, count: r.value.itemCount, bytes: r.value.bytes });
    } else {
      feedStatus.push({ feed: r.reason?.message?.split(':')[0] || '?', ok: false, error: r.reason?.message });
    }
  }

  articles.sort((a, b) => {
    const da = a.pubDate ? new Date(a.pubDate).getTime() : 0;
    const db = b.pubDate ? new Date(b.pubDate).getTime() : 0;
    return db - da;
  });

  const payload = debug
    ? { articles: articles.slice(0, 300), feedStatus, total: articles.length }
    : { articles: articles.slice(0, 300) };

  return new Response(JSON.stringify(payload), {
    headers: {
      'Content-Type': 'application/json',
      'Cache-Control': 'public, max-age=900',
      'Access-Control-Allow-Origin': '*',
    },
  });
}
