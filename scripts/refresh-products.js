#!/usr/bin/env node
/**
 * Refresh product data for all ASINs in data/products.json
 *
 * Uses xcrawl `scrape` (1 credit) + custom HTML parsing (no AI extraction) for stability.
 * Amazon's extractJson mode was getting throttled, but `scrape` to raw HTML is reliable.
 *
 * Updates: title, price, rating, reviews, imageUrl, isBestSeller, isAmazonChoice, scrapedAt
 * Computes: trendingScore (delta reviews / old reviews), isTrending (>= 20% growth)
 * Maintains: priceHistory, reviewsHistory (last 10 entries)
 *
 * Strips: [TEST_MARKER_*] artifacts, suspicious numbers (>1M reviews)
 *
 * Usage:
 *   XCRAWL_API_KEY=xc-... node scripts/refresh-products.js
 *   node scripts/refresh-products.js --asin B0CMPSYW3M  (single product)
 *   node scripts/refresh-products.js --limit 10         (first 10 only)
 *   node scripts/refresh-products.js --skip-images     (faster, keep existing imageUrl)
 *
 * Cost: ~1 credit per product (scrape). 150 products = ~150 credits.
 */

'use strict';

const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const PRODUCTS_FILE = path.join(ROOT, 'data', 'products.json');
const BACKUP_FILE = path.join(ROOT, 'data', 'products.backup.json');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const jitter = (min, max) => min + Math.random() * (max - min);

const args = process.argv.slice(2);
const onlyAsin = (args.includes('--asin') ? args[args.indexOf('--asin') + 1] : null);
const limitIdx = args.indexOf('--limit');
const limitCount = limitIdx > -1 ? parseInt(args[limitIdx + 1], 10) : null;
const skipImages = args.includes('--skip-images');
const concurrencyIdx = args.indexOf('--concurrency');
const CONCURRENCY = concurrencyIdx > -1 ? parseInt(args[concurrencyIdx + 1], 10) || 4 : 4;
const skipExisting = args.includes('--skip-existing');
// Skip products scraped in the last N hours (default 6)
const skipHoursIdx = args.indexOf('--skip-hours');
const SKIP_HOURS = skipHoursIdx > -1 ? parseInt(args[skipHoursIdx + 1], 10) || 6 : 6;

const API_KEY = process.env.XCRAWL_API_KEY;
if (!API_KEY) {
  console.error('❌ XCRAWL_API_KEY not set. Get one at https://dash.xcrawl.com');
  process.exit(1);
}

const { XCrawlScraper } = require('xcrawl-scraper');
const xcrawl = new XCrawlScraper({ apiKey: API_KEY, timeout: 60000 });

