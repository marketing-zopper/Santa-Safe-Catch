// Email sending + the two email templates.
// Two ways to send (the first one configured wins):
//  A) A company mailbox over SMTP (Google Workspace / Microsoft 365), no DNS changes needed:
//     SMTP_HOST (smtp.gmail.com or smtp.office365.com), SMTP_PORT (465 Google / 587 Microsoft),
//     SMTP_USER (the mailbox, e.g. christmas@zopper.com), SMTP_PASS (its app password)
//  B) Brevo: BREVO_API_KEY
// Env vars:
//   BREVO_API_KEY     Brevo → SMTP & API → API keys
//   EMAIL_FROM        sender address on a verified domain, e.g. christmas@zopper.com
//   EMAIL_FROM_NAME   sender name (default "Zopper Christmas Challenge")
//   GAME_URL          public game link, e.g. https://safe-catch.vercel.app
//   KNOW_MORE_URL     Zopper page about the campaign / protection plans
//   TERMS_URL         contest terms & conditions page
//   CAMPAIGN_END      text shown in emails, e.g. "31 December 2026"
// Without BREVO_API_KEY, and only when EMAIL_DEV_LOG=1, emails are printed to the server log instead (local testing).
const { q } = require('./_lib');

const cfg = () => ({
  key: (process.env.BREVO_API_KEY || '').trim(),
  smtpHost: (process.env.SMTP_HOST || '').trim(),
  smtpPort: parseInt(process.env.SMTP_PORT, 10) || 465,
  smtpUser: (process.env.SMTP_USER || '').trim(),
  smtpPass: (process.env.SMTP_PASS || '').replace(/\s+/g, ''),   // Google shows app passwords with spaces
  from: (process.env.EMAIL_FROM || '').trim(),
  fromName: (process.env.EMAIL_FROM_NAME || 'Zopper Christmas Challenge').trim(),
  gameUrl: (process.env.GAME_URL || 'https://safe-catch.vercel.app').trim(),
  knowMore: (process.env.KNOW_MORE_URL || '').trim(),
  terms: (process.env.TERMS_URL || '').trim(),
  end: (process.env.CAMPAIGN_END || '').trim(),
});
const esc = s => String(s == null ? '' : s).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
const firstName = n => String(n || '').trim().split(/\s+/)[0] || 'there';

let transport;
function smtp(c) {
  if (!transport) {
    const nodemailer = require('nodemailer');
    transport = nodemailer.createTransport({ host: c.smtpHost, port: c.smtpPort, secure: c.smtpPort === 465, requireTLS: c.smtpPort !== 465,
      auth: { user: c.smtpUser, pass: c.smtpPass }, connectionTimeout: 10000, greetingTimeout: 10000, socketTimeout: 15000,
      tls: process.env.SMTP_TLS_INSECURE === '1' ? { rejectUnauthorized: false } : undefined });
  }
  return transport;
}

async function sendEmail({ to, toName, subject, html, text, kind, playerId }) {
  const c = cfg();
  let status = 'sent', providerId = null, error = null;
  try {
    if (c.smtpHost) {
      if (!c.smtpUser || !c.smtpPass) throw new Error('Email service is not set up yet (SMTP_USER / SMTP_PASS missing)');
      const info = await smtp(c).sendMail({ from: { name: c.fromName, address: c.from || c.smtpUser }, to: toName ? { name: toName, address: to } : to, subject, html, text });
      providerId = info.messageId || null;
    } else if (!c.key) {
      if (process.env.EMAIL_DEV_LOG === '1') { status = 'dev'; console.log(`\n[email:${kind}] to ${to}\n${subject}\n${text}\n`); }
      else throw new Error('Email service is not set up yet (BREVO_API_KEY missing)');
    } else {
      if (!c.from) throw new Error('Email service is not set up yet (EMAIL_FROM missing)');
      const r = await fetch('https://api.brevo.com/v3/smtp/email', {
        method: 'POST',
        headers: { 'api-key': c.key, 'Content-Type': 'application/json', Accept: 'application/json' },
        body: JSON.stringify({ sender: { email: c.from, name: c.fromName }, to: [{ email: to, name: toName || undefined }], subject, htmlContent: html, textContent: text, tags: ['santa-safe-catch', kind] }),
      });
      const j = await r.json().catch(() => ({}));
      if (!r.ok) throw new Error(`Brevo ${r.status}: ${j.message || j.code || 'send failed'}`);
      providerId = j.messageId || null;
    }
  } catch (e) { status = 'failed'; error = e.message; }
  try { await q('insert into email_log (player_id, kind, to_email, status, provider_id, error) values ($1,$2,$3,$4,$5,$6)', [playerId || null, kind, to, status, providerId, error]); } catch (e) { console.error('email_log', e.message); }
  if (status === 'failed') { const err = new Error(error); err.emailFailed = true; throw err; }
  return { status, providerId };
}

