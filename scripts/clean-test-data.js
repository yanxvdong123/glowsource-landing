#!/usr/bin/env node
/**
 * Clean obvious test/placeholder data from products.json:
 * - Strip [TEST_MARKER_*] from titles
 * - Set reviews > 1,000,000 to null (Amazon products rarely have this many)
 * - Set price < 0 or > 5000 to null
 * - Don't touch scrapedAt — let refresh-products.js update it
 */
'use strict';
const fs = require('fs');
const path = require('path');
const PRODUCTS_FILE = path.join(__dirname, '..', 'data', 'products.json');

const products = JSON.parse(fs.readFileSync(PRODUCTS_FILE, 'utf8'));
let cleaned = 0;
for (const p of products) {
  let changed = false;
  if (p.title && /\[TEST[_\-]MARKER[_\-]/.test(p.title)) {
    p.title = p.title.replace(/\[TEST[_\-]MARKER[_\-][^\]]*\]/gi, '').replace(/\s+/g, ' ').trim();
    changed = true;
  }
  if (p.reviews != null && p.reviews > 1000000) {
    p.reviews = null;
    changed = true;
  }
  if (p.reviews != null && p.reviews > 50000 && !p.reviewsHistory?.length) {
    // Suspicious - probably a fake test value
    // Only clear if no history yet (means it's original test data, not a real run that just had high count)
    p.reviews = null;
    changed = true;
  }
  if (p.price != null && (p.price <= 0 || p.price > 5000)) {
    p.price = null;
    changed = true;
  }
  if (p.rating === '0 out of 5 stars' || p.ratingValue === 0) {
    p.rating = null;
    p.ratingValue = null;
    changed = true;
  }
  if (changed) cleaned++;
}
fs.writeFileSync(PRODUCTS_FILE, JSON.stringify(products, null, 2));
console.log(`✅ Cleaned ${cleaned} of ${products.length} products`);
