// POST /api/register  { name, email, phone, consent, lat, lng, accuracy, city, region, country }
// Creates the player (or updates them if this mobile number already played) and returns a token.
const { q, handler, readJson, send, sign, httpError, ipGeo, clip, num } = require('./_lib');

module.exports = handler(['POST'], async (req, res) => {
  const b = await readJson(req, 20_000);
  const name = clip(b.name, 60) || '';
  const email = (clip(b.email, 120) || '').toLowerCase();
  let phone = String(b.phone || '').replace(/\D/g, '');
  if (phone.length === 12 && phone.startsWith('91')) phone = phone.slice(2);
  if (phone.length === 11 && phone.startsWith('0')) phone = phone.slice(1);
  if (name.length < 2) throw httpError(400, 'Please enter your name');
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(email)) throw httpError(400, 'Please enter a valid email address');
  if (!/^[6-9]\d{9}$/.test(phone)) throw httpError(400, 'Please enter a valid 10-digit mobile number');
  if (b.consent !== true) throw httpError(400, 'Please accept the contest terms to play');

  const lat = num(b.lat, -90, 90), lng = num(b.lng, -180, 180);
  const gps = lat != null && lng != null;
  const ip = ipGeo(req);
  const rows = await q(
    `insert into players (name, email, phone, lat, lng, location_accuracy_m, location_source, city, region, country,
                          ip_city, ip_region, ip_country, user_agent)
     values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14)
     on conflict (phone) do update set
       name = excluded.name, email = excluded.email, last_seen_at = now(), consent_at = now(),
       lat = coalesce(excluded.lat, players.lat), lng = coalesce(excluded.lng, players.lng),
       location_accuracy_m = coalesce(excluded.location_accuracy_m, players.location_accuracy_m),
       location_source = case when excluded.lat is not null then 'gps' else players.location_source end,
       city = coalesce(excluded.city, players.city), region = coalesce(excluded.region, players.region),
       country = coalesce(excluded.country, players.country),
       ip_city = excluded.ip_city, ip_region = excluded.ip_region, ip_country = excluded.ip_country,
       user_agent = excluded.user_agent
     returning id, name`,
    [name, email, phone, lat, lng, num(b.accuracy, 0, 1e6), gps ? 'gps' : 'network',
     gps ? clip(b.city, 80) : null, gps ? clip(b.region, 80) : null, gps ? clip(b.country, 80) : null,
     ip.city, ip.region, ip.country, clip(req.headers['user-agent'], 300)]);
  const p = rows[0];
  const [st] = await q('select * from player_standing($1)', [p.id]);
  send(res, 200, { token: sign(p.id), name: p.name, best: st.out_best, rank: st.out_rank == null ? null : Number(st.out_rank), total: Number(st.out_total) });
});
