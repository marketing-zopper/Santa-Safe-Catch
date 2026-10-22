-- Santa's Safe Catch · migration 002: email OTP verification + email log
-- Run once in Supabase → SQL Editor after schema.sql. Safe to run again.

alter table public.players add column if not exists verified_at         timestamptz;
alter table public.players add column if not exists first_email_sent_at timestamptz;

-- one player per email (case-insensitive) — needed for "log in with email OTP"
create unique index if not exists players_email_lower_key on public.players (lower(email));

-- One-time codes sent by email
create table if not exists public.otp_codes (
  id          uuid primary key default gen_random_uuid(),
  email       text not null,
  purpose     text not null check (purpose in ('signup', 'login')),
  code_hash   text not null,
  payload     jsonb,                       -- sign-up details, saved only once the code is verified
  attempts    integer not null default 0,
  ip          text,
  created_at  timestamptz not null default now(),
  expires_at  timestamptz not null,
  used_at     timestamptz
);
create index if not exists otp_email_idx   on public.otp_codes (lower(email), created_at desc);
create index if not exists otp_ip_idx      on public.otp_codes (ip, created_at desc);

-- Every email the game sends
create table if not exists public.email_log (
  id          uuid primary key default gen_random_uuid(),
  player_id   uuid references public.players(id) on delete set null,
  kind        text not null,               -- 'otp' | 'thanks'
  to_email    text not null,
  status      text not null,               -- 'sent' | 'failed' | 'dev'
  provider_id text,
  error       text,
  created_at  timestamptz not null default now()
);
create index if not exists email_log_created_idx on public.email_log (created_at desc);

alter table public.otp_codes enable row level security;
alter table public.email_log enable row level security;
revoke all on public.otp_codes, public.email_log from anon, authenticated;

-- Only verified players are ranked
drop view if exists public.leaderboard;
create view public.leaderboard with (security_invoker = true) as
  select row_number() over (order by best_score desc, best_at asc) as rank, p.*
  from public.players p
  where best_score > 0 and not disqualified and verified_at is not null;
revoke all on public.leaderboard from anon, authenticated;

create or replace function public.player_standing(p_player uuid)
returns table (out_best integer, out_rank bigint, out_total bigint)
language sql stable security definer set search_path = public as $$
  with ranked as (
    select id, row_number() over (order by best_score desc, best_at asc) as rk
    from players where best_score > 0 and not disqualified and verified_at is not null
  )
  select p.best_score, ranked.rk, (select count(*) from ranked)
  from players p left join ranked on ranked.id = p.id
  where p.id = p_player;
$$;

create or replace function public.admin_stats(p_tz text default 'Asia/Kolkata')
returns jsonb language sql stable security definer set search_path = public as $$
  select jsonb_build_object(
    'players',        (select count(*) from players),
    'verified',       (select count(*) from players where verified_at is not null),
    'players_today',  (select count(*) from players where (created_at at time zone p_tz)::date = (now() at time zone p_tz)::date),
    'games',          (select count(*) from games),
    'games_today',    (select count(*) from games where (created_at at time zone p_tz)::date = (now() at time zone p_tz)::date),
    'top_score',      (select coalesce(max(best_score), 0) from players where not disqualified and verified_at is not null),
    'avg_score',      (select coalesce(round(avg(score)), 0) from games where not flagged),
    'flagged_games',  (select count(*) from games where flagged),
    'located_gps',    (select count(*) from players where location_source = 'gps'),
    'emails_sent',    (select count(*) from email_log where status = 'sent'),
    'emails_failed',  (select count(*) from email_log where status = 'failed'),
    'thanks_sent',    (select count(*) from players where first_email_sent_at is not null),
    'by_city',        (select coalesce(jsonb_agg(c order by (c->>'players')::int desc), '[]'::jsonb) from (
                         select jsonb_build_object('city', coalesce(city, ip_city, 'Unknown'), 'players', count(*)::int, 'top', max(best_score)) as c
                         from players group by coalesce(city, ip_city, 'Unknown') order by count(*) desc limit 15) x),
    'by_day',         (select coalesce(jsonb_agg(d order by d->>'day'), '[]'::jsonb) from (
                         select jsonb_build_object('day', day, 'players', coalesce(pc, 0), 'games', coalesce(gc, 0)) as d from (
                           select gs::date as day,
                             (select count(*) from players where (created_at at time zone p_tz)::date = gs::date) as pc,
                             (select count(*) from games   where (created_at at time zone p_tz)::date = gs::date) as gc
                           from generate_series((now() at time zone p_tz)::date - 29, (now() at time zone p_tz)::date, interval '1 day') gs) z) y)
  );
$$;

revoke all on function public.player_standing(uuid) from public, anon, authenticated;
revoke all on function public.admin_stats(text) from public, anon, authenticated;
grant select on public.leaderboard to service_role;
grant select, insert, update, delete on public.otp_codes, public.email_log to service_role;