/* ---------- shared layout (table-based so it renders in Gmail / Outlook) ---------- */
function layout({ preheader, body, footerExtra }) {
  const c = cfg();
  return `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width"><meta name="color-scheme" content="light"><title>Zopper Christmas Challenge</title></head>
<body style="margin:0;padding:0;background:#EEF1FA;">
<span style="display:none!important;opacity:0;color:transparent;max-height:0;overflow:hidden">${esc(preheader)}</span>
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#EEF1FA;padding:24px 12px;"><tr><td align="center">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:520px;background:#FFFFFF;border-radius:20px;overflow:hidden;font-family:'Segoe UI',Roboto,Arial,sans-serif;color:#1D1E3F;">
<tr><td style="background:#1D1E3F;background-image:linear-gradient(160deg,#263E91,#1D1E3F);padding:26px 28px 22px;">
  <div style="font-size:11px;letter-spacing:2px;text-transform:uppercase;color:#00B5EA;font-weight:700;">Zopper Christmas Challenge</div>
  <div style="font-size:30px;line-height:1.05;font-weight:800;color:#FBEB3C;margin-top:8px;">Santa's Safe Catch</div>
</td></tr>
<tr><td style="padding:28px 28px 8px;font-size:16px;line-height:1.55;">${body}</td></tr>
<tr><td style="padding:8px 28px 26px;font-size:12px;line-height:1.5;color:#6B6E96;">
  ${footerExtra || ''}
  <p style="margin:14px 0 0;">Zopper will never ask you for an OTP, password or payment to hand over a prize. If someone does, it isn't us.</p>
  ${c.terms ? `<p style="margin:8px 0 0;"><a href="${esc(c.terms)}" style="color:#263E91;">Contest terms &amp; conditions</a></p>` : ''}
  <p style="margin:8px 0 0;">You're getting this because you signed up for the Zopper Christmas Challenge.</p>
</td></tr>
</table></td></tr></table></body></html>`;
}

function otpEmail({ name, code, purpose }) {
  const c = cfg();
  const action = purpose === 'login' ? 'log back in to' : 'verify your email for';
  const subject = `${code} is your Santa's Safe Catch code`;
  const html = layout({
    preheader: `Your code is ${code}. It expires in 10 minutes.`,
    body: `<p style="margin:0 0 14px;">Hi ${esc(firstName(name))},</p>
<p style="margin:0 0 18px;">Use this code to ${action} Santa's Safe Catch:</p>
<div style="text-align:center;margin:0 0 18px;"><span style="display:inline-block;font-size:34px;letter-spacing:10px;font-weight:800;background:#FFE7C0;border:3px solid #1D1E3F;border-radius:14px;padding:12px 18px 12px 28px;font-family:'Courier New',monospace;">${esc(code)}</span></div>
<p style="margin:0 0 6px;">The code expires in <b>10 minutes</b>.</p>
<p style="margin:0;color:#6B6E96;font-size:14px;">If you didn't ask for this, you can ignore this email.</p>`,
  });
  const text = `Hi ${firstName(name)},\n\nYour Santa's Safe Catch code is ${code}. It expires in 10 minutes.\n\nIf you didn't ask for this, ignore this email.\n\nZopper will never ask you for an OTP, password or payment to hand over a prize.\n${c.gameUrl}`;
  return { subject, html, text };
}

