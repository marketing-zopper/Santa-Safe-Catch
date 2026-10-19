// Shared helpers for the Vercel API routes.
// Env vars (set in Vercel → Project → Settings → Environment Variables):
//   DATABASE_URL    Supabase → Connect → "Transaction pooler" connection string (port 6543)
//   TOKEN_SECRET    any long random string (signs player tokens)
//   ADMIN_PASSWORD  password for the /admin dashboard
const crypto = require('crypto');
const { Pool } = require('pg');

let pool;
function db() {
  if (!pool) {
    const url = (process.env.DATABASE_URL || '').trim().replace(/^["']|["']$/g, '');
    if (!url) throw httpError(500, 'Server is not configured (DATABASE_URL missing)');
    const local = /localhost|127\.0\.0\.1|host=\/|@\/|%2F/.test(url) || process.env.DB_NO_SSL === '1';
    pool = new Pool({ connectionString: url, max: 3, idleTimeoutMillis: 10000, ssl: local ? false : { rejectUnauthorized: false } });
  }
  return pool;
}
async function q(text, params) { return (await db().query(text, params)).rows; }

function httpError(status, message) { const e = new Error(message); e.status = status; return e; }

async function readJson(req, limit = 3_000_000) {
  if (req.body && typeof req.body === 'object') return req.body;
  if (typeof req.body === 'string') return JSON.parse(req.body || '{}');
  let size = 0; const chunks = [];
  for await (const c of req) { size += c.length; if (size > limit) throw httpError(413, 'Request too large'); chunks.push(c); }
  const raw = Buffer.concat(chunks).toString('utf8');
  try { return raw ? JSON.parse(raw) : {}; } catch { throw httpError(400, 'Invalid JSON'); }
}

function send(res, status, data, extraHeaders) {
  res.statusCode = status;
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  res.setHeader('Cache-Control', 'no-store');
  for (const [k, v] of Object.entries(extraHeaders || {})) res.setHeader(k, v);
  res.end(JSON.stringify(data));
}

function handler(methods, fn) {
  return async (req, res) => {
    try {
      if (!methods.includes(req.method)) throw httpError(405, 'Method not allowed');
      await fn(req, res);
    } catch (e) {
      const status = e.status || 500;
      if (status >= 500) console.error(e);
      send(res, status, { error: status >= 500 && !e.status ? 'Something went wrong. Please try again.' : e.message });
    }
  };
}

// ---- player tokens: "<playerId>.<hmac>" ----
function secret() {
  const s = process.env.TOKEN_SECRET;
  if (!s || s.length < 16) throw httpError(500, 'Server is not configured (TOKEN_SECRET missing)');
  return s;
}
function sign(id) { return id + '.' + crypto.createHmac('sha256', secret()).update(id).digest('base64url'); }
function verify(token) {
  if (typeof token !== 'string' || token.length > 200) throw httpError(401, 'Please sign in again');
  const [id, sig] = token.split('.');
  const good = crypto.createHmac('sha256', secret()).update(id || '').digest('base64url');
  if (!sig || sig.length !== good.length || !crypto.timingSafeEqual(Buffer.from(sig), Buffer.from(good))) throw httpError(401, 'Please sign in again');
  if (!/^[0-9a-f-]{36}$/.test(id)) throw httpError(401, 'Please sign in again');
  return id;
}

// ---- request context ----
function ipGeo(req) {
  const h = n => { const v = req.headers[n]; try { return v ? decodeURIComponent(String(v)) : null; } catch { return String(v); } };
  return { city: h('x-vercel-ip-city'), region: h('x-vercel-ip-country-region'), country: h('x-vercel-ip-country') };
}
const clip = (v, n) => (v == null ? null : String(v).trim().slice(0, n) || null);
const num = (v, lo, hi) => { const x = Number(v); return Number.isFinite(x) && x >= lo && x <= hi ? x : null; };

function requireAdmin(req) {
  const want = process.env.ADMIN_PASSWORD;
  if (!want) throw httpError(500, 'Server is not configured (ADMIN_PASSWORD missing)');
  const got = String(req.headers['x-admin-key'] || '');
  const a = crypto.createHash('sha256').update(got).digest(), b = crypto.createHash('sha256').update(want).digest();
  if (!crypto.timingSafeEqual(a, b)) throw httpError(401, 'Wrong password');
}

module.exports = { q, db, httpError, readJson, send, handler, sign, verify, ipGeo, clip, num, requireAdmin };
