const https = require('https');
const http = require('http');

module.exports = (req, res) => {
  const backendUrl = process.env.api_key || 'https://audioforge-backend.onrender.com';
  
  // Get the original URI requested by the user from Vercel's headers
  const originalUri = req.headers['x-forwarded-uri'] || req.url;
  
  // Parse target URL
  const targetUrl = new URL(originalUri, backendUrl);
  
  // Clone and override request headers
  const headers = { ...req.headers };
  headers.host = new URL(backendUrl).host;
  
  // Strip Vercel-specific headers if necessary
  delete headers['connection'];

  const options = {
    method: req.method,
    headers: headers,
  };

  const client = targetUrl.protocol === 'https:' ? https : http;

  const connector = client.request(targetUrl, options, (externalRes) => {
    // Forward status code and headers
    res.writeHead(externalRes.statusCode, externalRes.headers);
    externalRes.pipe(res, { end: true });
  });

  // Pipe client request body to the connector
  req.pipe(connector, { end: true });

  connector.on('error', (err) => {
    console.error('Proxy Error:', err.message);
    res.status(500).json({ error: 'Proxy communication error', details: err.message });
  });
};
