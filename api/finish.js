// POST /api/finish { token, sessionId, inputs:[tick,x,...], endTick, clientScore, lat, lng, city }
// Re-runs the game on the server from the seed + recorded moves; that score is what counts.
const { q, handler, readJson, send, verify, httpError, ipGeo, clip, num } = require('./_lib');
const { replay } = require('../engine.js');
const { sendEmail, thanksEmail } = require('./_email');

const MAX_TICKS = 60 * 60 * 45; // 45 minutes of play

module.exports = handler(['POST'], async (req, res) => {
  const b = await readJson(req, 4_000_000);
  const playerId = verify(b.token);
  if (typeof b.sessionId !== 'string' || !/^[0-9a-f-]{36}$/.test(b.sessionId)) throw httpError(400, 'Missing game id');
  const inputs = b.inputs;
  if (!Array.isArray(inputs) || inputs.length % 2 || inputs.length > MAX_TICKS * 2) throw httpError(400, 'Invalid game data');
  let prev = 0;
  for (let i = 0; i < inputs.length; i += 2) {
    const t = inputs[i], x = inputs[i + 1];
    if (!Number.isInteger(t) || t < prev || t > MAX_TICKS || typeof x !== 'number' || !Number.isFinite(x)) throw httpError(400, 'Invalid game data');
    prev = t;
  }
  const endTick = Number.isInteger(b.endTick) && b.endTick > 0 ? Math.min(b.endTick, MAX_TICKS) : MAX_TICKS;

  const [s] = await q(`select seed, created_at, used_at, extract(epoch from now() - created_at) as age
                       from game_sessions where id = $1 and player_id = $2`, [b.sessionId, playerId]);
  if (!s) throw httpError(404, 'Game not found');
  if (s.used_at) throw httpError(409, 'This game was already saved');

  const r = replay(Number(s.seed), inputs, endTick, MAX_TICKS);
  // A game can't take less real time than it took to play (60 ticks = 1 second). Allow a little slack.
  const flags = [];
  if (r.t > Number(s.age) + 8 && process.env.SKIP_TIME_CHECK !== '1') flags.push('faster_than_real_time');
  if (Number(s.age) > 6 * 3600) flags.push('stale_session');
  const clientScore = Number.isInteger(b.clientScore) ? b.clientScore : null;
  if (clientScore != null && clientScore !== r.score) flags.push('client_mismatch:' + clientScore);
  const flagged = flags.some(f => f !== 'client_mismatch:' + clientScore);

  const ip = ipGeo(req);
  let st;
  try {
    [st] = await q('select * from record_game($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)', [
      playerId, b.sessionId, r.score, clientScore, Math.round(r.t * 10) / 10, r.caught, flagged, flags.join(',') || null,
      num(b.lat, -90, 90), num(b.lng, -180, 180), clip(b.city, 80), ip.city, clip(req.headers['user-agent'], 300)]);
  } catch (e) {
    if (/session_used_or_missing/.test(e.message)) throw httpError(409, 'This game was already saved');
    throw e;
  }
  // First finished game → thank-you email (sent once; if sending fails it is retried after the next game)
  let emailed = false;
  const [claim] = await q(`update players set first_email_sent_at = now() where id = $1 and first_email_sent_at is null returning name, email`, [playerId]);
  if (claim) {
    try {
      const msg = thanksEmail({ name: claim.name, score: r.score, best: st.out_best, rank: st.out_rank == null ? null : Number(st.out_rank), total: Number(st.out_total) });
      await sendEmail({ to: claim.email, toName: claim.name, ...msg, kind: 'thanks', playerId });
      emailed = true;
    } catch (e) {
      await q('update players set first_email_sent_at = null where id = $1', [playerId]);
      if (!e.emailFailed) console.error(e);
    }
  }
  send(res, 200, { emailed, score: r.score, best: st.out_best, rank: st.out_rank == null ? null : Number(st.out_rank), total: Number(st.out_total), flagged });
});
