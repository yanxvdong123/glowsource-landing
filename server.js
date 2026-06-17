'use strict';

require('dotenv').config();
const express = require('express');
const cors = require('cors');
const path = require('path');
const fs = require('fs');

const app = express();
const PORT = process.env.PORT || 3000;

app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// Basic Auth for /admin
const ADMIN_USER = process.env.ADMIN_USER || 'admin';
const ADMIN_PASS = process.env.ADMIN_PASS || 'glowsource2026';

function basicAuth(req, res, next) {
  const authHeader = req.headers.authorization;
  if (!authHeader || !authHeader.startsWith('Basic ')) {
    res.set('WWW-Authenticate', 'Basic realm="GlowSource Admin"');
    return res.status(401).send('Authentication required');
  }
  const base64 = authHeader.slice(6);
  const decoded = Buffer.from(base64, 'base64').toString('utf8');
  const [user, pass] = decoded.split(':');
  if (user !== ADMIN_USER || pass !== ADMIN_PASS) {
    res.set('WWW-Authenticate', 'Basic realm="GlowSource Admin"');
    return res.status(401).send('Access denied');
  }
  next();
}

// Leads store
const LEADS_FILE = path.join(__dirname, 'data', 'leads.json');
const PRODUCTS_FILE = path.join(__dirname, 'data', 'products.json');
function loadLeads() {
  try {
    if (!fs.existsSync(LEADS_FILE)) return [];
    return JSON.parse(fs.readFileSync(LEADS_FILE, 'utf8'));
  } catch { return []; }
}
function saveLeads(leads) {
  fs.writeFileSync(LEADS_FILE, JSON.stringify(leads, null, 2));
}

