// Admin API for the /admin dashboard. Every call needs the header  x-admin-key: <ADMIN_PASSWORD>
//   GET  /api/admin?action=stats
//   GET  /api/admin?action=leaderboard&q=&limit=&offset=
//   GET  /api/admin?action=players&q=&limit=&offset=
//   GET  /api/admin?action=games&q=&flagged=1&player=<id>&limit=&offset=
//   GET  /api/admin?action=export&type=leaderboard|players|games   (CSV download)
//   POST /api/admin?action=disqualify  { id, value: true|false }
const { q, handler, readJson, send, requireAdmin, httpError } = require('./_lib');

const PLAYER_COLS = `p.id, p.name, p.email, p.phone, p.best_score, p.best_at, p.games_played, p.total_score, p.created_at, p.last_seen_at,
  p.city, p.region, p.country, p.ip_city, p.ip_region, p.lat, p.lng, p.location_accuracy_m, p.location_source, p.disqualified`;

function page(u) {
  const limit = Math.min(500, Math.max(1, parseInt(u.searchParams.get('limit'), 10) || 50));
  const offset = Math.max(0, parseInt(u.searchParams.get('offset'), 10) || 0);
  return { limit, offset };
}
function search(u, alias, params) {
  const s = (u.searchParams.get('q') || '').trim().slice(0, 80);
  if (!s) return '';
  params.push('%' + s.replace(/[%_\\]/g, m => '\\' + m) + '%');
  const i = params.length;
  return ` and (${alias}.name ilike $${i} or ${alias}.email ilike $${i} or ${alias}.phone ilike $${i} or coalesce(${alias}.city, ${alias}.ip_city, '') ilike $${i})`;
}

async function listLeaderboard(u, all) {
  const params = [], where = search(u, 'p', params), { limit, offset } = page(u);
  const lim = all ? '' : ` limit ${limit} offset ${offset}`;
  const rows = await q(`select p.rank, ${PLAYER_COLS} from leaderboard p where true${where} order by p.rank${lim}`, params);
  const [{ n }] = await q(`select count(*)::int n from leaderboard p where true${where}`, params);
  return { rows, total: n };
}
async function listPlayers(u, all) {
  const params = [], where = search(u, 'p', params), { limit, offset } = page(u);
  const lim = all ? '' : ` limit ${limit} offset ${offset}`;
  const rows = await q(`select l.rank, ${PLAYER_COLS} from players p left join leaderboard l on l.id = p.id where true${where} order by p.created_at desc${lim}`, params);
  const [{ n }] = await q(`select count(*)::int n from players p where true${where}`, params);
  return { rows, total: n };
}
async function listGames(u, all) {
  const params = []; let where = search(u, 'p', params);
  if (u.searchParams.get('flagged') === '1') where += ' and g.flagged';
  const pid = u.searchParams.get('player');
  if (pid && /^[0-9a-f-]{36}$/.test(pid)) { params.push(pid); where += ` and g.player_id = $${params.length}`; }
  const { limit, offset } = page(u);
  const lim = all ? '' : ` limit ${limit} offset ${offset}`;
  const rows = await q(`select g.id, g.created_at, g.score, g.client_score, g.duration_s, g.phones_caught, g.flagged, g.flag_reason,
      g.city, g.ip_city, g.lat, g.lng, g.player_id, p.name, p.phone, p.email
    from games g join players p on p.id = g.player_id where true${where} order by g.created_at desc${lim}`, params);
  const [{ n }] = await q(`select count(*)::int n from games g join players p on p.id = g.player_id where true${where}`, params);
  return { rows, total: n };
}

function csv(rows) {
  if (!rows.length) return '';
  const cols = Object.keys(rows[0]);
  const cell = v => {
    if (v == null) return '';
    let s = v instanceof Date ? v.toISOString() : String(v);
    if (/^[=+\-@]/.test(s)) s = "'" + s;                       // stop spreadsheet formula injection
    return /[",\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
  };
  return [cols.join(','), ...rows.map(r => cols.map(c => cell(r[c])).join(','))].join('\n');
}

module.exports = handler(['GET', 'POST'], async (req, res) => {
  requireAdmin(req);
  const u = new URL(req.url, 'http://x');
  const action = u.searchParams.get('action');

  if (req.method === 'POST') {
    if (action !== 'disqualify') throw httpError(400, 'Unknown action');
    const b = await readJson(req, 5_000);
    if (!/^[0-9a-f-]{36}$/.test(String(b.id))) throw httpError(400, 'Missing player id');
    const rows = await q('update players set disqualified = $2 where id = $1 returning id, disqualified', [b.id, b.value === true]);
    if (!rows.length) throw httpError(404, 'Player not found');
    return send(res, 200, rows[0]);
  }

  if (action === 'stats') { const [r] = await q(`select admin_stats('Asia/Kolkata') s`); return send(res, 200, r.s); }
  if (action === 'leaderboard') return send(res, 200, await listLeaderboard(u));
  if (action === 'players') return send(res, 200, await listPlayers(u));
  if (action === 'games') return send(res, 200, await listGames(u));
  if (action === 'export') {
    const type = u.searchParams.get('type');
    const fn = { leaderboard: listLeaderboard, players: listPlayers, games: listGames }[type];
    if (!fn) throw httpError(400, 'Unknown export');
    const { rows } = await fn(u, true);
    const stamp = new Date().toISOString().slice(0, 10);
    res.statusCode = 200;
    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename="santa-safe-catch-${type}-${stamp}.csv"`);
    res.setHeader('Cache-Control', 'no-store');
    return res.end('﻿' + csv(rows));
  }
  throw httpError(400, 'Unknown action');
});
