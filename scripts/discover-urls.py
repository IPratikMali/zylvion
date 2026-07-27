#!/usr/bin/env python3
"""
discover-urls.py
Fetches sitemaps from all sources, compares against data/urls_discovered.csv,
and appends only NEW article URLs with status=pending.
"""

import csv
import os
import re
import sys
import urllib.request
import urllib.error
from datetime import datetime, timezone
from pathlib import Path
from xml.etree import ElementTree as ET

ROOT = Path(__file__).parent.parent
CSV_FILE = ROOT / "data" / "urls_discovered.csv"

SOURCES = [
    # — Original 11 —
    {"name": "WebTechnoto",   "sitemap": "https://webtechnoto.com/sitemap.xml"},
    {"name": "GeekiSquad",    "sitemap": "https://geekisquad.com/sitemap.xml"},
    {"name": "OmniGuru",      "sitemap": "https://omniguru.net/sitemap.xml"},
    {"name": "M2SoftTech",    "sitemap": "https://m2softtech.com/sitemap.xml"},
    {"name": "TechAudit",     "sitemap": "https://tech-audit.org/sitemap.xml"},
    {"name": "DevMatrix",     "sitemap": "https://devmatrix.us.com/sitemap.xml"},
    {"name": "TechForthy",    "sitemap": "https://techforthy.com/sitemap.xml"},
    {"name": "TechUvy",       "sitemap": "https://techuvy.com/sitemap.xml"},
    {"name": "WebIdroid",     "sitemap": "https://webidroid.com/sitemap.xml"},
    {"name": "FactBharat",    "sitemap": "https://factbharat.com/sitemap.xml"},
    {"name": "SmartXox",      "sitemap": "https://smartxox.com/sitemap.xml"},
    # — New 13 —
    {"name": "TopicRealm",    "sitemap": "https://topicrealm.in/sitemap.xml"},
    {"name": "Velontia",      "sitemap": "https://velontia.in/sitemap.xml"},
    {"name": "Zyntharo",      "sitemap": "https://zyntharo.in/sitemap.xml"},
    {"name": "Trovika",       "sitemap": "https://trovika.org/sitemap.xml"},
    {"name": "Nexolyn",       "sitemap": "https://nexolyn.xyz/sitemap.xml"},
    {"name": "Luntriso",      "sitemap": "https://luntriso.org/sitemap.xml"},
    {"name": "Vorexo",        "sitemap": "https://vorexo.xyz/sitemap.xml"},
    {"name": "Nimtera",       "sitemap": "https://nimtera.vip/sitemap.xml"},
    {"name": "Zeltriva",      "sitemap": "https://zeltriva.org/sitemap.xml"},
    {"name": "Talkuo",        "sitemap": "https://talkuo.com/sitemap.xml"},
    {"name": "Jaruweb",       "sitemap": "https://jaruweb.com/sitemap.xml"},
    {"name": "Multiwirer",    "sitemap": "https://multiwirer.com/sitemap.xml"},
    {"name": "TronClassic",   "sitemap": "https://tronclassic.org/sitemap.xml"},
]

SITEMAP_FALLBACKS = [
    "sitemap.xml",
    "sitemap_index.xml",
    "sitemap-index.xml",
    "sitemap-0.xml",
    "post-sitemap.xml",
    "news-sitemap.xml",
    "page-sitemap.xml",
]

# Paths to skip — not article pages
SKIP_PATTERNS = re.compile(
    r"/(page/|tag[s]?/|categor(y|ies)/|author/|search[/\?]|feed/|"
    r"wp-content/|wp-admin/|wp-json/|cdn-cgi/|\?|#|"
    r"privacy|terms|contact|about|disclaimer|sitemap|\.(xml|pdf|jpg|png|gif|svg|zip|css|js))"
    r"",
    re.IGNORECASE
)


def fetch(url, timeout=10):
    req = urllib.request.Request(
        url,
        headers={"User-Agent": "Mozilla/5.0 (compatible; NewsBot/1.0)"},
    )
    try:
        with urllib.request.urlopen(req, timeout=timeout) as r:
            return r.read().decode("utf-8", errors="replace")
    except Exception as e:
        raise RuntimeError(str(e))


def parse_sitemap(xml_text):
    """Return (is_index, list_of_items).
    Items are dicts with 'loc' and optionally 'lastmod'.
    """
    try:
        root = ET.fromstring(xml_text)
    except ET.ParseError:
        # Strip namespace and retry
        xml_text = re.sub(r' xmlns[^"]*"[^"]*"', "", xml_text)
        try:
            root = ET.fromstring(xml_text)
        except ET.ParseError:
            return False, []

    ns = {"sm": "http://www.sitemaps.org/schemas/sitemap/0.9"}
    tag = root.tag.lower()

    # Sitemap index
    if "sitemapindex" in tag:
        locs = []
        for loc in root.iter():
            if loc.tag.lower().endswith("}loc") or loc.tag.lower() == "loc":
                if loc.text:
                    locs.append(loc.text.strip())
        return True, locs

    # Regular sitemap
    items = []
    for url_el in root.iter():
        if url_el.tag.lower() in ("url", "{http://www.sitemaps.org/schemas/sitemap/0.9}url"):
            loc = lastmod = None
            for child in url_el:
                ctag = child.tag.lower().split("}")[-1]
                if ctag == "loc" and child.text:
                    loc = child.text.strip()
                elif ctag == "lastmod" and child.text:
                    lastmod = child.text.strip()
            if loc:
                items.append({"loc": loc, "lastmod": lastmod or ""})
    return False, items