// Email via Resend HTTP API (works from any cloud, no SMTP port needed)
async function sendContactNotification({ name, email, company, message, interest, productName, productAsin }) {
  const apiKey = process.env.RESEND_API_KEY;
  const to = process.env.CONTACT_TO || 'charlescome1995@gmail.com';
  const from = process.env.RESEND_FROM || 'GlowSource <onboarding@resend.dev>';
  if (!apiKey) {
    console.warn('📧 RESEND_API_KEY not set, skipping email');
    return { skipped: true };
  }
  const productInfo = productName ? `<li><strong>Product:</strong> ${productName} (ASIN: ${productAsin})</li>` : '';
  const html = `<div style="font-family:-apple-system,sans-serif;max-width:600px;margin:0 auto"><div style="background:linear-gradient(135deg,#a855f7,#ec4899);padding:20px;border-radius:12px 12px 0 0"><h2 style="color:#fff;margin:0">🌸 New GlowSource Lead</h2></div><div style="background:#fff;padding:24px;border:1px solid #e5e7eb;border-radius:0 0 12px 12px"><table style="width:100%;border-collapse:collapse"><tr><td style="padding:8px 0;color:#6b7280;width:100px">Name</td><td style="padding:8px 0;font-weight:600">${name || 'N/A'}</td></tr><tr><td style="padding:8px 0;color:#6b7280">Email</td><td style="padding:8px 0"><a href="mailto:${email}" style="color:#a855f7">${email}</a></td></tr><tr><td style="padding:8px 0;color:#6b7280">Company</td><td style="padding:8px 0">${company || 'N/A'}</td></tr><tr><td style="padding:8px 0;color:#6b7280">Interest</td><td style="padding:8px 0">${interest || 'N/A'}</td></tr>${productName ? `<tr><td style="padding:8px 0;color:#6b7280">Product</td><td style="padding:8px 0">${productName}<br><span style="font-family:monospace;font-size:12px;color:#9ca3af">ASIN: ${productAsin}</span></td></tr>` : ''}</table><div style="margin-top:20px;padding:16px;background:#f9fafb;border-radius:8px;border-left:3px solid #a855f7"><p style="margin:0;color:#374151;white-space:pre-wrap">${message.replace(/</g, '&lt;')}</p></div><a href="https://glowsource-landing-production.up.railway.app/admin" style="display:inline-block;margin-top:20px;padding:10px 20px;background:linear-gradient(135deg,#a855f7,#ec4899);color:#fff;text-decoration:none;border-radius:6px;font-weight:600">View in Admin →</a></div></div>`;
  const text = `New GlowSource Lead\n\nName: ${name || 'N/A'}\nEmail: ${email}\nCompany: ${company || 'N/A'}\nInterest: ${interest || 'N/A'}\n${productName ? `Product: ${productName} (ASIN: ${productAsin})` : ''}\n\nMessage:\n${message}`;
  try {
    const res = await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: { 'Authorization': `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ from, to, subject: `[GlowSource] New lead${productName ? ': ' + productName : ''} from ${name || email}`, html, text }),
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.message || res.statusText);
    console.log('📧 Email sent via Resend:', data.id);
    return data;
  } catch (err) {
    console.error('📧 Resend send failed:', err.message);
    throw err;
  }
}

// Routes
app.get('/health', (req, res) => {
  res.json({ status: 'ok', service: 'beauty-supply-chain', timestamp: new Date().toISOString() });
});

// Image cache for product thumbnails
const IMG_CACHE_FILE = path.join(__dirname, 'data', 'image-cache.json');
function loadImgCache() {
  try { return JSON.parse(fs.readFileSync(IMG_CACHE_FILE, 'utf8')); } catch { return {}; }
}
function saveImgCache(cache) {
  try { fs.writeFileSync(IMG_CACHE_FILE, JSON.stringify(cache, null, 2)); } catch {}
}
let imgCache = loadImgCache();

app.get('/api/product-image/:asin', async (req, res) => {
  const { asin } = req.params;
  if (!asin || !/^[A-Z0-9]{10}$/.test(asin)) {
    return res.status(400).json({ error: 'Invalid ASIN' });
  }
  // Look up the product to use its pre-baked real Amazon image URL
  let product = null;
  try {
    const products = JSON.parse(fs.readFileSync(PRODUCTS_FILE, 'utf8'));
    product = products.find(p => p.asin === asin);
  } catch {}
  if (!product) {
    return res.status(404).json({ error: 'Product not found' });
  }
  if (product.imageUrl) {
    return res.json({ asin, imageUrl: product.imageUrl, cached: true, source: 'amazon' });
  }
  // No pre-baked image yet — return null so client can show category fallback emoji
  return res.json({ asin, imageUrl: null, cached: false, source: 'none' });
});

app.post('/api/contact', async (req, res) => {
  const { name, email, company, message, interest, productName, productAsin } = req.body;
  if (!email || !message) {
    return res.status(400).json({ error: 'Email and message are required' });
  }
  const leads = loadLeads();
  const newLead = {
    id: Date.now().toString(),
    name: name || '',
    email,
    company: company || '',
    interest: interest || '',
    productName: productName || '',
    productAsin: productAsin || '',
    message,
    status: 'new',
    createdAt: new Date().toISOString(),
  };
  leads.unshift(newLead);
  saveLeads(leads);
  console.log('\n📬 New Lead:', name || 'N/A', '|', email, '|', productName || 'N/A');
  // Fire-and-forget email send (don't block response on SMTP timeout)
  sendContactNotification({ name, email, company, message, interest, productName, productAsin })
    .catch(err => console.error('📧 Email send failed (lead still saved):', err.message));
  res.json({ success: true, message: "Thank you! We'll get back to you within 24 hours.", leadId: newLead.id });
});

app.get('/api/leads', basicAuth, (req, res) => {
  res.json({ total: loadLeads().length, leads: loadLeads() });
});

app.patch('/api/leads/:id', basicAuth, (req, res) => {
  const { id } = req.params;
  const { status, note } = req.body;
  const leads = loadLeads();
  const idx = leads.findIndex(l => l.id === id);
  if (idx === -1) return res.status(404).json({ error: 'Lead not found' });
  if (status) {
    leads[idx].status = status;
    if (status === 'contacted') leads[idx].contactedAt = new Date().toISOString();
    if (status === 'replied') leads[idx].repliedAt = new Date().toISOString();
  }
  if (note !== undefined) {
    if (!leads[idx].notes) leads[idx].notes = [];
    leads[idx].notes.push({ text: note, at: new Date().toISOString() });
  }
  saveLeads(leads);
  res.json({ success: true, lead: leads[idx] });
});

app.post('/api/leads/:id/note', basicAuth, (req, res) => {
  const { id } = req.params;
  const { text } = req.body;
  if (!text) return res.status(400).json({ error: 'Note text required' });
  const leads = loadLeads();
  const idx = leads.findIndex(l => l.id === id);
  if (idx === -1) return res.status(404).json({ error: 'Lead not found' });
  if (!leads[idx].notes) leads[idx].notes = [];
  leads[idx].notes.push({ text, at: new Date().toISOString() });
  saveLeads(leads);
  res.json({ success: true, notes: leads[idx].notes });
});

app.delete('/api/leads/:id', basicAuth, (req, res) => {
  const { id } = req.params;
  let leads = loadLeads();
  const idx = leads.findIndex(l => l.id === id);
  if (idx === -1) return res.status(404).json({ error: 'Lead not found' });
  leads.splice(idx, 1);
  saveLeads(leads);
  res.json({ success: true });
});

app.get('/api/products', (req, res) => {
  try {
    const dataPath = PRODUCTS_FILE;
    if (!fs.existsSync(dataPath)) {
      return res.status(404).json({ error: 'Product data not found. Run the scraper first.' });
    }
    const raw = fs.readFileSync(dataPath, 'utf8');
    const products = JSON.parse(raw).map(p => {
      const oem = computeOemViability(p);
      return {
        ...p,
        oemScore: oem.score,
        oemReasons: oem.reasons,
      };
    });
    res.json({ total: products.length, products });
  } catch (err) {
    res.status(500).json({ error: 'Failed to load product data' });
  }
});

// Refresh a single product by ASIN (admin-only via Basic Auth)
app.post('/api/refresh-asin', (req, res) => {
  const auth = req.headers.authorization || '';
  const expected = 'Basic ' + Buffer.from(ADMIN_USER + ':' + ADMIN_PASS).toString('base64');
  if (auth !== expected) {
    return res.status(401).json({ error: 'Unauthorized' });
  }
  const { asin } = req.body || {};
  if (!asin || !/^[A-Z0-9]{10}$/.test(asin)) {
    return res.status(400).json({ error: 'Invalid ASIN' });
  }
  // Spawn background refresh script
  const { spawn } = require('child_process');
  const script = path.join(__dirname, 'scripts', 'refresh-products.js');
  const child = spawn(process.execPath, [script, '--asin', asin], {
    cwd: __dirname,
    env: { ...process.env, XCRAWL_API_KEY: process.env.XCRAWL_API_KEY || '' },
    detached: true,
    stdio: 'ignore',
  });
  child.unref();
  res.json({ success: true, asin, pid: child.pid, message: 'Refresh started in background' });
});

// Trending products — sorted by trendingScore desc, top N
app.get('/api/trending', (req, res) => {
  try {
    const limit = parseInt(req.query.limit, 10) || 10;
    const products = JSON.parse(fs.readFileSync(PRODUCTS_FILE, 'utf8'));
    const trending = products
      .filter(p => p.isTrending)
      .sort((a, b) => (b.trendingScore || 0) - (a.trendingScore || 0))
      .slice(0, limit);
    res.json({
      total: products.length,
      trendingCount: products.filter(p => p.isTrending).length,
      lastRefreshed: products[0]?.scrapedAt || null,
      products: trending,
    });
  } catch (err) {
    res.status(500).json({ error: 'Failed to load trending data' });
  }
});

// OEM viability scoring — heuristic for "is this product easy to OEM from China?"
// Score 0-100 based on price (sweet spot for OEM), rating, review count (low = not monopolized), category maturity
function computeOemViability(product) {
  let score = 0;
  const reasons = [];
  // Price band: $10-50 is the sweet spot for China OEM (low enough margin to source, high enough ticket)
  if (product.price != null) {
    if (product.price >= 10 && product.price <= 50) { score += 30; reasons.push('Price in OEM sweet spot ($10-50)'); }
    else if (product.price > 5 && product.price < 100) { score += 15; reasons.push('Price workable for OEM'); }
  }
  // Rating: >4.5 is the proven demand signal
  if (product.ratingValue != null) {
    if (product.ratingValue >= 4.5) { score += 25; reasons.push('Strong rating (4.5+)'); }
    else if (product.ratingValue >= 4.0) { score += 15; }
  }
  // Review count: low = opportunity (not yet monopolized by big brands), high = proven demand
  if (product.reviews != null) {
    if (product.reviews >= 100 && product.reviews <= 5000) { score += 25; reasons.push('Proven demand but not saturated'); }
    else if (product.reviews > 5000 && product.reviews <= 50000) { score += 20; }
    else if (product.reviews < 100) { score += 10; reasons.push('Too early — demand not proven'); }
    else if (product.reviews > 50000) { score += 5; reasons.push('Highly competitive — hard to break in'); }
  }
  // Category maturity for China OEM
  const cat = (product.category || '').toLowerCase();
  if (/skin|makeup|color|beauty|hair|fragrance/.test(cat)) { score += 20; reasons.push('Category has strong China OEM supply chain'); }
  // Trending bonus
  if (product.isTrending) { score += 10; reasons.push('Currently trending — good timing'); }
  return { score: Math.min(score, 100), reasons };
}

app.get('/api/oem-scores', (req, res) => {
  try {
    const products = JSON.parse(fs.readFileSync(PRODUCTS_FILE, 'utf8'));
    const minScore = parseInt(req.query.minScore, 10) || 0;
    const scored = products.map(p => ({
      asin: p.asin,
      title: p.title,
      category: p.category,
      price: p.price,
      rating: p.ratingValue,
      reviews: p.reviews,
      isTrending: p.isTrending,
      isBestSeller: p.isBestSeller,
      isAmazonChoice: p.isAmazonChoice,
      imageUrl: p.imageUrl,
      link: p.link,
      scrapedAt: p.scrapedAt,
      ...computeOemViability(p),
    }));
    scored.sort((a, b) => b.score - a.score);
    const filtered = minScore > 0 ? scored.filter(p => p.score >= minScore) : scored;
    res.json({
      total: scored.length,
      filteredCount: filtered.length,
      minScore,
      lastRefreshed: products[0]?.scrapedAt || null,
      products: filtered,
    });
  } catch (err) {
    res.status(500).json({ error: 'Failed to compute OEM scores' });
  }
});

// Top products by popularity-weighted rating (for landing page showcase)
// Filter: rating >= 4.6, reviews >= 500, has price + image
// Sort: ratingValue * log(reviews + 1)
app.get('/api/top-products', (req, res) => {
  try {
    const limit = parseInt(req.query.limit, 10) || 10;
    const products = JSON.parse(fs.readFileSync(PRODUCTS_FILE, 'utf8'));
    const eligible = products.filter(p =>
      p.ratingValue >= 4.6 &&
      p.reviews >= 500 &&
      p.price > 0 &&
      p.imageUrl
    );
    eligible.sort((a, b) =>
      (b.ratingValue * Math.log(b.reviews + 1)) - (a.ratingValue * Math.log(a.reviews + 1))
    );
    const top = eligible.slice(0, limit).map(p => ({
      asin: p.asin,
      title: p.title,
      category: p.category,
      price: p.price,
      rating: p.ratingValue,
      reviews: p.reviews,
      imageUrl: p.imageUrl,
      link: p.link,
    }));
    res.json({
      total: eligible.length,
      lastRefreshed: products[0]?.scrapedAt || null,
      products: top,
    });
  } catch (err) {
    res.status(500).json({ error: 'Failed to load top products' });
  }
});

// Live aggregate stats for hero section
app.get('/api/stats', (req, res) => {
  try {
    const products = JSON.parse(fs.readFileSync(PRODUCTS_FILE, 'utf8'));
    const totalProducts = products.length;
    const topRatedCount = products.filter(p => p.ratingValue >= 4.6 && p.reviews >= 500).length;
    const avgRating = (() => {
      const rated = products.filter(p => p.ratingValue > 0);
      if (rated.length === 0) return 0;
      return rated.reduce((s, p) => s + p.ratingValue, 0) / rated.length;
    })();
    const lastRefreshed = products[0]?.scrapedAt || null;
    res.json({
      totalProducts,
      topRatedCount,
      avgRating: Math.round(avgRating * 10) / 10,
      lastRefreshed,
    });
  } catch (err) {
    res.status(500).json({ error: 'Failed to compute stats' });
  }
});

app.get('/api/market-data', (req, res) => {
  res.json({
    source: 'beauty-supply-chain-platform',
    stats: { factories: '50+', categories: '6', countriesServed: '15+', moq: 'from 50 units' },
    categories: [
      { name: 'Skincare', moq: '500', leadTime: '21 days' },
      { name: 'Makeup / Color Cosmetics', moq: '300', leadTime: '25 days' },
      { name: 'Hair Care', moq: '1,000', leadTime: '18 days' },
      { name: 'Fragrances', moq: '1,000', leadTime: '30 days' },
      { name: 'Beauty Tools & Accessories', moq: '200', leadTime: '15 days' },
      { name: 'OEM / ODM Custom Formulation', moq: '5,000', leadTime: '45 days' },
    ],
    certifications: ['FDA', 'CE', 'ISO 22716', 'GMPC', 'CNPN (EU)'],
  });
});

app.get('/admin', basicAuth, (req, res) => {
  res.sendFile(path.join(__dirname, 'admin', 'admin.html'));
});

app.get('/oem', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'oem.html'));
});

app.get('*', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

app.listen(PORT, () => {
  console.log(`\n🌸 Beauty Supply Chain`);
  console.log(`   Landing:  http://localhost:${PORT}`);
  console.log(`   Admin:    http://localhost:${PORT}/admin`);
  console.log(`   Auth:     ${ADMIN_USER} / ${ADMIN_PASS}`);
});
