// GET /api/health  (header x-admin-key) → checks the database settings without revealing secrets
const { handler, send, requireAdmin, q } = require('./_lib');

module.exports = handler(['GET'], async (req, res) => {
  requireAdmin(req);
  const raw = process.env.DATABASE_URL || '';
  const out = { set: !!raw, length: raw.length, quotedOrSpaced: raw !== raw.trim() || /^["']|["']$/.test(raw.trim()) };
  try {
    const u = new URL(raw.trim().replace(/^["']|["']$/g, ''));
    const pw = decodeURIComponent(u.password);
    out.protocol = u.protocol; out.host = u.hostname; out.port = u.port; out.user = decodeURIComponent(u.username); out.database = u.pathname;
    out.passwordLength = pw.length ? (pw.length < 8 ? 'short' : 'ok') : 'empty';
    out.passwordLooksLikePlaceholder = /YOUR|NEWPASSWORD|\[|\]/.test(pw);
    out.passwordHasSymbols = /[^A-Za-z0-9]/.test(pw);
  } catch (e) { out.parseError = 'DATABASE_URL is not a valid URL'; }
  try { const [r] = await q('select current_user as u, (select count(*)::int from players) as players'); out.connected = true; out.dbUser = r.u; out.players = r.players; }
  catch (e) { out.connected = false; out.dbError = e.message; }
  send(res, 200, out);
});
