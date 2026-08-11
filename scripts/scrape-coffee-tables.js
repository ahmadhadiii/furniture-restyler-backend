// One-off dev tool (not part of the compiled app) - scrapes the
// "Coffee Table" category from istikbaliraq.com (the same source site every
// other product in furniture-products.json came from) and appends new
// entries with category 'coffee-table'. robots.txt confirms unrestricted
// scraping (checked 2026-08-05).
//
// Pattern mirrors the original product scrape described in project memory:
// raw HTML + regex, no HTML-parsing dependency. Coffee table pages use a
// simpler og:description than sofas - just "W ## cm H ## cm" (sometimes no
// "D" at all, e.g. round tables where width alone defines the footprint) -
// so W/D/H are each parsed independently and depth is left null if absent,
// rather than assuming all three are always present like the sofa scrape did.
//
// Usage: node scripts/scrape-coffee-tables.js
const fs = require('fs');
const path = require('path');

const LISTING_BASE = 'https://istikbaliraq.com/product-category/complementary-products/coffee-table/';
const DATA_DIR = path.join(__dirname, '..', 'data');
const PRODUCTS_PATH = path.join(DATA_DIR, 'furniture-products.json');
const HEADERS = { 'User-Agent': 'Mozilla/5.0' };

async function fetchText(url) {
  const res = await fetch(url, { headers: HEADERS });
  if (!res.ok) throw new Error(`${res.status} ${url}`);
  return res.text();
}

async function listProductUrls() {
  const urls = new Set();
  for (let page = 1; page <= 4; page++) {
    const pageUrl = page === 1 ? LISTING_BASE : `${LISTING_BASE}page/${page}/`;
    let html;
    try {
      html = await fetchText(pageUrl);
    } catch {
      break; // page doesn't exist - past the last page
    }
    const matches = [...html.matchAll(/href="(https:\/\/istikbaliraq\.com\/product\/[^"]+)"/g)];
    if (matches.length === 0) break;
    for (const m of matches) urls.add(m[1]);
  }
  return [...urls];
}

function extractMeta(html, property) {
  const m = html.match(new RegExp(`<meta property="og:${property}"[^>]*content="([^"]*)"`, 'i'));
  return m ? m[1] : null;
}

function extractDimension(text, letter) {
  const m = text ? text.match(new RegExp(`${letter}\\s*(\\d+(?:\\.\\d+)?)\\s*cm`, 'i')) : null;
  return m ? parseFloat(m[1]) : null;
}

async function scrapeProduct(url) {
  const html = await fetchText(url);
  const title = extractMeta(html, 'title') ?? html.match(/<title>([^<]*)<\/title>/i)?.[1] ?? url;
  const imageUrl = extractMeta(html, 'image');
  const description = extractMeta(html, 'description');

  const width = extractDimension(description, 'W');
  const depth = extractDimension(description, 'D');
  const height = extractDimension(description, 'H');

  if (width == null && height == null) {
    return { ok: false, reason: 'no W/H found in og:description', description };
  }

  return {
    ok: true,
    record: {
      product_name: title.replace(/\s*[-|].*$/, '').trim(),
      category: 'coffee-table',
      source_url: url,
      image_url: imageUrl,
      dimensions_cm: { width, depth, height },
      dimensions_source: 'og:description',
    },
  };
}

async function main() {
  const urls = await listProductUrls();
  console.log(`Found ${urls.length} coffee-table product URLs`);

  const existing = JSON.parse(fs.readFileSync(PRODUCTS_PATH, 'utf8'));
  const existingUrls = new Set(existing.map((p) => p.source_url));

  const newRecords = [];
  let index = existing.filter((p) => p.category === 'coffee-table').length + 1;

  for (const url of urls) {
    if (existingUrls.has(url)) {
      console.log('SKIP (already scraped)', url);
      continue;
    }
    try {
      const result = await scrapeProduct(url);
      if (!result.ok) {
        console.log('SKIP', url, '->', result.reason, JSON.stringify(result.description));
        continue;
      }
      const filename = `coffee-table-${String(index).padStart(3, '0')}${path.extname(new URL(result.record.image_url).pathname) || '.jpg'}`;
      index++;
      newRecords.push({ filename, ...result.record });
      console.log('OK', url, '->', JSON.stringify(result.record.dimensions_cm));
    } catch (error) {
      console.log('ERROR', url, error.message);
    }
  }

  fs.writeFileSync(PRODUCTS_PATH, JSON.stringify([...existing, ...newRecords], null, 2));
  console.log(`Appended ${newRecords.length} new coffee-table records to ${PRODUCTS_PATH}`);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