def fetch_sitemap_urls(source):
    base = source["sitemap"]
    domain = "/".join(base.split("/")[:3])
    candidates = [base] + [f"{domain}/{fb}" for fb in SITEMAP_FALLBACKS if fb not in base]

    for url in candidates:
        try:
            xml = fetch(url)
            if "<urlset" not in xml and "<sitemapindex" not in xml:
                continue
            is_index, items = parse_sitemap(xml)
            if is_index:
                # Fetch child sitemaps (first 5)
                all_items = []
                for child_url in items[:5]:
                    try:
                        child_xml = fetch(child_url)
                        _, child_items = parse_sitemap(child_xml)
                        all_items.extend(child_items)
                    except Exception:
                        pass
                return all_items
            return items
        except Exception:
            continue

    print(f"  {source['name']}: all sitemap paths failed", file=sys.stderr)
    return []


def is_article(url):
    if SKIP_PATTERNS.search(url):
        return False
    try:
        from urllib.parse import urlparse
        path = urlparse(url).path.rstrip("/")
        segments = [s for s in path.split("/") if s]
        if len(segments) < 1:  # need at least 1 real path segment (not just domain)
            return False
        slug = segments[-1]
        # Must have alphabetic chars and be reasonably long
        return bool(re.search(r"[a-zA-Z]{3,}", slug)) and len(slug) > 5
    except Exception:
        return False


def load_known_urls():
    known = set()
    if not CSV_FILE.exists():
        return known
    with open(CSV_FILE, newline="", encoding="utf-8") as f:
        reader = csv.DictReader(f)
        for row in reader:
            if row.get("url"):
                known.add(row["url"].strip())
    return known


FIELDNAMES = ["url", "source", "discovered_at", "status", "category", "article_slug", "image"]
IMAGE_ENRICH_LIMIT = 60  # fetch og:image for this many newest URLs per run


def fetch_og_image(url, timeout=8):
    """Return og:image or twitter:image URL from a page, or empty string."""
    import re as _re
    req = urllib.request.Request(
        url,
        headers={"User-Agent": "Mozilla/5.0 (compatible; NewsBot/1.0)", "Accept": "text/html"},
    )
    try:
        with urllib.request.urlopen(req, timeout=timeout) as r:
            # Read only the first 20 KB — enough for <head>
            html = r.read(20480).decode("utf-8", errors="replace")
        for pat in [
            r'<meta[^>]+property=["\']og:image["\'][^>]+content=["\']([^"\']+)["\']',
            r'<meta[^>]+content=["\']([^"\']+)["\'][^>]+property=["\']og:image["\']',
            r'<meta[^>]+name=["\']twitter:image["\'][^>]+content=["\']([^"\']+)["\']',
            r'<meta[^>]+content=["\']([^"\']+)["\'][^>]+name=["\']twitter:image["\']',
        ]:
            m = _re.search(pat, html, _re.IGNORECASE)
            if m:
                img = m.group(1).strip()
                if img.startswith("http"):
                    return img
    except Exception:
        pass
    return ""


def append_new_urls(new_rows):
    write_header = not CSV_FILE.exists() or CSV_FILE.stat().st_size == 0
    with open(CSV_FILE, "a", newline="", encoding="utf-8") as f:
        writer = csv.DictWriter(f, fieldnames=FIELDNAMES)
        if write_header:
            writer.writeheader()
        for row in new_rows:
            writer.writerow(row)


def enrich_images(limit=IMAGE_ENRICH_LIMIT):
    """Read CSV, fetch og:image for newest rows missing it, rewrite CSV."""
    if not CSV_FILE.exists():
        return
    with open(CSV_FILE, newline="", encoding="utf-8") as f:
        reader = csv.DictReader(f)
        rows = list(reader)
        existing_fields = reader.fieldnames or []

    # Ensure image column exists in all rows
    for row in rows:
        if "image" not in row:
            row["image"] = ""

    # Find rows needing enrichment (newest first, i.e. reverse order)
    to_enrich = [r for r in reversed(rows) if not r.get("image")][:limit]
    if not to_enrich:
        print("Image enrichment: all recent URLs already have images.")
        return

    print(f"\nFetching og:image for {len(to_enrich)} URLs...")
    enriched = 0
    for row in to_enrich:
        img = fetch_og_image(row["url"])
        row["image"] = img
        if img:
            enriched += 1

    with open(CSV_FILE, "w", newline="", encoding="utf-8") as f:
        writer = csv.DictWriter(f, fieldnames=FIELDNAMES)
        writer.writeheader()
        writer.writerows(rows)
    print(f"  Enriched {enriched}/{len(to_enrich)} URLs with images.")


def main():
    print("Loading known URLs...")
    known = load_known_urls()
    print(f"  Already known: {len(known)} URLs")

    now = datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")
    new_rows = []

    for source in SOURCES:
        print(f"\nFetching sitemap: {source['name']}...")
        items = fetch_sitemap_urls(source)
        added = 0
        for item in items:
            loc = item["loc"] if isinstance(item, dict) else item
            if not loc:
                continue
            if loc in known:
                continue
            if not is_article(loc):
                continue
            new_rows.append({
                "url": loc,
                "source": source["name"],
                "discovered_at": now,
                "status": "pending",
                "category": "",
                "article_slug": "",
                "image": "",
            })
            known.add(loc)
            added += 1
        print(f"  {source['name']}: {added} new URLs (total items: {len(items)})")

    if new_rows:
        append_new_urls(new_rows)
        print(f"\nAdded {len(new_rows)} new URLs to {CSV_FILE}")
    else:
        print("\nNo new URLs found.")

    enrich_images(IMAGE_ENRICH_LIMIT)

    total = len(load_known_urls())
    print(f"Total known URLs now: {total}")


if __name__ == "__main__":
    main()
