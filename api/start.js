// POST /api/start { token } → { sessionId, seed }
// The server picks the game's random seed so the finished game can be replayed and checked.
const crypto = require('crypto');
const { q, handler, readJson, send, verify, httpError } = require('./_lib');

module.exports = handler(['POST'], async (req, res) => {
  const b = await readJson(req, 5_000);
  const playerId = verify(b.token);
  const [recent] = await q(`select count(*)::int n from game_sessions where player_id = $1 and created_at > now() - interval '1 minute'`, [playerId]);
  if (recent.n >= 12) throw httpError(429, 'Too many games at once. Please wait a minute.');
  const seed = crypto.randomInt(1, 2 ** 31 - 1);
  const rows = await q('insert into game_sessions (player_id, seed) select id, $2 from players where id = $1 and verified_at is not null returning id', [playerId, seed]);
  if (!rows.length) throw httpError(401, 'Please sign in again');
  send(res, 200, { sessionId: rows[0].id, seed });
});
