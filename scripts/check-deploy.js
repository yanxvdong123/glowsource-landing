const https = require('https');

const data = JSON.stringify({
  query: `mutation {
    serviceInstanceRedeploy(serviceId: "e4789c77-2364-45fe-a206-3ac838a9bf41", environmentId: "6be0be54-72c5-40a8-a668-c1058db48d4e")
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
    console.log('Body:', body);
  });
});
req.on('error', (e) => console.error('ERR:', e.message));
req.write(data);
req.end();
