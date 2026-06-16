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
const PRODUCTS_FILE = path.join(__dirname, 'data', 'amazon-beauty-top100.json');
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
    res.json({ total: JSON.parse(raw).length, products: JSON.parse(raw) });
  } catch (err) {
    res.status(500).json({ error: 'Failed to load product data' });
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

app.get('*', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

app.listen(PORT, () => {
  console.log(`\n🌸 Beauty Supply Chain`);
  console.log(`   Landing:  http://localhost:${PORT}`);
  console.log(`   Admin:    http://localhost:${PORT}/admin`);
  console.log(`   Auth:     ${ADMIN_USER} / ${ADMIN_PASS}`);
});
