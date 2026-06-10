'use strict';

require('dotenv').config();
const express = require('express');
const cors = require('cors');
const nodemailer = require('nodemailer');
const path = require('path');

const app = express();
const PORT = process.env.PORT || 3000;

app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// ─── Email (Gmail SMTP) ──────────────────────────────────────────────────────
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

async function sendContactNotification({ name, email, company, message, interest }) {
  try {
    const transport = getMailer();
    const to = process.env.CONTACT_TO || 'charlescome1995@gmail.com';
    await transport.sendMail({
      from: `"GlowSource Website" <${process.env.SMTP_USER || 'charlescome1995@gmail.com'}>`,
      to,
      subject: `[GlowSource] New inquiry from ${name || email}`,
      text: `New contact form submission:\n\nName: ${name || 'N/A'}\nEmail: ${email}\nCompany: ${company || 'N/A'}\nInterest: ${interest || 'N/A'}\n\nMessage:\n${message}`,
      html: `<h2>New GlowSource Inquiry</h2><ul><li><strong>Name:</strong> ${name || 'N/A'}</li><li><strong>Email:</strong> ${email}</li><li><strong>Company:</strong> ${company || 'N/A'}</li><li><strong>Interest:</strong> ${interest || 'N/A'}</li></ul><h3>Message:</h3><p>${message.replace(/\n/g, '<br>')}</p>`,
    });
    console.log(`[EMAIL] Sent notification to ${to}`);
    return true;
  } catch (err) {
    console.error('[EMAIL] Failed:', err.message);
    return false;
  }
}

// ─── Routes ─────────────────────────────────────────────────────────────────
app.get('/health', (req, res) => {
  res.json({ status: 'ok', service: 'beauty-supply-chain', timestamp: new Date().toISOString() });
});

// Contact form submission
app.post('/api/contact', async (req, res) => {
  const { name, email, company, message, interest } = req.body;

  if (!email || !message) {
    return res.status(400).json({ error: 'Email and message are required' });
  }

  console.log('\n📬 New Contact Form Submission:');
  console.log(`  Name:    ${name || 'N/A'}`);
  console.log(`  Email:   ${email}`);
  console.log(`  Company: ${company || 'N/A'}`);
  console.log(`  Interest: ${interest || 'N/A'}`);
  console.log(`  Message: ${message}`);


  // Send email notification
  await sendContactNotification({ name, email, company, message, interest });


  res.json({
    success: true,
    message: "Thank you! We'll get back to you within 24 hours."
  });
});

// API: Get market data summary (served from scraped data if available)
app.get('/api/market-data', (req, res) => {
  res.json({
    source: 'beauty-supply-chain-platform',
    stats: {
      factories: '50+',
      categories: '6',
      countriesServed: '15+',
      moq: 'from 50 units',
    },
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

// Serve landing page for all other routes
app.get('*', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

app.listen(PORT, () => {
  console.log(`\n🌸 Beauty Supply Chain Landing`);
  console.log(`   Server running on http://localhost:${PORT}`);
});