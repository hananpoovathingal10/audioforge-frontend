const https = require('https');
const http = require('http');

module.exports = (req, res) => {
  // Set BACKEND_URL in your Vercel environment variables dashboard
  const backendUrl = process.env.BACKEND_URL || 'https://audioforge-backend.onrender.com';

  // Get the original URI requested by the user from Vercel's headers
  const originalUri = req.headers['x-forwarded-uri'] || req.url;

  // Parse target URL
  const targetUrl = new URL(originalUri, backendUrl);

  // Clone and override request headers
  const headers = { ...req.headers };
  headers.host = new URL(backendUrl).host;

  // Strip connection header (not allowed in proxied requests)
  delete headers['connection'];

  const options = {
    method: req.method,
    headers: headers,
  };

  const client = targetUrl.protocol === 'https:' ? https : http;

  const connector = client.request(targetUrl, options, (externalRes) => {
    // Forward status code and headers from the backend
    res.writeHead(externalRes.statusCode, externalRes.headers);
    externalRes.pipe(res, { end: true });
  });

  // Pipe request body to the backend
  req.pipe(connector, { end: true });

  connector.on('error', (err) => {
    console.error('Proxy Error:', err.message);
    // Use raw Node HTTP methods — res is NOT an Express response here
    if (!res.headersSent) {
      res.writeHead(502, { 'Content-Type': 'application/json' });
    }
    res.end(JSON.stringify({ error: 'Proxy communication error', details: err.message }));
  });
};
