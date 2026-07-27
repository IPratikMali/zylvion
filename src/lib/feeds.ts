export interface Article {
  title: string;
  link: string;
  description: string;
  pubDate: string;
  author: string;
  category: string;
  source: string;
}

export const RSS_FEEDS = [
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

function extractTag(xml: string, tag: string): string {
  const patterns = [
    new RegExp(`<${tag}[^>]*><!\\[CDATA\\[([\\s\\S]*?)\\]\\]><\\/${tag}>`, 'i'),
    new RegExp(`<${tag}[^>]*>([^<]*)<\\/${tag}>`, 'i'),
    new RegExp(`<${tag}[^>]* href="([^"]*)"`, 'i'),
  ];
  for (const pat of patterns) {
    const m = xml.match(pat);
    if (m && m[1].trim()) return m[1].trim();
  }
  return '';
}

export function parseRSSItems(xml: string, sourceName: string): Article[] {
  const items: Article[] = [];
  const itemRegex = /<item[\s>]([\s\S]*?)<\/item>/gi;
  let match;
  while ((match = itemRegex.exec(xml)) !== null) {
    const item = match[1];
    const title = extractTag(item, 'title');
    const link = extractTag(item, 'link') || extractTag(item, 'guid');
    const description = extractTag(item, 'description').replace(/<[^>]+>/g, '').slice(0, 200);
    const pubDate = extractTag(item, 'pubDate') || extractTag(item, 'dc:date') || '';
    const author = extractTag(item, 'author') || extractTag(item, 'dc:creator') || '';
    const category = extractTag(item, 'category') || '';
    if (title && link) {
      items.push({ title, link, description, pubDate, author, category, source: sourceName });
    }
  }
  return items;
}
