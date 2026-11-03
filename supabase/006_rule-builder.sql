-- 006_rule_builder.sql
-- Run on: the REMOTE RULESET project (hpvztbvrwhwdybkmaczs) only.
-- When: once, before the rule-builder function is used.
-- Changes the database: YES. Adds columns and two small tables for the
-- automatic rule creation. Does not change or delete any existing data.

-- 1. haiku_candidate_log: what the rule-builder decided for each SMS.
alter table public.haiku_candidate_log
  add column if not exists rule_builder_status     text,
  add column if not exists rule_builder_note       text,
  add column if not exists rule_builder_checked_at timestamptz;

create index if not exists haiku_candidate_log_rule_builder_idx
  on public.haiku_candidate_log (haiku_status, rule_builder_status);

-- 2. parse_rules: which wording an automatic rule was made for, and when
--    its 7-day probation ends (null = not on probation).
alter table public.parse_rules
  add column if not exists source_signature text,
  add column if not exists probation_until  timestamptz;

-- 3. How many times a rule was tried for each wording (stops after 3).
create table if not exists public.rule_builder_attempts (
  template_signature text primary key,
  attempts           integer not null default 0,
  last_error         text,
  last_rule_id       uuid references public.parse_rules(id) on delete set null,
  updated_at         timestamptz not null default now()
);

-- 4. One row per rule-builder run, with what it did.
create table if not exists public.rule_builder_runs (
  id          uuid primary key default gen_random_uuid(),
  status      text not null default 'running'
              check (status in ('running', 'finished', 'failed', 'abandoned')),
  mode        text,
  started_at  timestamptz not null default now(),
  finished_at timestamptz,
  summary     jsonb,
  error       text
);

-- Only one run at a time: a second 'running' row is refused.
create unique index if not exists rule_builder_runs_one_running
  on public.rule_builder_runs ((true)) where status = 'running';

-- Server only: row-level security on, and no policies, so the app can't read them.
alter table public.rule_builder_attempts enable row level security;
alter table public.rule_builder_runs     enable row level security;

-- 5. Start a run, or return null if one is already running.
--    A run stuck for more than 15 minutes is marked abandoned first.
create or replace function public.rule_builder_start_run(p_mode text)
returns uuid
language plpgsql
as $$
declare
  v_id uuid;
begin
  update public.rule_builder_runs
     set status = 'abandoned', finished_at = now(), error = 'did not finish within 15 minutes'
   where status = 'running' and started_at < now() - interval '15 minutes';
  begin
    insert into public.rule_builder_runs (mode) values (p_mode) returning id into v_id;
  exception when unique_violation then
    return null;
  end;
  return v_id;
end;
$$;

revoke all on function public.rule_builder_start_run(text) from public, anon, authenticated;
grant execute on function public.rule_builder_start_run(text) to service_role;

-- ── Checks (run any time) ───────────────────────────────────────────────
-- Last runs and what they did:
--   select status, mode, started_at, summary from rule_builder_runs order by started_at desc limit 5;
-- Rules the rule-builder made:
--   select rule_key, status, probation_until, notes, created_at
--   from parse_rules where created_by = 'rule_builder' order by created_at desc;
-- What was decided for each SMS:
--   select rule_builder_status, count(*) from haiku_candidate_log group by 1 order by 2 desc;
