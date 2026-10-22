// POST /api/otp-verify { otpId, code } → { token, name, best, rank, total }
// Checks the emailed code, then creates/updates the player (sign-up) or finds them (log-in).
const crypto = require('crypto');
const { q, handler, readJson, send, httpError, sign, ipGeo, clip } = require('./_lib');
const { hashCode } = require('./otp-send');

const MAX_ATTEMPTS = 5;

module.exports = handler(['POST'], async (req, res) => {
  const b = await readJson(req, 5_000);
  if (typeof b.otpId !== 'string' || !/^[0-9a-f-]{36}$/.test(b.otpId)) throw httpError(400, 'Please request a new code');
  const code = String(b.code || '').replace(/\D/g, '');
  if (code.length !== 6) throw httpError(400, 'Enter the 6-digit code from the email');

  const [o] = await q(`select id, email, purpose, code_hash, payload, attempts, used_at, expires_at < now() as expired from otp_codes where id = $1`, [b.otpId]);
  if (!o || o.used_at) throw httpError(410, 'This code is no longer valid. Tap "Resend code" to get a new one.');
  if (o.expired) throw httpError(410, 'This code has expired. Tap "Resend code" to get a new one.');
  if (o.attempts >= MAX_ATTEMPTS) throw httpError(429, 'Too many wrong tries. Tap "Resend code" to get a new one.');

  const want = Buffer.from(o.code_hash, 'hex'), got = Buffer.from(hashCode(o.email, code), 'hex');
  if (!crypto.timingSafeEqual(want, got)) {
    const [{ attempts }] = await q('update otp_codes set attempts = attempts + 1 where id = $1 returning attempts', [o.id]);
    const left = MAX_ATTEMPTS - attempts;
    throw httpError(400, left > 0 ? `That code isn't right. ${left} ${left === 1 ? 'try' : 'tries'} left.` : 'Too many wrong tries. Tap "Resend code" to get a new one.');
  }
  // burn the code (only one request can win)
  const burned = await q('update otp_codes set used_at = now() where id = $1 and used_at is null returning id', [o.id]);
  if (!burned.length) throw httpError(410, 'This code was already used. Tap "Resend code" to get a new one.');

  let playerId;
  if (o.purpose === 'login') {
    const [p] = await q('update players set last_seen_at = now() where lower(email) = lower($1) and verified_at is not null returning id', [o.email]);
    if (!p) throw httpError(404, "We couldn't find your player. Please sign up.");
    playerId = p.id;
  } else {
    const d = o.payload || {};
    const gps = d.lat != null && d.lng != null;
    const ip = ipGeo(req);
    try {
      const [p] = await q(
        `insert into players (name, email, phone, lat, lng, location_accuracy_m, location_source, city, region, country,
                              ip_city, ip_region, ip_country, user_agent, verified_at)
         values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14, now())
         on conflict (phone) do update set
           name = excluded.name, email = excluded.email, last_seen_at = now(), consent_at = now(),
           verified_at = coalesce(players.verified_at, now()),
           lat = coalesce(excluded.lat, players.lat), lng = coalesce(excluded.lng, players.lng),
           location_accuracy_m = coalesce(excluded.location_accuracy_m, players.location_accuracy_m),
           location_source = case when excluded.lat is not null then 'gps' else players.location_source end,
           city = coalesce(excluded.city, players.city), region = coalesce(excluded.region, players.region),
           country = coalesce(excluded.country, players.country),
           ip_city = excluded.ip_city, ip_region = excluded.ip_region, ip_country = excluded.ip_country,
           user_agent = excluded.user_agent
         returning id`,
        [d.name, d.email, d.phone, gps ? d.lat : null, gps ? d.lng : null, d.accuracy ?? null, gps ? 'gps' : 'network',
         gps ? d.city : null, gps ? d.region : null, gps ? d.country : null,
         ip.city, ip.region, ip.country, clip(req.headers['user-agent'], 300)]);
      playerId = p.id;
    } catch (e) {
      if (e.code === '23505') throw httpError(409, 'This email is already registered with another mobile number. Tap "Log in" to continue with it.');
      throw e;
    }
  }
  const [p] = await q('select name from players where id = $1', [playerId]);
  const [st] = await q('select * from player_standing($1)', [playerId]);
  send(res, 200, { token: sign(playerId), name: p.name, best: st.out_best, rank: st.out_rank == null ? null : Number(st.out_rank), total: Number(st.out_total) });
});
