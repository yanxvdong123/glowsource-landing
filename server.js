'use strict';

require('dotenv').config();
const express = require('express');
const cors = require('cors');
const nodemailer = require('nodemailer');
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

// Email
let mailer;
function getMailer() {
  if (!mailer) {
    mailer = nodemailer.createTransport({
      host: 'smtp.gmail.com',
      port: 465,
      secure: true,
      auth: {
        user: process.env.SMTP_USER || 'charlescome1995@gmail.com',
        pass: process.env.SMTP_PASS || 'Charles@1995',
      },
    });
  }
  return mailer;
}

async function sendContactNotification({ name, email, company, message, interest, productName, productAsin }) {
  try {
    const transport = getMailer();
    const to = process.env.CONTACT_TO || 'charlescome1995@gmail.com';
    const productInfo = productName ? `<li><strong>Product:</strong> ${productName} (ASIN: ${productAsin})</li>` : '';
    await transport.sendMail({
      from: `"GlowSource Website" <${process.env.SMTP_USER || 'charlescome1995@gmail.com'}>`,
      to,
      subject: `[GlowSource] New lead${productName ? ': ' + productName : ''} from ${name || email}`,
      text: `New contact form submission:\n\nName: ${name || 'N/A'}\nEmail: ${email}\nCompany: ${company || 'N/A'}\nInterest: ${interest || 'N/A'}\n${productName ? `Product: ${productName} (ASIN: ${productAsin})` : ''}\n\nMessage:\n${message}`,
      html: `<h2>New GlowSource Lead</h2><ul><li><strong>Name:</strong> ${name || 'N/A'}</li><li><strong>Email:</strong> ${email}</li><li><strong>Company:</strong> ${company || 'N/A'}</li><li><strong>Interest:</strong> ${interest || 'N/A'}</li>${productInfo}</ul><h3>Message:</h3><p>${message.replace(/\n/g, '<br>')}</p>`,
    });
    console.log(`[EMAIL] Sent notification to ${to}`);
    return true;
  } catch (err) {
    console.error('[EMAIL] Failed:', err.message);
    return false;
  }
}

// Routes
app.get('/health', (req, res) => {
  res.json({ status: 'ok', service: 'beauty-supply-chain', timestamp: new Date().toISOString() });
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
  await sendContactNotification({ name, email, company, message, interest, productName, productAsin });
  res.json({ success: true, message: "Thank you! We'll get back to you within 24 hours.", leadId: newLead.id });
});

app.get('/api/leads', basicAuth, (req, res) => {
  res.json({ total: loadLeads().length, leads: loadLeads() });
});

app.patch('/api/leads/:id', basicAuth, (req, res) => {
  const { id } = req.params;
  const { status } = req.body;
  const leads = loadLeads();
  const idx = leads.findIndex(l => l.id === id);
  if (idx === -1) return res.status(404).json({ error: 'Lead not found' });
  leads[idx].status = status || leads[idx].status;
  if (status === 'contacted') leads[idx].contactedAt = new Date().toISOString();
  if (status === 'replied') leads[idx].repliedAt = new Date().toISOString();
  saveLeads(leads);
  res.json({ success: true, lead: leads[idx] });
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