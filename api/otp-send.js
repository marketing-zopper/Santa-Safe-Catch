// POST /api/otp-send
//   sign-up: { mode:'signup', name, email, phone, consent:true, lat, lng, accuracy, city, region, country }
//   log-in:  { mode:'login', email }
// Emails a 6-digit code. Returns { otpId, email (masked), resendIn }.
const crypto = require('crypto');
const { q, handler, readJson, send, httpError, clip, num, ipGeo } = require('./_lib');
const { sendEmail, otpEmail } = require('./_email');

const CODE_TTL_MIN = 10, RESEND_SEC = 30, MAX_PER_HOUR_EMAIL = 6, MAX_PER_HOUR_IP = 30;

function hashCode(otpEmailAddr, code) {
  const s = process.env.TOKEN_SECRET;
  if (!s || s.length < 16) throw httpError(500, 'Server is not configured (TOKEN_SECRET missing)');
  return crypto.createHmac('sha256', s).update(otpEmailAddr.toLowerCase() + ':' + code).digest('hex');
}
const mask = e => { const [u, d] = e.split('@'); return (u.length <= 2 ? u[0] + '*' : u.slice(0, 2) + '*'.repeat(Math.min(6, u.length - 2))) + '@' + d; };
const ipOf = req => String(req.headers['x-forwarded-for'] || req.socket?.remoteAddress || '').split(',')[0].trim().slice(0, 64);

function normPhone(v) {
  let p = String(v || '').replace(/\D/g, '');
  if (p.length === 12 && p.startsWith('91')) p = p.slice(2);
  if (p.length === 11 && p.startsWith('0')) p = p.slice(1);
  return p;
}
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;

module.exports = handler(['POST'], async (req, res) => {
  const b = await readJson(req, 20_000);
  const mode = b.mode === 'login' ? 'login' : 'signup';
  const email = (clip(b.email, 120) || '').toLowerCase();
  if (!EMAIL_RE.test(email)) throw httpError(400, 'Please enter a valid email address');

  let payload = null, name = '';
  if (mode === 'signup') {
    name = clip(b.name, 60) || '';
    const phone = normPhone(b.phone);
    if (name.length < 2) throw httpError(400, 'Please enter your name');
    if (!/^[6-9]\d{9}$/.test(phone)) throw httpError(400, 'Please enter a valid 10-digit mobile number');
    if (b.consent !== true) throw httpError(400, 'Please accept the contest terms to play');
    const [byEmail] = await q('select id, phone, verified_at from players where lower(email) = $1', [email]);
    const [byPhone] = await q('select id, lower(email) as email, verified_at from players where phone = $1', [phone]);
    if (byEmail && byEmail.verified_at && byEmail.phone !== phone) throw httpError(409, 'This email is already registered with another mobile number. Tap "Log in" to continue with it.');
    if (byPhone && byPhone.verified_at && byPhone.email !== email) throw httpError(409, 'This mobile number is already registered with another email. Tap "Log in" and use that email.');
    if (byEmail && byEmail.verified_at && byEmail.phone === phone) { /* same person signing up again: treat like a log-in, details get refreshed on verify */ }
    const lat = num(b.lat, -90, 90), lng = num(b.lng, -180, 180);
    payload = { name, email, phone, consent: true, lat, lng, accuracy: num(b.accuracy, 0, 1e6),
      city: clip(b.city, 80), region: clip(b.region, 80), country: clip(b.country, 80) };
  } else {
    const [p] = await q('select name from players where lower(email) = $1 and verified_at is not null', [email]);
    if (!p) throw httpError(404, "We couldn't find a player with this email. Check the spelling, or sign up instead.");
    name = p.name;
  }

  const ip = ipOf(req);
  const [lim] = await q(`select
      (select count(*)::int from otp_codes where lower(email) = $1 and created_at > now() - interval '1 hour') as per_email,
      (select extract(epoch from now() - max(created_at))::int from otp_codes where lower(email) = $1) as since_last,
      (select count(*)::int from otp_codes where ip = $2 and created_at > now() - interval '1 hour') as per_ip`, [email, ip]);
  if (lim.since_last != null && lim.since_last < RESEND_SEC) throw httpError(429, `Please wait ${RESEND_SEC - lim.since_last} seconds before asking for a new code.`);
  if (lim.per_email >= MAX_PER_HOUR_EMAIL || lim.per_ip >= MAX_PER_HOUR_IP) throw httpError(429, 'Too many codes requested. Please try again in a little while.');

  const code = String(crypto.randomInt(0, 1_000_000)).padStart(6, '0');
  // a new code replaces any older unused ones for this email
  await q(`update otp_codes set used_at = now() where lower(email) = $1 and used_at is null`, [email]);
  const [row] = await q(`insert into otp_codes (email, purpose, code_hash, payload, ip, expires_at)
                         values ($1,$2,$3,$4,$5, now() + ($6 || ' minutes')::interval) returning id`,
    [email, mode, hashCode(email, code), payload ? JSON.stringify(payload) : null, ip, String(CODE_TTL_MIN)]);

  const msg = otpEmail({ name, code, purpose: mode });
  try { await sendEmail({ to: email, toName: name, ...msg, kind: 'otp' }); }
  catch (e) {
    await q('update otp_codes set used_at = now() where id = $1', [row.id]);
    throw httpError(503, "We couldn't send the email just now. Please check the address and try again.");
  }
  const out = { otpId: row.id, email: mask(email), resendIn: RESEND_SEC, expiresIn: CODE_TTL_MIN * 60 };
  if (process.env.OTP_DEV_ECHO === '1' && !process.env.BREVO_API_KEY) out.devCode = code;   // local testing only
  send(res, 200, out);
});
module.exports.hashCode = hashCode;
