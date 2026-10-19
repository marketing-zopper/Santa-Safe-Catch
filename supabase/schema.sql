-- Santa's Safe Catch · Supabase schema
-- Run once in Supabase → SQL Editor → New query → paste → Run.
-- All tables are locked (RLS on, no policies, no access for the public anon key). Only the game's
-- Vercel API routes can read or write, using the DATABASE_URL connection string.

create extension if not exists pgcrypto;

-- Players: one row per mobile number
create table if not exists public.players (
  id                  uuid primary key default gen_random_uuid(),
  name                text not null check (char_length(name) between 2 and 60),
  email               text not null check (char_length(email) between 5 and 120),
  phone               text not null unique check (phone ~ '^[6-9][0-9]{9}$'),
  consent_at          timestamptz not null default now(),
  created_at          timestamptz not null default now(),
  last_seen_at        timestamptz not null default now(),
  -- location (GPS if the player allowed it, otherwise approximate from network)
  lat                 double precision,
  lng                 double precision,
  location_accuracy_m real,
  location_source     text check (location_source in ('gps', 'network')),
  city                text,
  region              text,
  country             text,
  ip_city             text,
  ip_region           text,
  ip_country          text,
  user_agent          text,
  -- scores
  best_score          integer not null default 0,
  best_at             timestamptz,
  games_played        integer not null default 0,
  total_score         bigint  not null default 0,
  disqualified        boolean not null default false,
  notes               text
);

-- One row per game started (the server picks the random seed so scores can be re-checked)
create table if not exists public.game_sessions (
  id         uuid primary key default gen_random_uuid(),
  player_id  uuid not null references public.players(id) on delete cascade,
  seed       bigint not null,
  created_at timestamptz not null default now(),
  used_at    timestamptz
);

-- One row per finished game
create table if not exists public.games (
  id            uuid primary key default gen_random_uuid(),
  player_id     uuid not null references public.players(id) on delete cascade,
  session_id    uuid not null unique references public.game_sessions(id) on delete cascade,
  score         integer not null,          -- re-computed by the server from the recorded moves
  client_score  integer,                   -- what the phone reported (for audit)
  duration_s    real,
  phones_caught integer,
  flagged       boolean not null default false,
  flag_reason   text,
  lat           double precision,
  lng           double precision,
  city          text,
  ip_city       text,
  user_agent    text,
  created_at    timestamptz not null default now()
);

create index if not exists players_rank_idx   on public.players (best_score desc, best_at asc);
create index if not exists players_created_idx on public.players (created_at desc);
create index if not exists games_player_idx   on public.games (player_id);
create index if not exists games_created_idx  on public.games (created_at desc);
create index if not exists sessions_player_idx on public.game_sessions (player_id);

alter table public.players       enable row level security;
alter table public.game_sessions enable row level security;
alter table public.games         enable row level security;
revoke all on public.players, public.game_sessions, public.games from anon, authenticated;

-- Leaderboard (ties: whoever reached the score first ranks higher)
create or replace view public.leaderboard with (security_invoker = true) as
  select row_number() over (order by best_score desc, best_at asc) as rank, p.*
  from public.players p
  where best_score > 0 and not disqualified;
revoke all on public.leaderboard from anon, authenticated;

-- Player's current best, rank and total ranked players
create or replace function public.player_standing(p_player uuid)
returns table (out_best integer, out_rank bigint, out_total bigint)
language sql stable security definer set search_path = public as $$
  with ranked as (
    select id, row_number() over (order by best_score desc, best_at asc) as rk
    from players where best_score > 0 and not disqualified
  )
  select p.best_score, ranked.rk, (select count(*) from ranked)
  from players p left join ranked on ranked.id = p.id
  where p.id = p_player;
$$;

-- Save a finished game atomically: burn the session, store the game, update the player's best
create or replace function public.record_game(
  p_player uuid, p_session uuid, p_score integer, p_client_score integer,
  p_duration real, p_caught integer, p_flagged boolean, p_flag_reason text,
  p_lat double precision, p_lng double precision, p_city text, p_ip_city text, p_ua text)
returns table (out_best integer, out_rank bigint, out_total bigint)
language plpgsql security definer set search_path = public as $$
begin
  update game_sessions set used_at = now()
   where id = p_session and player_id = p_player and used_at is null;
  if not found then raise exception 'session_used_or_missing'; end if;

  insert into games (player_id, session_id, score, client_score, duration_s, phones_caught,
                     flagged, flag_reason, lat, lng, city, ip_city, user_agent)
  values (p_player, p_session, p_score, p_client_score, p_duration, p_caught,
          p_flagged, p_flag_reason, p_lat, p_lng, p_city, p_ip_city, p_ua);

  update players set
    games_played = games_played + 1,
    total_score  = total_score + p_score,
    last_seen_at = now(),
    best_at      = case when not p_flagged and p_score > best_score then now() else best_at end,
    best_score   = case when not p_flagged then greatest(best_score, p_score) else best_score end
  where id = p_player;

  return query select * from player_standing(p_player);
end $$;

-- Numbers for the admin dashboard
create or replace function public.admin_stats(p_tz text default 'Asia/Kolkata')
returns jsonb language sql stable security definer set search_path = public as $$
  select jsonb_build_object(
    'players',        (select count(*) from players),
    'players_today',  (select count(*) from players where (created_at at time zone p_tz)::date = (now() at time zone p_tz)::date),
    'games',          (select count(*) from games),
    'games_today',    (select count(*) from games where (created_at at time zone p_tz)::date = (now() at time zone p_tz)::date),
    'top_score',      (select coalesce(max(best_score), 0) from players where not disqualified),
    'avg_score',      (select coalesce(round(avg(score)), 0) from games where not flagged),
    'flagged_games',  (select count(*) from games where flagged),
    'located_gps',    (select count(*) from players where location_source = 'gps'),
    'by_city',        (select coalesce(jsonb_agg(c order by c->>'players' desc), '[]'::jsonb) from (
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
revoke all on function public.record_game(uuid, uuid, integer, integer, real, integer, boolean, text, double precision, double precision, text, text, text) from public, anon, authenticated;
revoke all on function public.admin_stats(text) from public, anon, authenticated;
grant execute on function public.player_standing(uuid) to service_role;
grant execute on function public.record_game(uuid, uuid, integer, integer, real, integer, boolean, text, double precision, double precision, text, text, text) to service_role;
grant execute on function public.admin_stats(text) to service_role;
grant select, insert, update, delete on public.players, public.game_sessions, public.games to service_role;
grant select on public.leaderboard to service_role;