function thanksEmail({ name, score, best, rank, total }) {
  const c = cfg();
  const subject = `Thanks for playing Santa's Safe Catch, ${firstName(name)}!`;
  const rankLine = rank ? `You're currently <b>#${rank}</b> of ${total} players on the leaderboard.` : `Catch a few phones to get onto the leaderboard.`;
  const btn = (href, label, bg, fg) => `<a href="${esc(href)}" style="display:inline-block;background:${bg};color:${fg};text-decoration:none;font-weight:800;font-size:16px;padding:14px 26px;border-radius:14px;border:3px solid #1D1E3F;">${label}</a>`;
  const html = layout({
    preheader: `Your score: ${score}. Play again as many times as you like to climb the leaderboard.`,
    body: `<p style="margin:0 0 14px;">Hi ${esc(firstName(name))},</p>
<p style="margin:0 0 18px;">Thanks for playing <b>Santa's Safe Catch</b>! Here's how your first round went:</p>
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="margin:0 0 18px;background:#FFE7C0;border:3px solid #1D1E3F;border-radius:16px;"><tr>
  <td style="padding:16px 18px;text-align:center;"><div style="font-size:12px;letter-spacing:1.5px;text-transform:uppercase;color:#4A4C78;font-weight:700;">Your score</div><div style="font-size:40px;font-weight:800;line-height:1.1;">${Number(score) || 0}</div></td>
  <td style="padding:16px 18px;text-align:center;border-left:2px dashed #E0B97F;"><div style="font-size:12px;letter-spacing:1.5px;text-transform:uppercase;color:#4A4C78;font-weight:700;">Rank</div><div style="font-size:40px;font-weight:800;line-height:1.1;color:#263E91;">${rank ? '#' + rank : '–'}</div></td>
</tr></table>
<p style="margin:0 0 12px;">${rankLine}</p>
<p style="margin:0 0 8px;"><b>Want to climb higher?</b></p>
<ul style="margin:0 0 18px;padding-left:20px;">
  <li style="margin-bottom:6px;">Play as many times as you like. Only your <b>best score</b> counts.</li>
  <li style="margin-bottom:6px;">The game speeds up the longer you last, and points per phone go up with it.</li>
  <li style="margin-bottom:6px;">Gold phones are worth 4×. Dodge the coal, and grab Zopper shields for an extra life.</li>
</ul>
<p style="margin:0 0 18px;">${c.end ? `The challenge closes on <b>${esc(c.end)}</b>. ` : ''}The top players on the leaderboard when it closes win prizes. We'll contact winners on the email and mobile number they signed up with.</p>
<div style="text-align:center;margin:0 0 20px;">${btn(c.gameUrl, 'Play again', '#ED763B', '#FFFFFF')}</div>
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#1D1E3F;border-radius:16px;"><tr><td style="padding:18px 20px;color:#FFE7C0;font-size:15px;line-height:1.5;">
  <b style="color:#00B5EA;">Real phones crack too.</b> Ask at the store about Zopper's phone protection plans, so one slip doesn't turn into a big repair bill.
  ${c.knowMore ? `<div style="margin-top:12px;"><a href="${esc(c.knowMore)}" style="color:#FBEB3C;font-weight:800;">Know more about Zopper protection →</a></div>` : ''}
</td></tr></table>`,
  });
  const text = `Hi ${firstName(name)},\n\nThanks for playing Santa's Safe Catch! Your score: ${score}. ${rank ? `You're #${rank} of ${total} on the leaderboard.` : ''}\n\nPlay as many times as you like; only your best score counts.${c.end ? ` The challenge closes on ${c.end}.` : ''} Top players win prizes and are contacted on the email and mobile number they signed up with.\n\nPlay again: ${c.gameUrl}\n${c.knowMore ? `Zopper phone protection: ${c.knowMore}\n` : ''}\nZopper will never ask you for an OTP, password or payment to hand over a prize.${c.terms ? `\nTerms: ${c.terms}` : ''}`;
  return { subject, html, text };
}

module.exports = { sendEmail, otpEmail, thanksEmail };
