const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const { URL } = require('node:url');
const crypto = require('node:crypto');

const PORT = Number(process.env.PORT) || 3000;
const ROOT = __dirname;
const MIME = { '.html': 'text/html; charset=utf-8', '.css': 'text/css; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.json': 'application/json; charset=utf-8', '.svg': 'image/svg+xml', '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.gif': 'image/gif', '.ico': 'image/x-icon', '.txt': 'text/plain; charset=utf-8' };
const FREE_CHAT_LIMIT = 10;
const MONTHLY_PRICE = process.env.MOSAIC_MONTHLY_PRICE || '299.00';
const APP_URL = process.env.PUBLIC_BASE_URL || `http://localhost:${PORT}`;

const users = new Map();
const sessions = new Map();
const pendingOrders = new Map();

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

function readRaw(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    req.on('data', chunk => chunks.push(Buffer.from(chunk)));
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

function sanitizeEmail(email) {
  return String(email || '').trim().toLowerCase();
}

function createSessionCookieValue() {
  return crypto.randomBytes(24).toString('hex');
}

function parseCookies(req) {
  const header = req.headers.cookie || '';
  const cookies = {};
  for (const entry of header.split(';')) {
    const trimmed = entry.trim();
    if (!trimmed) continue;
    const equalsIndex = trimmed.indexOf('=');
    const key = equalsIndex === -1 ? trimmed : trimmed.slice(0, equalsIndex);
    const value = equalsIndex === -1 ? '' : trimmed.slice(equalsIndex + 1);
    cookies[key] = value;
  }
  return cookies;
}

function getSessionUser(req) {
  const sessionId = parseCookies(req).mosaic_session;
  if (!sessionId || !sessions.has(sessionId)) return null;
  const email = sessions.get(sessionId);
  const user = users.get(email);
  if (!user) {
    sessions.delete(sessionId);
    return null;
  }
  user.lastSeenAt = Date.now();
  return user;
}

function getPlanState(user) {
  const expiresAt = Number(user.planExpiresAt || 0);
  const isActive = Number.isFinite(expiresAt) && expiresAt > Date.now();
  return { active: isActive, expiresAt: expiresAt || null };
}

function upsertUser(email) {
  const normalized = sanitizeEmail(email);
  if (!normalized || !normalized.includes('@')) throw new Error('Please enter a valid email address.');
  const existing = users.get(normalized);
  if (existing) return existing;
  const user = {
    email: normalized,
    createdAt: Date.now(),
    lastSeenAt: Date.now(),
    freeChatsUsed: 0,
    planExpiresAt: null
  };
  users.set(normalized, user);
  return user;
}

function getFreeChatsLeft(user) {
  const remaining = FREE_CHAT_LIMIT - Number(user.freeChatsUsed || 0);
  return Math.max(0, remaining);
}

function canUseChat(user) {
  const plan = getPlanState(user);
  if (plan.active) return true;
  return getFreeChatsLeft(user) > 0;
}

function consumeFreeChat(user) {
  const plan = getPlanState(user);
  if (plan.active) return;
  user.freeChatsUsed = Math.min(FREE_CHAT_LIMIT, Number(user.freeChatsUsed || 0) + 1);
  user.lastSeenAt = Date.now();
}

function isGatewayConfigured() {
  return Boolean(process.env.YOUPI_API_URL && process.env.YOUPI_MERCHANT_ID && process.env.YOUPI_MERCHANT_API_KEY);
}

async function createYupiPayment(user, requestUrl) {
  const baseUrl = (process.env.YOUPI_API_URL || '').replace(/\/+$/, '');
  const merchantId = process.env.YOUPI_MERCHANT_ID;
  const merchantKey = process.env.YOUPI_MERCHANT_API_KEY;
  if (!baseUrl || !merchantId || !merchantKey) {
    return {
      demo: true,
      checkoutUrl: `${APP_URL}/?upgrade=demo&mode=local`,
      orderId: `mosaic-demo-${Date.now()}`,
      message: 'YOUPI is not configured. Demo local mode is enabled for development.'
    };
  }

  const origin = requestUrl && requestUrl.origin ? requestUrl.origin : APP_URL;
  const orderId = `mosaic-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  const returnUrl = `${origin}/?upgrade=success`;
  const payload = {
    orderId,
    amount: MONTHLY_PRICE,
    currency: 'INR',
    returnUrl,
    customer: {
      email: user.email,
      name: user.email.split('@')[0]
    },
    description: 'Mosaic AI Monthly Renewal',
    metadata: {
      email: user.email,
      plan: 'monthly',
      source: 'mosaic_ai'
    }
  };

  const response = await fetch(`${baseUrl}/api/v1/payments`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-Merchant-Id': merchantId,
      'X-Merchant-Key': merchantKey,
      'Idempotency-Key': `mosaic-${user.email}-${Date.now()}`
    },
    body: JSON.stringify(payload)
  });

  const data = await response.json().catch(() => ({}));
  if (!response.ok) {
    throw new Error(data?.error || data?.message || 'Unable to create a YOUPI checkout session.');
  }

  pendingOrders.set(orderId, { email: user.email, paymentId: data.paymentId || orderId, createdAt: Date.now() });
  return {
    demo: false,
    checkoutUrl: data.checkoutUrl || returnUrl,
    orderId,
    paymentId: data.paymentId || orderId,
    amount: MONTHLY_PRICE,
    currency: 'INR'
  };
}

function setMonthlyPlan(user) {
  const now = Date.now();
  user.planExpiresAt = now + 30 * 24 * 60 * 60 * 1000;
  user.lastSeenAt = now;
  return user;
}

function getOriginFromRequest(req) {
  const protocol = req.headers['x-forwarded-proto'] || 'http';
  const host = req.headers.host || 'localhost:3000';
  return `${protocol}://${host}`;
}

async function handleWebhook(req, res) {
  const rawBody = await readRaw(req);
  const signature = req.headers['x-gateway-signature'] || '';
  const secret = process.env.YOUPI_WEBHOOK_SECRET || '';

  if (secret && signature) {
    const expected = `sha256=${crypto.createHmac('sha256', secret).update(rawBody).digest('hex')}`;
    if (!crypto.timingSafeEqual(Buffer.from(signature), Buffer.from(expected))) {
      return send(res, 401, { error: 'Invalid webhook signature.' });
    }
  }

  let payload = {};
  try {
    payload = JSON.parse(rawBody.toString('utf8') || '{}');
  } catch {
    return send(res, 400, { error: 'Invalid webhook payload.' });
  }

  const orderId = payload.orderId || payload.paymentId;
  const pending = orderId ? pendingOrders.get(orderId) : null;
  if (pending && (payload.event === 'SUCCESS' || payload.event === 'RECONCILED' || payload.event === 'OBSERVED_SUCCESS')) {
    const user = users.get(pending.email);
    if (user) setMonthlyPlan(user);
    pendingOrders.delete(orderId);
  }

  return send(res, 200, { received: true, ok: true });
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);

  if (req.method === 'POST' && url.pathname === '/api/auth/email') {
    let payload;
    try { payload = await readJson(req); } catch (error) { return send(res, 400, { error: error.message }); }
    const email = sanitizeEmail(payload.email);
    if (!email || !email.includes('@')) return send(res, 400, { error: 'Please enter a valid email address.' });
    const user = upsertUser(email);
    const sessionId = createSessionCookieValue();
    sessions.set(sessionId, user.email);
    setSessionCookie(res, sessionId);
    const plan = getPlanState(user);
    return send(res, 200, {
      ok: true,
      user: {
        email: user.email,
        freeChatsUsed: Number(user.freeChatsUsed || 0),
        freeChatsRemaining: getFreeChatsLeft(user),
        planActive: plan.active,
        planExpiresAt: plan.expiresAt,
        monthlyPrice: MONTHLY_PRICE,
        freeChatsLimit: FREE_CHAT_LIMIT
      }
    });
  }

  if (req.method === 'POST' && url.pathname === '/api/auth/logout') {
    const cookies = parseCookies(req);
    const sessionId = cookies.mosaic_session;
    if (sessionId) sessions.delete(sessionId);
    res.setHeader('Set-Cookie', 'mosaic_session=; Path=/; Max-Age=0; HttpOnly; SameSite=Lax');
    return send(res, 200, { ok: true, loggedOut: true });
  }

  if (req.method === 'GET' && url.pathname === '/api/account') {
    const user = getSessionUser(req);
    if (!user) return send(res, 200, { loggedIn: false, freeChatsLimit: FREE_CHAT_LIMIT, monthlyPrice: MONTHLY_PRICE });
    const plan = getPlanState(user);
    return send(res, 200, {
      loggedIn: true,
      user: {
        email: user.email,
        freeChatsUsed: Number(user.freeChatsUsed || 0),
        freeChatsRemaining: getFreeChatsLeft(user),
        planActive: plan.active,
        planExpiresAt: plan.expiresAt,
        monthlyPrice: MONTHLY_PRICE,
        freeChatsLimit: FREE_CHAT_LIMIT
      }
    });
  }

  if (req.method === 'POST' && url.pathname === '/api/payments/create') {
    const user = getSessionUser(req);
    if (!user) return send(res, 401, { error: 'Sign in with your email to manage billing.' });
    const origin = getOriginFromRequest(req);
    try {
      const result = await createYupiPayment(user, { origin });
      return send(res, 200, { ok: true, ...result });
    } catch (error) {
      return send(res, 400, { error: error.message || 'Unable to create billing checkout.' });
    }
  }

  if (req.method === 'POST' && url.pathname === '/api/payments/demo-activate') {
    const user = getSessionUser(req);
    if (!user) return send(res, 401, { error: 'Sign in with your email to continue.' });
    setMonthlyPlan(user);
    return send(res, 200, { ok: true, planActive: true, planExpiresAt: user.planExpiresAt, demo: true });
  }

  if (req.method === 'POST' && url.pathname === '/api/webhooks/youpi') {
    return handleWebhook(req, res);
  }

  if (req.method === 'GET' && url.pathname === '/api/config') {
    return send(res, 200, { configured: Boolean(process.env.MESH_API_KEY), appName: 'Mosaic AI', freeChatsLimit: FREE_CHAT_LIMIT, monthlyPrice: MONTHLY_PRICE, emailRequired: true });
  }

  if (req.method === 'POST' && url.pathname === '/api/chat') {
    const user = getSessionUser(req);
    if (!user) return send(res, 401, { error: 'Sign in with your email before chatting.' });
    if (!canUseChat(user)) {
      return send(res, 403, {
        code: 'UPGRADE_REQUIRED',
        error: 'You have used all 10 free chats. Renew your monthly plan to continue.',
        monthlyPrice: MONTHLY_PRICE,
        freeChatsLeft: 0,
        freeChatsLimit: FREE_CHAT_LIMIT,
        gatewayConfigured: isGatewayConfigured()
      });
    }

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
      const reply = result?.choices?.[0]?.message?.content ?? 'No text response was returned.';
      const plan = getPlanState(user);
      if (!plan.active) consumeFreeChat(user);
      return send(res, 200, {
        reply,
        usage: result?.usage || null,
        freeChatsRemaining: getFreeChatsLeft(user),
        freeChatsLimit: FREE_CHAT_LIMIT,
        planActive: getPlanState(user).active
      });
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
      return send(res, 200, { models: Array.isArray(models) ? models.filter(m => m && typeof m.id === 'string' && (m.model_type === 'text' || (m.input_modalities || []).includes('text'))).map(m => ({ id: m.id, name: m.name || m.id, brand: m.provider || 'Mesh', is_free: Boolean(m.is_free) })) : [] });
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
