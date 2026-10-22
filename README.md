# Santa's Safe Catch · Zopper Christmas

Mobile browser game for Zopper stores: swipe to move Santa and catch falling phones in his sack.
Players sign up with name, email and mobile number; every game is saved and ranked on a leaderboard.
The top players when the campaign ends win prizes.

## What's in the repo
| Path | What it is |
|---|---|
| `index.html` | The game (single file; the game engine is inlined) |
| `engine.js` | The game rules. Also used by the server to re-check every score |
| `admin.html` | Admin dashboard at `/admin` (players, scores, locations, CSV export) |
| `api/` | Vercel serverless functions: `register`, `start`, `finish`, `leaderboard`, `admin` |
| `supabase/schema.sql` | Database tables and functions. Run once in Supabase |
| `vercel.json` | Hosting settings |

## One-time setup (about 10 minutes)
1. **Create the database.** Go to supabase.com → New project (region: Mumbai `ap-south-1`). Save the database password.
2. **Create the tables.** Supabase → SQL Editor → New query → paste all of `supabase/schema.sql` → Run. Then do the same with `supabase/002_otp_email.sql` (email OTP, email log, verified-only leaderboard).
3. **Copy the connection string.** Supabase → Connect (top bar) → *Transaction pooler* → copy the URI
   (it looks like `postgresql://postgres.xxxx:[YOUR-PASSWORD]@aws-0-ap-south-1.pooler.supabase.com:6543/postgres`)
   and put your database password in place of `[YOUR-PASSWORD]`.
4. **Add environment variables in Vercel** → Project → Settings → Environment Variables (Production):
   - `DATABASE_URL` = the connection string from step 3
   - `TOKEN_SECRET` = any long random text (at least 32 characters). Keep it secret and don't change it during the campaign
   - `ADMIN_PASSWORD` = the password for `/admin`
   - `ADMIN_PASSWORD_REQUIRED` = `1` to switch the admin password on (it is off while testing)
   - Emails (pick one):
     - Company mailbox, no DNS changes: `SMTP_HOST` (`smtp.gmail.com` for Google Workspace, `smtp.office365.com` for Microsoft 365), `SMTP_PORT` (`465` Google, `587` Microsoft), `SMTP_USER` (the mailbox), `SMTP_PASS` (its app password)
     - Or Brevo: `BREVO_API_KEY` (needs DNS records on the sender's domain)
   - `EMAIL_FROM` = sender address (with SMTP, leave empty to use the mailbox itself)
   - `EMAIL_FROM_NAME` = `Zopper Christmas Challenge` (optional)
   - `GAME_URL` = the public game link, used in the email "Play again" button
   - `KNOW_MORE_URL`, `TERMS_URL`, `CAMPAIGN_END` = links and closing date used in the emails
5. **Redeploy** (Vercel → Deployments → ⋯ → Redeploy). Open the game, sign up, play one round, then check `/admin`.

## How scores are protected
- The server picks each game's random seed (`/api/start`). The phone records Santa's moves and sends them at the end (`/api/finish`).
- The server re-plays the whole game with the same rules (`engine.js`) and saves **its own** score, not the number the phone reports.
- A game that claims to have been played faster than real time is **flagged** and doesn't count towards the leaderboard.
  Flagged games show up in the admin Games tab. You can disqualify any player from the dashboard.
- Each game can only be saved once. All tables are closed to the public. Only the API (with `DATABASE_URL`) can read or write them.
- Before giving out prizes, call the top players to confirm their numbers.
  The admin dashboard shows each winner's games, times and locations.

## Location
After sign-up the phone asks to share its location. If the player allows it, we store GPS coordinates and the city.
If they decline, we store the approximate city from their network (Vercel IP lookup). The dashboard marks which one each player has.

## Privacy
The sign-up form asks for explicit consent to store name, email, mobile, scores and location for the contest.
Export or delete the data when the campaign is over (Supabase → Table Editor, or the CSV export in `/admin`).

## Player journey
1. Scan QR → loading screen → intro page (how it works, prizes, Know more, Continue).
2. Sign-up (name, email, mobile, consent) → 6-digit code emailed → verify → game home. Returning players on the same phone go straight to the home screen.
3. New phone? "Log in" with the email they signed up with → code → their scores come back.
4. After their first finished game, players get a thank-you email with their score and rank.
Campaign text (prizes, dates, Know more / T&C links) is in the `CAMPAIGN` block near the top of the game script in `index.html`.

## Email OTP rules
Codes are 6 digits, valid 10 minutes, stored hashed. One code per email every 30 seconds, max 6 per hour per email and 30 per hour per network. 5 wrong tries cancels a code.