function parseAmazon(html) {
  const out = {};
  // Price: gather all candidates, pick the smallest plausible one (real product price is usually $5-200)
  const priceCandidates = [];
  for (const m of html.matchAll(/"priceAmount"\s*:\s*(\d+\.?\d*)/g)) {
    const v = parseFloat(m[1]);
    if (v >= 1 && v <= 500) priceCandidates.push(v);
  }
  for (const m of html.matchAll(/a-offscreen">\s*\$([\d,]+\.?\d*)/g)) {
    const v = parseFloat(m[1].replace(/,/g, ''));
    if (v >= 1 && v <= 500) priceCandidates.push(v);
  }
  if (priceCandidates.length) {
    // Pick the most common value (mode), or first if no mode
    const counts = {};
    for (const p of priceCandidates) counts[p] = (counts[p] || 0) + 1;
    let bestPrice = priceCandidates[0];
    let bestCount = 0;
    for (const [p, c] of Object.entries(counts)) {
      if (c > bestCount) { bestCount = c; bestPrice = parseFloat(p); }
    }
    out.price = bestPrice;
  }

  const ratingM = html.match(/a-icon-alt">([\d\.]+) out of 5 stars/);
  if (ratingM) out.rating = parseFloat(ratingM[1]);

  const reviewM = html.match(/acrCustomerReviewText"[^>]*aria-label="([\d,]+)/)
    || html.match(/acrCustomerReviewText"[^>]*>\s*\(([\d,]+)\)/)
    || html.match(/"reviewCount":\s*"?(\d+)/);
  if (reviewM) out.reviews = parseInt(reviewM[1].replace(/,/g, ''), 10);

  const imgM = html.match(/data-old-hires="([^"]+)"/)
    || html.match(/id="landingImage"[^>]*src="([^"]+)"/);
  if (imgM) out.imageUrl = imgM[1].replace(/\._[A-Z][^\.]*\./, '._AC_SL1000_.');

  const titleM = html.match(/<span[^>]*id="productTitle"[^>]*>\s*([^<]+?)\s*<\/span>/);
  if (titleM) out.title = titleM[1].trim().replace(/&amp;/g, '&').replace(/&#\d+;/g, ' ');

  out.isBestSeller = !!html.match(/#\s*1\s*Best Seller/i) || !!html.match(/Best Seller in /);
  out.isAmazonChoice = !!html.match(/Amazon['\u2019]s Choice/i);

  return out;
}

function cleanTitle(title) {
  if (!title) return title;
  return String(title)
    .replace(/\[TEST[_\-]MARKER[_\-][^\]]*\]/gi, '')
    .replace(/\[test[_\-]marker[_\-][^\]]*\]/gi, '')
    .replace(/\s+/g, ' ')
    .trim();
}

function sanitizeReviews(n) {
  if (n == null) return null;
  if (n > 1000000) return null; // Amazon products rarely have more than 1M reviews
  return n;
}

function sanitizePrice(p) {
  if (p == null) return null;
  if (p <= 0 || p > 10000) return null;
  return Math.round(p * 100) / 100;
}

function computeTrending(oldReviews, newReviews) {
  if (oldReviews == null || newReviews == null || oldReviews === 0) return 0;
  return (newReviews - oldReviews) / oldReviews;
}

async function fetchOne(asin, idx, total) {
  const url = `https://www.amazon.com/dp/${asin}/`;
  for (let attempt = 1; attempt <= 3; attempt++) {
    try {
      const result = await xcrawl.scrape({
        url,
        output: { formats: ['html'] },
        proxy: { location: 'US' },
        wait_for: 1500,
      });
      if (!result || !result.data || !result.data.html) {
        throw new Error('No HTML in response');
      }
      const parsed = parseAmazon(result.data.html);
      if (!parsed.title && !parsed.price) {
        throw new Error('Could not parse any product data (Amazon may have throttled)');
      }
      const summary = `$${parsed.price || '—'} | ${parsed.rating || '—'}★ (${parsed.reviews || 0} rev)`;
      console.log(`✅ [${idx}/${total}] ${asin} → ${parsed.title?.slice(0, 50) || '?'}... | ${summary}`);
      return parsed;
    } catch (err) {
      const msg = err.message || String(err);
      console.log(`❌ [${idx}/${total}] ${asin} → ${msg.slice(0, 80)} (attempt ${attempt})`);
      if (attempt === 3) return null;
      const wait = msg.includes('429') || msg.includes('rate') ? jitter(10000, 20000) : jitter(3000, 6000);
      console.log(`   sleeping ${(wait/1000).toFixed(1)}s before retry...`);
      await sleep(wait);
    }
  }
  return null;
}

async function main() {
  const products = JSON.parse(fs.readFileSync(PRODUCTS_FILE, 'utf8'));
  console.log(`\n🔄 Refreshing ${products.length} products...\n`);

  fs.writeFileSync(BACKUP_FILE, JSON.stringify(products, null, 2));
  console.log(`📦 Backed up to ${BACKUP_FILE}\n`);

  let targets = products.filter(p => p.asin);
  if (onlyAsin) targets = targets.filter(p => p.asin === onlyAsin);
  if (skipExisting) {
    const cutoff = Date.now() - SKIP_HOURS * 3600 * 1000;
    targets = targets.filter(p => {
      const scraped = p.scrapedAt ? new Date(p.scrapedAt).getTime() : 0;
      return scraped < cutoff;
    });
  }
  if (limitCount) targets = targets.slice(0, limitCount);

  let updated = 0, failed = 0;
  // Process in parallel with limited concurrency
  let cursor = 0;
  const inFlight = new Map();

  async function processOne(i) {
    const target = targets[i];
    const fresh = await fetchOne(target.asin, i + 1, targets.length);
    if (!fresh) return { failed: true };

    const idx = products.findIndex(p => p.asin === target.asin);
    if (idx === -1) return { failed: true };

    const old = products[idx];
    const oldReviews = old.reviews;
    const newReviews = sanitizeReviews(fresh.reviews);
    const newPrice = sanitizePrice(fresh.price);

    const trendingScore = computeTrending(oldReviews, newReviews);
    // Only flag trending if baseline >= 100 reviews AND growth >= 50%
    // (avoids false positives from small-baseline products where 5 reviews growth = huge %)
    const isTrending = oldReviews != null && oldReviews >= 100 && newReviews != null && trendingScore >= 0.50;

    const priceHistory = old.priceHistory || (old.price ? [{ price: old.price, at: old.scrapedAt }] : []);
    const reviewsHistory = old.reviewsHistory || (old.reviews ? [{ count: old.reviews, at: old.scrapedAt }] : []);

    products[idx] = {
      ...old,
      title: cleanTitle(fresh.title) || old.title,
      price: newPrice != null ? newPrice : old.price,
      priceHistory: newPrice != null ? [...priceHistory.slice(-9), { price: newPrice, at: new Date().toISOString() }] : priceHistory,
      rating: fresh.rating != null ? `${fresh.rating} out of 5 stars` : old.rating,
      ratingValue: fresh.rating != null ? fresh.rating : old.ratingValue,
      reviews: newReviews != null ? newReviews : old.reviews,
      reviewsHistory: newReviews != null ? [...reviewsHistory.slice(-9), { count: newReviews, at: new Date().toISOString() }] : reviewsHistory,
      link: `https://www.amazon.com/dp/${target.asin}/`,
      imageUrl: skipImages ? old.imageUrl : (fresh.imageUrl || old.imageUrl),
      scrapedAt: new Date().toISOString(),
      trendingScore: Math.round(trendingScore * 1000) / 1000,
      isTrending,
      isBestSeller: fresh.isBestSeller || false,
      isAmazonChoice: fresh.isAmazonChoice || false,
    };

    if (isTrending) {
      console.log(`   🔥 Trending! +${(trendingScore * 100).toFixed(0)}% reviews growth`);
    }

    return { failed: false, isTrending };
  }

  while (cursor < targets.length || inFlight.size > 0) {
    // Start new tasks up to concurrency limit
    while (inFlight.size < CONCURRENCY && cursor < targets.length) {
      const i = cursor++;
      const p = processOne(i).then(result => {
        inFlight.delete(p);
        if (result.failed) failed++; else updated++;
        // Save incrementally every 5 updates
        if ((updated + failed) % 5 === 0) {
          fs.writeFileSync(PRODUCTS_FILE, JSON.stringify(products, null, 2));
        }
        return result;
      });
      inFlight.set(p, i);
    }
    if (inFlight.size > 0) {
      await Promise.race(inFlight.keys());
    }
  }
  // Final save
  fs.writeFileSync(PRODUCTS_FILE, JSON.stringify(products, null, 2));

  const trendingCount = products.filter(p => p.isTrending).length;
  console.log(`\n📊 Summary:`);
  console.log(`   Updated: ${updated}`);
  console.log(`   Failed: ${failed}`);
  console.log(`   Trending (🔥): ${trendingCount} / ${products.length}`);
  console.log(`   File: ${PRODUCTS_FILE}\n`);

  if (updated > 0) {
    const top = products
      .filter(p => p.isTrending)
      .sort((a, b) => (b.trendingScore || 0) - (a.trendingScore || 0))
      .slice(0, 10);
    if (top.length) {
      console.log('🚀 Top 10 trending:');
      top.forEach((p, i) => {
        console.log(`   ${i + 1}. ${p.asin} | +${(p.trendingScore * 100).toFixed(0)}% | ${p.title?.slice(0, 60)}`);
      });
      console.log('');
    }
  }
}

main().catch((e) => { console.error(e); process.exit(1); });
