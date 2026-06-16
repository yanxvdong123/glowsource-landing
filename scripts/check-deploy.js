const https = require('https');

const data = JSON.stringify({
  query: `query {
    deploymentLogs(deploymentId: "dd721e3e-f050-4305-9d44-a896b3fef5d8", limit: 100) {
      severity
      message
      timestamp
    }
  }`,
});

const req = https.request({
  hostname: 'backboard.railway.com',
  port: 443,
  path: '/graphql/v2',
  method: 'POST',
  headers: {
    'Content-Type': 'application/json',
    'Authorization': 'Bearer eee9e384-fb68-43bb-a4d4-4a1d755cb321',
    'Content-Length': data.length,
  },
}, (res) => {
  let body = '';
  res.on('data', (c) => (body += c));
  res.on('end', () => {
    console.log('Status:', res.statusCode);
    const j = JSON.parse(body);
    if (j.errors) {
      console.log('Errors:', JSON.stringify(j.errors, null, 2));
    } else {
      console.log('Deployment logs:');
      for (const l of j.data.deploymentLogs) {
        console.log(`[${l.severity || '?'}] ${l.message}`);
      }
    }
  });
});
req.on('error', (e) => console.error('ERR:', e.message));
req.write(data);
req.end();
