// GET /api/leaderboard → top players (first name + initial only) for the in-game board
const { q, handler, send } = require('./_lib');

const shortName = n => { const p = String(n).trim().split(/\s+/); return p.length > 1 ? `${p[0]} ${p[p.length - 1][0].toUpperCase()}.` : p[0]; };

module.exports = handler(['GET'], async (req, res) => {
  const rows = await q(`select rank, name, best_score from leaderboard order by rank limit 10`);
  const [{ n }] = await q('select count(*)::int n from leaderboard');
  send(res, 200, { total: n, top: rows.map(r => ({ rank: Number(r.rank), name: shortName(r.name), score: r.best_score })) },
    { 'Cache-Control': 'public, s-maxage=20, stale-while-revalidate=60' });
});
