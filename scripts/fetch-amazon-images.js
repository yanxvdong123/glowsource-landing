#!/usr/bin/env node
/**
 * Fetch real Amazon product images for all 150 ASINs in amazon-beauty-top100.json
 * and write them back as an "imageUrl" field on each product.
 *
 * Strategy: hit https://www.amazon.com/dp/{ASIN}/ with residential IP + proper headers,
 * parse the HTML for data-old-hires or the first image in data-a-dynamic-image.
 *
 * Be polite: random delay between 1.5s and 3.5s, retries with backoff on 503/captcha.
 */

'use strict';

const fs = require('fs');
const path = require('path');
const https = require('https');

const DATA_FILE = path.join(__dirname, '..', 'data', 'amazon-beauty-top100.json');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const jitter = (min, max) => min + Math.random() * (max - min);

const USER_AGENTS = [
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.2 Safari/605.1.15',
  'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
];

function pickUA() {
  return USER_AGENTS[Math.floor(Math.random() * USER_AGENTS.length)];
}

function fetchUrl(url, opts = {}) {
  return new Promise((resolve, reject) => {
    const u = new URL(url);
    const req = https.request(
      {
        hostname: u.hostname,
        port: 443,
        path: u.pathname + u.search,
        method: 'GET',
        headers: {
          'User-Agent': opts.ua || pickUA(),
          'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8',
          'Accept-Language': 'en-US,en;q=0.9',
          'Accept-Encoding': 'gzip, deflate, br',
          'Cache-Control': 'no-cache',
          'Pragma': 'no-cache',
          'Sec-Ch-Ua': '"Not_A Brand";v="8", "Chromium";v="120", "Google Chrome";v="120"',
          'Sec-Ch-Ua-Mobile': '?0',
          'Sec-Ch-Ua-Platform': '"Windows"',
          'Sec-Fetch-Dest': 'document',
          'Sec-Fetch-Mode': 'navigate',
          'Sec-Fetch-Site': 'none',
          'Sec-Fetch-User': '?1',
          'Upgrade-Insecure-Requests': '1',
          ...(opts.cookie ? { 'Cookie': opts.cookie } : {}),
        },
      },
      (res) => {
        // Follow redirects manually
        if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
          res.resume();
          return resolve(fetchUrl(res.headers.location, opts));
        }
        if (res.statusCode !== 200) {
          res.resume();
          return reject(new Error(`HTTP ${res.statusCode}`));
        }
        const encoding = res.headers['content-encoding'];
        const stream = encoding === 'gzip' ? res.pipe(require('zlib').createGunzip()) :
                       encoding === 'br'   ? res.pipe(require('zlib').createBrotliDecompress()) :
                                              res;
        let data = '';
        stream.on('data', (chunk) => (data += chunk));
        stream.on('end', () => resolve(data));
        stream.on('error', reject);
      }
    );
    req.on('error', reject);
    req.setTimeout(opts.timeoutMs || 25000, () => {
      req.destroy(new Error('Request timeout'));
    });
    req.end();
  });
}

function extractImageUrl(html) {
  // 1) data-old-hires (highest quality main image)
  let m = html.match(/data-old-hires="(https:\/\/m\.media-amazon\.com\/images\/I\/[^"]+)"/);
  if (m) return m[1].replace(/\._.*_\./, '._AC_SL1000_.'); // normalize to larger size
  // 2) data-a-dynamic-image JSON map
  m = html.match(/data-a-dynamic-image="([^"]+)"/);
  if (m) {
    const decoded = m[1].replace(/&quot;/g, '"');
    try {
      const obj = JSON.parse(decoded);
      const urls = Object.keys(obj);
      if (urls.length) {
        // pick the largest one
        let best = urls[0];
        let bestArea = 0;
        for (const u of urls) {
          const dims = obj[u];
          const area = (dims[0] || 0) * (dims[1] || 0);
          if (area > bestArea) { bestArea = area; best = u; }
        }
        return best.replace(/\._.*_\./, '._AC_SL1000_.');
      }
    } catch {}
  }
  // 3) og:image fallback
  m = html.match(/<meta property="og:image" content="(https:\/\/[^"]+)"/);
  if (m) return m[1];
  // 4) twitter:image fallback
  m = html.match(/<meta name="twitter:image" content="(https:\/\/[^"]+)"/);
  if (m) return m[1];
  // 5) landingImage
  m = html.match(/"landingImage":"(https:\/\/[^"]+)"/);
  if (m) return m[1].replace(/\\u002F/g, '/');
  return null;
}

async function processOne(asin, idx, total) {
  const url = `https://www.amazon.com/dp/${asin}/`;
  for (let attempt = 1; attempt <= 3; attempt++) {
    try {
      const html = await fetchUrl(url, { timeoutMs: 20000 });
      const imageUrl = extractImageUrl(html);
      if (imageUrl) {
        console.log(`✅ [${idx}/${total}] ${asin} → ${imageUrl.slice(0, 80)}...`);
        return imageUrl;
      }
      // Hit but no image - probably a different page type, skip
      console.log(`⚠️  [${idx}/${total}] ${asin} → no image found in HTML (attempt ${attempt})`);
      if (attempt === 3) return null;
    } catch (err) {
      const msg = err.message;
      console.log(`❌ [${idx}/${total}] ${asin} → ${msg} (attempt ${attempt})`);
      if (attempt === 3) return null;
      // Backoff longer on 503
      const wait = msg.includes('503') ? jitter(15000, 30000) : jitter(3000, 6000);
      console.log(`   sleeping ${(wait/1000).toFixed(1)}s before retry...`);
      await sleep(wait);
    }
  }
  return null;
}

async function main() {
  const products = JSON.parse(fs.readFileSync(DATA_FILE, 'utf8'));
  const asins = [...new Set(products.map((p) => p.asin))];
  console.log(`\n🛒 Fetching real Amazon product images for ${asins.length} unique ASINs...\n`);

  // Load existing results to support resume
  const cacheFile = path.join(__dirname, '..', 'data', 'image-urls.json');
  let cache = {};
  try { cache = JSON.parse(fs.readFileSync(cacheFile, 'utf8')); } catch {}

  let fetched = 0, failed = 0, skipped = 0;
  for (let i = 0; i < asins.length; i++) {
    const asin = asins[i];
    if (cache[asin]) {
      skipped++;
      continue;
    }
    const imageUrl = await processOne(asin, i + 1, asins.length);
    if (imageUrl) {
      cache[asin] = imageUrl;
      fetched++;
      // Persist cache after every success so we can resume
      fs.writeFileSync(cacheFile, JSON.stringify(cache, null, 2));
    } else {
      failed++;
    }
    // Polite delay (1.5-3.5s) between successful hits
    if (i < asins.length - 1) {
      const wait = jitter(1500, 3500);
      await sleep(wait);
    }
  }

  console.log(`\n📊 Summary: ${fetched} new fetched, ${skipped} already cached, ${failed} failed`);
  console.log(`   Cache written to: ${cacheFile}`);

  // Now merge into product data
  for (const p of products) {
    if (cache[p.asin]) p.imageUrl = cache[p.asin];
  }
  fs.writeFileSync(DATA_FILE, JSON.stringify(products, null, 2));
  console.log(`✅ Updated ${DATA_FILE} with imageUrl field\n`);
}

main().catch((e) => { console.error(e); process.exit(1); });
