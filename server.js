const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const { URL } = require('node:url');

const PORT = Number(process.env.PORT) || 3000;
const ROOT = __dirname;
const MIME = { '.html': 'text/html; charset=utf-8', '.css': 'text/css; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.json': 'application/json; charset=utf-8', '.svg': 'image/svg+xml', '.png': 'image/png', '.ico': 'image/x-icon' };

function send(res, status, data, type = 'application/json; charset=utf-8') {
  res.writeHead(status, { 'Content-Type': type, 'X-Content-Type-Options': 'nosniff', 'Cache-Control': 'no-store' });
  res.end(typeof data === 'string' ? data : JSON.stringify(data));
}

function readJson(req) {
  return new Promise((resolve, reject) => {
    let body = '';
    req.on('data', chunk => {
      body += chunk;
      if (body.length > 1_000_000) {
        reject(new Error('Request too large'));
        req.destroy();
      }
    });
    req.on('end', () => {
      try { resolve(JSON.parse(body || '{}')); } catch { reject(new Error('Invalid JSON body')); }
    });
    req.on('error', reject);
  });
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
  if (req.method === 'GET' && url.pathname === '/api/config') {
    return send(res, 200, { configured: Boolean(process.env.MESH_API_KEY), appName: 'Mosaic AI' });
  }
  if (req.method === 'POST' && url.pathname === '/api/chat') {
    if (!process.env.MESH_API_KEY) return send(res, 503, { error: 'The site owner has not configured Mesh API yet.' });
    let input;
    try { input = await readJson(req); } catch (error) { return send(res, 400, { error: error.message }); }
    const messages = Array.isArray(input.messages) ? input.messages : [];
    const model = typeof input.model === 'string' ? input.model : '';
    if (!model || model.length > 160) return send(res, 400, { error: 'Choose a valid model.' });
    if (!messages.length || messages.length > 50 || messages.some(m => !m || !['user', 'assistant'].includes(m.role) || typeof m.content !== 'string' || m.content.length > 20000)) {
      return send(res, 400, { error: 'Messages must contain up to 50 user and assistant text messages.' });
    }
    try {
      const upstream = await fetch('https://api.meshapi.ai/v1/chat/completions', {
        method: 'POST',
        headers: { 'Authorization': `Bearer ${process.env.MESH_API_KEY}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ model, messages: [{ role: 'system', content: 'You are a helpful, clear, and friendly AI assistant.' }, ...messages] }),
        signal: AbortSignal.timeout(90000)
      });
      const result = await upstream.json().catch(() => ({}));
      if (!upstream.ok) {
        const message = result?.error?.message || result?.message || `Mesh API request failed (${upstream.status}).`;
        return send(res, upstream.status, { error: message });
      }
      return send(res, 200, { reply: result?.choices?.[0]?.message?.content ?? 'No text response was returned.', usage: result?.usage || null });
    } catch (error) {
      return send(res, 502, { error: error.name === 'TimeoutError' ? 'The model took too long to respond. Please try again.' : 'Could not reach Mesh API. Please try again.' });
    }
  }
  if (req.method === 'GET' && (url.pathname === '/api/models' || url.pathname === '/api/models/')) {
    if (!process.env.MESH_API_KEY) return send(res, 503, { error: 'The site owner has not configured Mesh API yet.' });
    try {
      const upstream = await fetch('https://api.meshapi.ai/v1/models', { headers: { 'Authorization': `Bearer ${process.env.MESH_API_KEY}` }, signal: AbortSignal.timeout(20000) });
      const data = await upstream.json().catch(() => ({}));
      if (!upstream.ok) return send(res, upstream.status, { error: data?.error?.message || 'Could not load models.' });
      const models = Array.isArray(data) ? data : data?.data;
      return send(res, 200, { models: Array.isArray(models) ? models.filter(m => m && typeof m.id === 'string' && (m.model_type === 'text' || (m.input_modalities || []).includes('text'))).map(m => ({ id: m.id, name: m.name || m.id, brand: m.brand || '', is_free: Boolean(m.is_free), model_type: m.model_type || 'text' })) : [] });
    } catch {
      return send(res, 502, { error: 'Could not reach Mesh API to load models.' });
    }
  }
  if (req.method !== 'GET' && req.method !== 'HEAD') return send(res, 405, { error: 'Method not allowed.' });
  const pathname = decodeURIComponent(url.pathname === '/' ? '/index.html' : url.pathname);
  const filePath = path.resolve(ROOT, `.${pathname}`);
  if (!filePath.startsWith(`${ROOT}${path.sep}`) && filePath !== path.join(ROOT, 'index.html')) return send(res, 403, 'Forbidden', 'text/plain');
  fs.readFile(filePath, (error, content) => {
    if (error) return send(res, 404, 'Not found', 'text/plain; charset=utf-8');
    res.writeHead(200, { 'Content-Type': MIME[path.extname(filePath)] || 'application/octet-stream', 'X-Content-Type-Options': 'nosniff' });
    if (req.method === 'HEAD') return res.end();
    res.end(content);
  });
});

server.listen(PORT, '0.0.0.0', () => console.log(`Mosaic AI running at http://localhost:${PORT}`));
