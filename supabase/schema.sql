-- ─────────────────────────────────────────────────────────────────────────────
-- AIATWORK Solar Resolution Dialer — Supabase schema
--
-- Run this in the Supabase SQL editor (or `supabase db push`). It creates the
-- account-scoped tables behind the power dialer and locks them down with
-- row-level security so every account only ever sees its own data.
-- Safe to re-run (idempotent).
-- ─────────────────────────────────────────────────────────────────────────────

create extension if not exists "pgcrypto";

-- ── Profiles (1:1 with auth.users) ───────────────────────────────────────────
create table if not exists public.profiles (
  id          uuid primary key references auth.users (id) on delete cascade,
  full_name   text,
  team        text default 'AIATWORK',
  role        text default 'manager',
  avatar_color text default '#3B82F6',
  created_at  timestamptz not null default now()
);

-- Auto-create a profile row whenever a new auth user signs up.
create or replace function public.handle_new_user()
returns trigger language plpgsql security definer set search_path = public as $$
begin
  insert into public.profiles (id, full_name)
  values (new.id, coalesce(new.raw_user_meta_data ->> 'full_name', split_part(new.email, '@', 1)))
  on conflict (id) do nothing;
  return new;
end;
$$;

drop trigger if exists on_auth_user_created on auth.users;
create trigger on_auth_user_created
  after insert on auth.users
  for each row execute function public.handle_new_user();

-- ── Leads ────────────────────────────────────────────────────────────────────
create table if not exists public.leads (
  id               uuid primary key default gen_random_uuid(),
  owner_id         uuid not null references auth.users (id) on delete cascade,
  first_name       text not null default '',
  last_name        text not null default '',
  phone            text not null default '',
  email            text,
  address          text default '',
  city             text default '',
  state            text default '',
  zip              text default '',
  utility_provider text default '',
  solar_provider   text default '',
  status           text not null default 'new',
  campaign_id      text,
  assigned_rep_id  text,
  solar_payment    numeric,
  utility_bill     numeric,
  has_ev           boolean not null default false,
  has_pool         boolean not null default false,
  has_battery      boolean not null default false,
  multiple_systems boolean not null default false,
  notes            text,
  ai_score         int,
  timezone         text default 'America/Los_Angeles',
  last_contacted_at timestamptz,
  created_at       timestamptz not null default now()
);
create index if not exists leads_owner_idx on public.leads (owner_id);
create index if not exists leads_owner_status_idx on public.leads (owner_id, status);

-- ── Call records ─────────────────────────────────────────────────────────────
create table if not exists public.call_records (
  id              uuid primary key default gen_random_uuid(),
  owner_id        uuid not null references auth.users (id) on delete cascade,
  lead_id         uuid references public.leads (id) on delete set null,
  lead_name       text default '',
  phone           text default '',
  duration_sec    int not null default 0,
  outcome         text,
  disposition     text,
  channel         text not null default 'human', -- 'human' | 'ai'
  conversation_id text,                            -- ElevenLabs conversation id
  recording_url   text,
  summary         text,
  sentiment       text,
  started_at      timestamptz not null default now()
);
create index if not exists call_records_owner_idx on public.call_records (owner_id, started_at desc);

-- ── Appointments ─────────────────────────────────────────────────────────────
create table if not exists public.appointments (
  id            uuid primary key default gen_random_uuid(),
  owner_id      uuid not null references auth.users (id) on delete cascade,
  lead_id       uuid references public.leads (id) on delete set null,
  lead_name     text default '',
  scheduled_at  timestamptz,
  scheduled_label text,                -- e.g. "Tomorrow 2:00pm" when no exact ts
  status        text not null default 'scheduled',
  notes         text,
  source        text not null default 'ai', -- 'ai' | 'rep'
  created_at    timestamptz not null default now()
);
create index if not exists appointments_owner_idx on public.appointments (owner_id, created_at desc);

-- ── Callbacks ────────────────────────────────────────────────────────────────
create table if not exists public.callbacks (
  id          uuid primary key default gen_random_uuid(),
  owner_id    uuid not null references auth.users (id) on delete cascade,
  lead_id     uuid references public.leads (id) on delete set null,
  lead_name   text default '',
  phone       text default '',
  due_at      timestamptz,
  reason      text,
  status      text not null default 'due',
  created_at  timestamptz not null default now()
);
create index if not exists callbacks_owner_idx on public.callbacks (owner_id, due_at);

-- ── AI conversations (ElevenLabs) ────────────────────────────────────────────
create table if not exists public.ai_conversations (
  conversation_id text primary key,
  owner_id        uuid references auth.users (id) on delete cascade,
  lead_id         uuid references public.leads (id) on delete set null,
  lead_name       text default '',
  phone           text default '',
  call_sid        text,
  state           text not null default 'initiated',
  sentiment       text default 'neutral',
  outcome         text,
  summary         text,
  duration_sec    int,
  appointment     jsonb,
  started_at      timestamptz not null default now(),
  ended_at        timestamptz
);
create index if not exists ai_conversations_owner_idx on public.ai_conversations (owner_id, started_at desc);

-- ── Row-level security ───────────────────────────────────────────────────────
alter table public.profiles         enable row level security;
alter table public.leads            enable row level security;
alter table public.call_records     enable row level security;
alter table public.appointments     enable row level security;
alter table public.callbacks        enable row level security;
alter table public.ai_conversations enable row level security;

-- Profiles: a user can read/update only their own profile.
drop policy if exists "profiles self" on public.profiles;
create policy "profiles self" on public.profiles
  for all using (auth.uid() = id) with check (auth.uid() = id);

-- Helper: one owner_id policy per data table.
drop policy if exists "leads owner" on public.leads;
create policy "leads owner" on public.leads
  for all using (auth.uid() = owner_id) with check (auth.uid() = owner_id);

drop policy if exists "call_records owner" on public.call_records;
create policy "call_records owner" on public.call_records
  for all using (auth.uid() = owner_id) with check (auth.uid() = owner_id);

drop policy if exists "appointments owner" on public.appointments;
create policy "appointments owner" on public.appointments
  for all using (auth.uid() = owner_id) with check (auth.uid() = owner_id);

drop policy if exists "callbacks owner" on public.callbacks;
create policy "callbacks owner" on public.callbacks
  for all using (auth.uid() = owner_id) with check (auth.uid() = owner_id);

drop policy if exists "ai_conversations owner" on public.ai_conversations;
create policy "ai_conversations owner" on public.ai_conversations
  for all using (auth.uid() = owner_id) with check (auth.uid() = owner_id);

-- ── Campaigns ────────────────────────────────────────────────────────────────
create table if not exists public.campaigns (
  id               uuid primary key default gen_random_uuid(),
  owner_id         uuid not null references auth.users (id) on delete cascade,
  name             text not null,
  utility_provider text default '',
  status           text not null default 'active', -- active | paused | completed
  color            text default '#3B82F6',
  created_at       timestamptz not null default now()
);
create index if not exists campaigns_owner_idx on public.campaigns (owner_id, created_at desc);

alter table public.campaigns enable row level security;
drop policy if exists "campaigns owner" on public.campaigns;
create policy "campaigns owner" on public.campaigns
  for all using (auth.uid() = owner_id) with check (auth.uid() = owner_id);

-- ── Team members (User Management — roster, roles, access & permissions) ──────
create table if not exists public.team_members (
  id           uuid primary key default gen_random_uuid(),
  owner_id     uuid not null references auth.users (id) on delete cascade,
  email        text not null,
  name         text default '',
  role         text not null default 'rep',       -- admin | manager | rep
  access_level text not null default 'standard',  -- full | standard | limited
  permissions  jsonb not null default '{}'::jsonb,
  status       text not null default 'invited',   -- invited | active | disabled
  created_at   timestamptz not null default now()
);
create index if not exists team_members_owner_idx on public.team_members (owner_id, created_at desc);

alter table public.team_members enable row level security;
drop policy if exists "team_members owner" on public.team_members;
create policy "team_members owner" on public.team_members
  for all using (auth.uid() = owner_id) with check (auth.uid() = owner_id);

-- ── Superadmin: account suspension + app-wide controls ───────────────────────
-- A disabled account is blocked from the app shell by the (app) layout.
alter table public.profiles add column if not exists disabled boolean not null default false;

-- Global app settings (maintenance / kill switch). Single 'global' row. RLS on
-- with no policies → only the service-role (superadmin) client can touch it.
create table if not exists public.app_settings (
  id          text primary key default 'global',
  maintenance boolean not null default false,
  message     text default '',
  updated_at  timestamptz not null default now()
);
alter table public.app_settings enable row level security;
insert into public.app_settings (id) values ('global') on conflict (id) do nothing;

-- ── Organizations & companies (multi-tenant) ─────────────────────────────────
-- The dialer is a general product; each organization is one specialization
-- (this instance ships under "Sunrun"). Organizations contain companies and
-- members (accounts). Managed from the superadmin console.
create table if not exists public.organizations (
  id         uuid primary key default gen_random_uuid(),
  name       text not null,
  slug       text unique,
  industry   text default '',
  status     text not null default 'active',  -- active | suspended
  created_at timestamptz not null default now()
);

create table if not exists public.companies (
  id         uuid primary key default gen_random_uuid(),
  org_id     uuid not null references public.organizations (id) on delete cascade,
  name       text not null,
  created_at timestamptz not null default now()
);
create index if not exists companies_org_idx on public.companies (org_id);

-- Each account belongs to an organization (and optionally a company within it).
alter table public.profiles add column if not exists org_id uuid references public.organizations (id) on delete set null;
alter table public.profiles add column if not exists company_id uuid references public.companies (id) on delete set null;

-- Any signed-in user may READ orgs/companies (to show their org); all WRITES are
-- service-role only (the superadmin console).
alter table public.organizations enable row level security;
drop policy if exists "orgs read" on public.organizations;
create policy "orgs read" on public.organizations for select using (auth.uid() is not null);

alter table public.companies enable row level security;
drop policy if exists "companies read" on public.companies;
create policy "companies read" on public.companies for select using (auth.uid() is not null);

-- Seed the Sunrun organization for this instance + assign existing accounts.
insert into public.organizations (name, slug, industry)
  values ('Sunrun', 'sunrun', 'Residential Solar')
  on conflict (slug) do nothing;
update public.profiles
  set org_id = (select id from public.organizations where slug = 'sunrun')
  where org_id is null;

-- ── Organization customization, membership & approvals ───────────────────────
-- The dialer is a general AI auto-dialer; each organization specializes it.
-- These columns + the settings JSONB make an org deeply customizable by its
-- managers, and organization_members drives join-codes, roles & approvals.
alter table public.organizations add column if not exists join_code       text;
alter table public.organizations add column if not exists require_approval boolean not null default true;
alter table public.organizations add column if not exists allow_join      boolean not null default true;
alter table public.organizations add column if not exists description     text default '';
alter table public.organizations add column if not exists product_name    text default '';
alter table public.organizations add column if not exists tagline         text default '';
alter table public.organizations add column if not exists website         text default '';
alter table public.organizations add column if not exists logo_url        text default '';
alter table public.organizations add column if not exists brand_color     text default '';
alter table public.organizations add column if not exists accent_color    text default '';
alter table public.organizations add column if not exists timezone        text default 'America/Los_Angeles';
alter table public.organizations add column if not exists dialer_template text not null default 'general';
alter table public.organizations add column if not exists default_role    text not null default 'rep';
alter table public.organizations add column if not exists owner_id        uuid references auth.users (id) on delete set null;
alter table public.organizations add column if not exists settings        jsonb not null default '{}'::jsonb;

create unique index if not exists organizations_join_code_idx
  on public.organizations (join_code) where join_code is not null;

-- Give every existing org a join code, and specialize Sunrun for solar.
update public.organizations
  set join_code = upper(substr(md5(random()::text || id::text), 1, 7))
  where join_code is null;
update public.organizations set
  dialer_template = 'solar',
  product_name = coalesce(nullif(product_name, ''), 'Sunrun Resolution Dialer'),
  tagline      = coalesce(nullif(tagline, ''), 'AI-powered solar resolution calling')
  where slug = 'sunrun';

-- ── UNRG: AI-only workspace behind the platform paywall ──────────────────────
-- A white-label organization with manual (human) browser dialing turned OFF and
-- access gated behind the superadmin-controlled paywall until it's marked paid.
-- Only partial settings are stored; mergeSettings() fills the rest from defaults,
-- so AI calling and live listening stay enabled. The price + unlock are managed
-- from the superadmin console (App Control → the org's Billing section).
insert into public.organizations
    (name, slug, industry, dialer_template, product_name, tagline, settings)
  values (
    'UNRG', 'unrg', 'AI Sales', 'general',
    'UNRG Dialer', 'AI-powered outbound calling',
    jsonb_build_object(
      'features', jsonb_build_object('manualDialer', false),
      'billing',  jsonb_build_object(
        'paywall',  true,
        'active',   false,
        'price',    0,
        'currency', 'USD',
        'interval', 'month',
        'note',     ''
      )
    )
  )
  on conflict (slug) do nothing;
update public.organizations
  set join_code = upper(substr(md5(random()::text || id::text), 1, 7))
  where slug = 'unrg' and join_code is null;

-- ── Donny: both dialers on ───────────────────────────────────────────────────
-- Human (browser) dialing AND AI calling are both enabled for this workspace.
-- (It previously shipped with `features.aiDialer` off, as a manual-only + AI-
-- paywall demo; AI has since been unlocked for it.) The INSERT below only ever
-- touches a FRESH database — `on conflict do nothing` leaves an existing Donny
-- org exactly as it is, so unlocking AI on a live org is a separate settings
-- change (Superadmin console, or an UPDATE on organizations.settings), not this.
insert into public.organizations
    (name, slug, industry, dialer_template, product_name, tagline, settings)
  values (
    'Donny', 'donny', 'Sales', 'general',
    'Donny Dialer', 'Manual outbound calling',
    jsonb_build_object(
      'features', jsonb_build_object('aiDialer', true, 'manualDialer', true)
    )
  )
  on conflict (slug) do nothing;
update public.organizations
  set join_code = upper(substr(md5(random()::text || id::text), 1, 7))
  where slug = 'donny' and join_code is null;

-- Unlock AI calling for an EXISTING Donny org (the insert above never updates
-- one). Idempotent, and preserves every other setting — only features.aiDialer
-- is flipped on. Safe to re-run.
update public.organizations
  set settings = coalesce(settings, '{}'::jsonb)
    || jsonb_build_object(
         'features',
         coalesce(settings -> 'features', '{}'::jsonb) || '{"aiDialer": true}'::jsonb
       )
  where slug = 'donny'
    and coalesce((settings #>> '{features,aiDialer}')::boolean, false) is not true;

-- Membership = who is in an org, their role, their approval status, and any
-- per-member permission overrides. One active membership per user per org.
create table if not exists public.organization_members (
  id           uuid primary key default gen_random_uuid(),
  org_id       uuid not null references public.organizations (id) on delete cascade,
  user_id      uuid not null references auth.users (id) on delete cascade,
  email        text default '',
  name         text default '',
  role         text not null default 'rep',      -- owner | admin | manager | rep
  permissions  jsonb not null default '{}'::jsonb, -- granular per-member overrides
  status       text not null default 'pending',  -- pending | active | rejected | removed
  requested_at timestamptz not null default now(),
  decided_at   timestamptz,
  decided_by   uuid references auth.users (id) on delete set null,
  created_at   timestamptz not null default now(),
  unique (org_id, user_id)
);
create index if not exists org_members_org_idx  on public.organization_members (org_id, status);
create index if not exists org_members_user_idx on public.organization_members (user_id);

-- A user may read only their own membership rows; all cross-member reads and all
-- writes (approvals, role changes) go through the service-role server engine,
-- which enforces the role hierarchy in application code.
alter table public.organization_members enable row level security;
drop policy if exists "org_members self read" on public.organization_members;
create policy "org_members self read" on public.organization_members
  for select using (auth.uid() = user_id);

-- Backfill: everyone already assigned to an org becomes an active member with
-- their current profile role; the earliest member of each org becomes its owner.
insert into public.organization_members (org_id, user_id, name, role, status, decided_at)
  select p.org_id, p.id, coalesce(p.full_name, ''),
         coalesce(nullif(p.role, ''), 'manager'), 'active', now()
  from public.profiles p
  where p.org_id is not null
  on conflict (org_id, user_id) do nothing;

update public.organization_members m set role = 'owner', decided_at = now()
  where m.id in (
    select distinct on (o.id) mm.id
    from public.organizations o
    join public.organization_members mm on mm.org_id = o.id and mm.status = 'active'
    order by o.id, mm.created_at asc
  );

update public.organizations o set owner_id = (
    select m.user_id from public.organization_members m
    where m.org_id = o.id and m.role = 'owner' order by m.created_at asc limit 1
  ) where o.owner_id is null;

-- Keep the denormalized profile role in sync with the owner backfill.
update public.profiles p set role = 'owner'
  from public.organization_members m
  where m.user_id = p.id and m.role = 'owner' and m.status = 'active';

-- ═════════════════════════════════════════════════════════════════════════════
-- PART 2 — SECURITY & HIERARCHY UPGRADE  (idempotent; safe to re-run)
--
-- • Hidden platform superadmin tied to your real account (no separate password).
-- • Account suspension enforced at the database, not just in app code.
-- • Org-level data isolation: supervisors (manager/admin/owner) see their org's
--   leads/calls/etc.; reps see only their own. Enforced by RLS, not just the UI.
-- • Self privilege-escalation is blocked (users can't grant themselves a role,
--   un-suspend themselves, or move orgs without a validated server path).
-- • Audit log for sensitive actions.
-- ═════════════════════════════════════════════════════════════════════════════

-- ── Profile additions ────────────────────────────────────────────────────────
alter table public.profiles add column if not exists preferences jsonb not null default '{}'::jsonb;

-- ── Hidden platform superadmins ──────────────────────────────────────────────
-- Service-role-only table (RLS on, no policies) so a user can NEVER grant
-- themselves platform access. Membership here = superadmin (in addition to the
-- SUPERADMIN_EMAILS env allowlist, which is the un-lock-out-able bootstrap).
create table if not exists public.platform_admins (
  user_id    uuid primary key references auth.users (id) on delete cascade,
  note       text default '',
  created_at timestamptz not null default now()
);
alter table public.platform_admins enable row level security;

-- ── Audit log (service-role only) ────────────────────────────────────────────
create table if not exists public.audit_log (
  id          uuid primary key default gen_random_uuid(),
  actor_id    uuid,
  actor_kind  text not null default 'user',   -- user | superadmin | system
  action      text not null,
  target_id   text,
  target_kind text,
  org_id      uuid,
  detail      jsonb not null default '{}'::jsonb,
  created_at  timestamptz not null default now()
);
create index if not exists audit_log_created_idx on public.audit_log (created_at desc);
alter table public.audit_log enable row level security;

-- ── Org scoping on all account data ──────────────────────────────────────────
alter table public.leads            add column if not exists org_id uuid references public.organizations (id) on delete set null;
alter table public.call_records     add column if not exists org_id uuid references public.organizations (id) on delete set null;
alter table public.appointments     add column if not exists org_id uuid references public.organizations (id) on delete set null;
alter table public.callbacks        add column if not exists org_id uuid references public.organizations (id) on delete set null;
alter table public.ai_conversations add column if not exists org_id uuid references public.organizations (id) on delete set null;
alter table public.campaigns        add column if not exists org_id uuid references public.organizations (id) on delete set null;

create index if not exists leads_org_idx            on public.leads (org_id);
-- The supervisor dial-queue (org_id + status IN dialable, ordered by ai_score) and
-- the bills-fine scan (org_id + status = 'bills_fine') both filter org_id AND status;
-- a composite lets Postgres range-scan instead of filtering status in-heap after the
-- org_id index. ai_score in the index also serves the dial-queue's ORDER BY.
create index if not exists leads_org_status_idx      on public.leads (org_id, status, ai_score desc);
create index if not exists call_records_org_idx     on public.call_records (org_id, started_at desc);
create index if not exists appointments_org_idx     on public.appointments (org_id, created_at desc);
create index if not exists callbacks_org_idx        on public.callbacks (org_id);
create index if not exists ai_conversations_org_idx on public.ai_conversations (org_id, started_at desc);
create index if not exists campaigns_org_idx        on public.campaigns (org_id);

-- Performance indexes (also shipped standalone in supabase/perf-indexes.sql).
-- Serve the ai_score-ordered lead lists (dialer queue / leads screen) so they
-- index-scan instead of sorting, and cover the high-traffic lead_id foreign keys.
create index if not exists leads_owner_ai_score_idx    on public.leads (owner_id, ai_score desc nulls last);
create index if not exists leads_org_ai_score_idx      on public.leads (org_id, ai_score desc nulls last);
create index if not exists call_records_lead_id_idx    on public.call_records (lead_id);
create index if not exists ai_conversations_lead_id_idx on public.ai_conversations (lead_id);
create index if not exists callbacks_lead_id_idx       on public.callbacks (lead_id);
create index if not exists appointments_lead_id_idx    on public.appointments (lead_id);

-- Backfill org_id from each row's owner profile.
update public.leads            t set org_id = p.org_id from public.profiles p where p.id = t.owner_id and t.org_id is null;
update public.call_records     t set org_id = p.org_id from public.profiles p where p.id = t.owner_id and t.org_id is null;
update public.appointments     t set org_id = p.org_id from public.profiles p where p.id = t.owner_id and t.org_id is null;
update public.callbacks        t set org_id = p.org_id from public.profiles p where p.id = t.owner_id and t.org_id is null;
update public.ai_conversations t set org_id = p.org_id from public.profiles p where p.id = t.owner_id and t.org_id is null;
update public.campaigns        t set org_id = p.org_id from public.profiles p where p.id = t.owner_id and t.org_id is null;

-- ── Security-definer helpers (bypass RLS to evaluate the checks) ─────────────
create or replace function public.app_is_active()
returns boolean language sql stable security definer set search_path = public as $$
  select not coalesce((select disabled from public.profiles where id = auth.uid()), false);
$$;

create or replace function public.app_is_superadmin()
returns boolean language sql stable security definer set search_path = public as $$
  select exists (select 1 from public.platform_admins where user_id = auth.uid());
$$;

-- Is the caller an ACTIVE manager/admin/owner of the given org?
create or replace function public.app_is_org_supervisor(target_org uuid)
returns boolean language sql stable security definer set search_path = public as $$
  select exists (
    select 1 from public.organization_members m
    where m.user_id = auth.uid()
      and m.org_id = target_org
      and m.status = 'active'
      and m.role in ('owner','admin','manager')
  );
$$;

-- The caller's CURRENTLY ACTIVE org (profiles.org_id). Rows a user owns from an
-- org they've since left/switched away from must NOT follow them into whatever
-- org they're active in now — "you own it" only counts while org_id still
-- matches where you're actively working (or the row predates org scoping and
-- has no org_id at all). Without this, a fresh organization can appear to show
-- another org's leads/calls/appointments simply because the same account owns
-- rows in both.
create or replace function public.app_active_org()
returns uuid language sql stable security definer set search_path = public as $$
  select org_id from public.profiles where id = auth.uid();
$$;

-- ── Stamp org_id on insert from the owner's profile (app code can't forget) ──
create or replace function public.stamp_org_id()
returns trigger language plpgsql security definer set search_path = public as $$
begin
  if new.org_id is null then
    new.org_id := (select org_id from public.profiles where id = new.owner_id);
  end if;
  return new;
end;
$$;

do $$
declare t text;
begin
  foreach t in array array['leads','call_records','appointments','callbacks','ai_conversations','campaigns']
  loop
    execute format('drop trigger if exists stamp_org_id on public.%I', t);
    execute format('create trigger stamp_org_id before insert on public.%I for each row execute function public.stamp_org_id()', t);
  end loop;
end $$;

-- ── Freeze privileged profile columns against self-escalation ────────────────
-- Ordinary end-users (jwt role 'authenticated') can edit name/team/avatar/prefs
-- but NOT their role, suspension flag, or org pointer. The service-role server
-- paths (org switch, approvals, superadmin) bypass this guard.
create or replace function public.guard_profile_columns()
returns trigger language plpgsql security definer set search_path = public as $$
declare jwt_role text;
begin
  jwt_role := coalesce(current_setting('request.jwt.claims', true)::jsonb ->> 'role', '');
  if jwt_role = 'authenticated' then
    new.role       := old.role;
    new.disabled   := old.disabled;
    new.org_id     := old.org_id;
    new.company_id := old.company_id;
  end if;
  return new;
end;
$$;
drop trigger if exists guard_profile_columns on public.profiles;
create trigger guard_profile_columns before update on public.profiles
  for each row execute function public.guard_profile_columns();

-- ── Profiles RLS: read self (or superadmin); update self (guarded columns) ───
drop policy if exists "profiles self" on public.profiles;
drop policy if exists "profiles self read" on public.profiles;
drop policy if exists "profiles self update" on public.profiles;
create policy "profiles self read" on public.profiles for select
  using (id = auth.uid() or public.app_is_superadmin());
create policy "profiles self update" on public.profiles for update
  using (id = auth.uid()) with check (id = auth.uid());

-- ── Data RLS: superadmin can do all; otherwise the account must be ACTIVE and
--    either own the row (read+write) or supervise its org (read only). Suspended
--    users are blocked everywhere (except superadmins, who can't be locked out). ─
-- leads
drop policy if exists "leads owner" on public.leads;
drop policy if exists "leads read" on public.leads;
drop policy if exists "leads write" on public.leads;
create policy "leads read" on public.leads for select using (
  public.app_is_superadmin() or (public.app_is_active() and (
    owner_id = auth.uid()
    or (org_id is not null and public.app_is_org_supervisor(org_id)))));
create policy "leads write" on public.leads for all
  using (public.app_is_superadmin() or (public.app_is_active() and owner_id = auth.uid()))
  with check (public.app_is_superadmin() or (public.app_is_active() and owner_id = auth.uid()));

-- call_records
drop policy if exists "call_records owner" on public.call_records;
drop policy if exists "call_records read" on public.call_records;
drop policy if exists "call_records write" on public.call_records;
create policy "call_records read" on public.call_records for select using (
  public.app_is_superadmin() or (public.app_is_active() and (
    (owner_id = auth.uid() and (org_id is null or org_id = public.app_active_org()))
    or (org_id is not null and public.app_is_org_supervisor(org_id)))));
create policy "call_records write" on public.call_records for all
  using (public.app_is_superadmin() or (public.app_is_active() and owner_id = auth.uid() and (org_id is null or org_id = public.app_active_org())))
  with check (public.app_is_superadmin() or (public.app_is_active() and owner_id = auth.uid() and (org_id is null or org_id = public.app_active_org())));

-- appointments
drop policy if exists "appointments owner" on public.appointments;
drop policy if exists "appointments read" on public.appointments;
drop policy if exists "appointments write" on public.appointments;
create policy "appointments read" on public.appointments for select using (
  public.app_is_superadmin() or (public.app_is_active() and (
    (owner_id = auth.uid() and (org_id is null or org_id = public.app_active_org()))
    or (org_id is not null and public.app_is_org_supervisor(org_id)))));
create policy "appointments write" on public.appointments for all
  using (public.app_is_superadmin() or (public.app_is_active() and owner_id = auth.uid() and (org_id is null or org_id = public.app_active_org())))
  with check (public.app_is_superadmin() or (public.app_is_active() and owner_id = auth.uid() and (org_id is null or org_id = public.app_active_org())));

-- callbacks
drop policy if exists "callbacks owner" on public.callbacks;
drop policy if exists "callbacks read" on public.callbacks;
drop policy if exists "callbacks write" on public.callbacks;
create policy "callbacks read" on public.callbacks for select using (
  public.app_is_superadmin() or (public.app_is_active() and (
    (owner_id = auth.uid() and (org_id is null or org_id = public.app_active_org()))
    or (org_id is not null and public.app_is_org_supervisor(org_id)))));
create policy "callbacks write" on public.callbacks for all
  using (public.app_is_superadmin() or (public.app_is_active() and owner_id = auth.uid() and (org_id is null or org_id = public.app_active_org())))
  with check (public.app_is_superadmin() or (public.app_is_active() and owner_id = auth.uid() and (org_id is null or org_id = public.app_active_org())));

-- ai_conversations
drop policy if exists "ai_conversations owner" on public.ai_conversations;
drop policy if exists "ai_conversations read" on public.ai_conversations;
drop policy if exists "ai_conversations write" on public.ai_conversations;
create policy "ai_conversations read" on public.ai_conversations for select using (
  public.app_is_superadmin() or (public.app_is_active() and (
    (owner_id = auth.uid() and (org_id is null or org_id = public.app_active_org()))
    or (org_id is not null and public.app_is_org_supervisor(org_id)))));
create policy "ai_conversations write" on public.ai_conversations for all
  using (public.app_is_superadmin() or (public.app_is_active() and owner_id = auth.uid() and (org_id is null or org_id = public.app_active_org())))
  with check (public.app_is_superadmin() or (public.app_is_active() and owner_id = auth.uid() and (org_id is null or org_id = public.app_active_org())));

-- campaigns
drop policy if exists "campaigns owner" on public.campaigns;
drop policy if exists "campaigns read" on public.campaigns;
drop policy if exists "campaigns write" on public.campaigns;
create policy "campaigns read" on public.campaigns for select using (
  public.app_is_superadmin() or (public.app_is_active() and (
    (owner_id = auth.uid() and (org_id is null or org_id = public.app_active_org()))
    or (org_id is not null and public.app_is_org_supervisor(org_id)))));
create policy "campaigns write" on public.campaigns for all
  using (public.app_is_superadmin() or (public.app_is_active() and owner_id = auth.uid() and (org_id is null or org_id = public.app_active_org())))
  with check (public.app_is_superadmin() or (public.app_is_active() and owner_id = auth.uid() and (org_id is null or org_id = public.app_active_org())));

-- ── Bootstrap the platform superadmin by email (edit to your address) ────────
-- This makes YOU a hidden superadmin tied to your real Supabase login. It is not
-- shown on your profile. Re-run safe.
insert into public.platform_admins (user_id, note)
  select id, 'bootstrap' from auth.users where lower(email) = lower('pmtosiri@gmail.com')
  on conflict (user_id) do nothing;

-- ═════════════════════════════════════════════════════════════════════════════
-- PART 3 — LIVE CALL PRESENCE  (idempotent; safe to re-run)
--
-- Shared, cross-instance presence for in-progress human (manual) rep↔customer
-- calls so the Live Monitor is consistent on serverless (Vercel): the rep's
-- browser writes a row when a call starts/connects/ends, and every supervisor
-- instance reads the same rows. Without this table the app falls back to
-- per-instance memory, which makes a call flicker in/out of the monitor.
--
-- Service-role only (RLS on, no policies): the server engine scopes reads to the
-- viewer's org in application code, exactly like organization management.
-- ═════════════════════════════════════════════════════════════════════════════
create table if not exists public.live_calls (
  id         text primary key,                 -- the client-generated humanId
  org_id     uuid,
  owner_id   uuid,
  rep_name   text not null default '',
  lead_name  text not null default 'Manual call',
  city       text not null default '',
  phone      text not null default '',
  state      text not null default 'ringing',  -- ringing | connected
  started_at timestamptz not null default now()
);
create index if not exists live_calls_org_idx on public.live_calls (org_id, started_at desc);
alter table public.live_calls enable row level security;

-- ═════════════════════════════════════════════════════════════════════════════
-- PART 4 — CAMPAIGN ATTRIBUTION  (idempotent; safe to re-run)
--
-- Tag each call with the campaign of the lead it was for, so reports + the
-- campaigns tab can slice performance per campaign. Leads already carry
-- campaign_id; this adds the same to call_records.
-- ═════════════════════════════════════════════════════════════════════════════
alter table public.call_records add column if not exists campaign_id text;
create index if not exists call_records_campaign_idx on public.call_records (campaign_id);
create index if not exists leads_campaign_idx on public.leads (campaign_id);

-- ═════════════════════════════════════════════════════════════════════════════
-- PART 5 — APPOINTMENT APPROVAL LAYER  (idempotent; safe to re-run)
--
-- AI-booked appointments are PROPOSALS until a human approves them. Reps' own
-- appointments are auto-approved. Existing rows default to approved (true) so
-- nothing retroactively lands back in the review queue.
-- ═════════════════════════════════════════════════════════════════════════════
alter table public.appointments add column if not exists approved boolean not null default true;
alter table public.appointments add column if not exists reviewed_by uuid references auth.users (id) on delete set null;
alter table public.appointments add column if not exists reviewed_at timestamptz;
create index if not exists appointments_approved_idx on public.appointments (org_id, approved);

-- ── Add call_sid to call_records (manual call recording linkage) ─────────────
-- The rep's Twilio Voice SDK call SID is written here when the disposition is
-- saved. The recording-status webhook then uses it to back-fill recording_url.
alter table public.call_records add column if not exists call_sid text;
create index if not exists call_records_call_sid_idx on public.call_records (call_sid) where call_sid is not null;

-- ═════════════════════════════════════════════════════════════════════════════
-- PART 6 — MANUAL CALL RECORDING LINKAGE  (idempotent; safe to re-run)
--
-- A manual (human) call is a Twilio CONFERENCE, so its recording-status webhook
-- carries the ConferenceSid, NOT the rep's CallSid — matching by call_sid never
-- works for these. Instead we tag the call record with its conference room name
-- (`hc-<id>`) and the webhook passes the same room back, so the two always link.
--
-- Because the recording webhook can fire BEFORE the rep finishes wrap-up (i.e.
-- before the call record exists), a recording that arrives early is parked in
-- `pending_recordings` keyed by room and claimed when the record is written.
-- ═════════════════════════════════════════════════════════════════════════════
alter table public.call_records add column if not exists room text;
create index if not exists call_records_room_idx on public.call_records (room) where room is not null;

create table if not exists public.pending_recordings (
  room          text primary key,
  recording_url text not null,
  created_at    timestamptz not null default now()
);
-- Service-role only (no policies) — written by the webhook, claimed on insert.
alter table public.pending_recordings enable row level security;

-- Twilio's own verdict on the call (answered? which error code?) races the call
-- record the exact same way, and for the exact same reason: `completed` fires the
-- instant the call ends, while the record isn't written until the rep saves the
-- disposition. Keyed by room and claimed on insert, just like the recording above.
-- Without this the verdict update matches zero rows on every call and these
-- columns stay null forever — which is how 21210/21212 (bad caller ID), 21610
-- (blocked) and 13224 (geo) failures become invisible.
create table if not exists public.pending_call_verdicts (
  room               text primary key,
  twilio_call_status text,
  twilio_error_code  integer,
  answered_by        text,
  created_at         timestamptz not null default now()
);
-- Service-role only (no policies) — written by the webhook, claimed on insert.
alter table public.pending_call_verdicts enable row level security;

-- ═════════════════════════════════════════════════════════════════════════════
-- PART 7 — SHARED ORG LEAD POOL  (idempotent; safe to re-run)
--
-- Leads become a single shared pool per organization: every active member sees
-- and works the same leads (not just their own imports). Reads + updates are
-- open to any active org member (so any rep can dial and disposition any lead);
-- deletes are limited to supervisors (manager/admin/owner). Inserts stay
-- owner-stamped (you create leads you own; the org_id trigger shares them).
-- ═════════════════════════════════════════════════════════════════════════════

-- Active member (ANY role) of the given org?
create or replace function public.app_is_org_member(target_org uuid)
returns boolean language sql stable security definer set search_path = public as $$
  select exists (
    select 1 from public.organization_members m
    where m.user_id = auth.uid()
      and m.org_id = target_org
      and m.status = 'active'
  );
$$;

-- Replace the owner-only leads policies with shared-pool policies.
drop policy if exists "leads owner"  on public.leads;
drop policy if exists "leads read"   on public.leads;
drop policy if exists "leads write"  on public.leads;
drop policy if exists "leads insert" on public.leads;
drop policy if exists "leads update" on public.leads;
drop policy if exists "leads delete" on public.leads;

-- Read: any active member of the lead's org (shared pool), the owner (while
-- still active in that lead's org — see app_active_org()), or superadmin.
create policy "leads read" on public.leads for select using (
  public.app_is_superadmin() or (public.app_is_active() and (
    (owner_id = auth.uid() and (org_id is null or org_id = public.app_active_org()))
    or (org_id is not null and public.app_is_org_member(org_id)))));

-- Insert: you create leads you own (the stamp_org_id trigger fills org_id).
create policy "leads insert" on public.leads for insert with check (
  public.app_is_superadmin() or (public.app_is_active() and owner_id = auth.uid()));

-- Update: any active org member (so any rep can disposition any shared lead).
create policy "leads update" on public.leads for update
  using (public.app_is_superadmin() or (public.app_is_active() and (
    (owner_id = auth.uid() and (org_id is null or org_id = public.app_active_org()))
    or (org_id is not null and public.app_is_org_member(org_id)))))
  with check (public.app_is_superadmin() or (public.app_is_active() and (
    (owner_id = auth.uid() and (org_id is null or org_id = public.app_active_org()))
    or (org_id is not null and public.app_is_org_member(org_id)))));

-- Delete: the owner (while still active in that lead's org), or a supervisor
-- (manager/admin/owner) of the lead's org.
create policy "leads delete" on public.leads for delete using (
  public.app_is_superadmin() or (public.app_is_active() and (
    (owner_id = auth.uid() and (org_id is null or org_id = public.app_active_org()))
    or (org_id is not null and public.app_is_org_supervisor(org_id)))));

-- ─────────────────────────────────────────────────────────────────────────────
-- PART 9 — Caller-ID rotation  (per-rep, shared-pool)
--
-- A generic atomic counter keyed by an arbitrary string. The dialer keys it by
-- the rep's USER id, so every rep cycles the shared pool of outbound numbers on
-- their OWN sequence (rep A's calls never advance rep B's number). The pool +
-- cadence live in organizations.settings.dialing (or env vars). The function
-- returns the next value atomically, so concurrent power-dials never collide.
-- ─────────────────────────────────────────────────────────────────────────────
create table if not exists public.dial_counters (
  key text primary key,
  seq bigint not null default 0
);
-- Service-role only (RLS on, no policies) — only the server engine touches it.
alter table public.dial_counters enable row level security;

-- Replace the old per-org (uuid) counter with the keyed (text) one.
drop function if exists public.app_next_dial_seq(uuid);
alter table public.organizations drop column if exists dial_seq;

create or replace function public.app_next_dial_seq(p_key text)
returns bigint
language plpgsql
security definer
set search_path = public
as $$
declare v bigint;
begin
  insert into public.dial_counters (key, seq) values (p_key, 1)
  on conflict (key) do update set seq = public.dial_counters.seq + 1
  returning seq into v;
  return coalesce(v, 1);
end;
$$;

-- WRITES: upserts and increments dial_counters. Its only caller uses the
-- service-role client (nextDialSeq in src/lib/dialer/rotation-server.ts), so
-- nothing else needs it — and an anonymous caller could advance every
-- caller-ID rotation counter on the platform.
revoke execute on function public.app_next_dial_seq(text) from public, anon, authenticated;
grant execute on function public.app_next_dial_seq(text) to service_role;
-- PART 10 — AI CALL FORENSICS  (idempotent; safe to re-run)
--
-- Added after the zero-connect incident, in which 283 calls that the homeowner
-- ANSWERED and the agent then killed after ~2s were all filed as "no answer",
-- and 6,164 calls were never finalized at all. Nothing in the schema recorded
-- WHY a call produced no conversation, so a total outage of the AI agent was
-- indistinguishable from a run of bad luck on the lead list.
--
-- `failure_kind` is the fix: it separates a fact about the HOMEOWNER (outcome:
-- no_answer / voicemail / wrong_number) from a fact about OUR SYSTEM (the agent
-- hung up, the provider errored, the call was never placed). A row with
-- outcome IS NULL AND failure_kind IS NOT NULL is "not a real call" — it is
-- excluded from every connect-rate denominator instead of deflating it.
-- ─────────────────────────────────────────────────────────────────────────────

alter table public.call_records     add column if not exists failure_kind        text;
alter table public.call_records     add column if not exists termination_reason  text;
alter table public.call_records     add column if not exists twilio_call_status  text;   -- completed|no-answer|busy|failed|canceled
alter table public.call_records     add column if not exists twilio_error_code   int;    -- e.g. 21210 / 21212 / 21610
alter table public.call_records     add column if not exists answered_by         text;   -- Twilio AMD, when enabled

alter table public.ai_conversations add column if not exists failure_kind        text;
alter table public.ai_conversations add column if not exists termination_reason  text;
alter table public.ai_conversations add column if not exists override_mode       text;   -- what we were allowed to send

-- The reconciler drains stuck calls OLDEST-first; without this index that scan
-- degrades as the backlog grows (and the backlog is exactly when it must be fast).
create index if not exists ai_conversations_stuck_idx
  on public.ai_conversations (state, started_at)
  where state in ('initiated', 'in_progress');

create index if not exists call_records_failure_idx
  on public.call_records (failure_kind)
  where failure_kind is not null;

-- Joining an AI call back to its Twilio leg / recording webhook.
create index if not exists call_records_call_sid_idx
  on public.call_records (call_sid)
  where call_sid is not null;

-- ═════════════════════════════════════════════════════════════════════════════
-- PART 9 — LIVE CALL STATE  (idempotent; safe to re-run)
--
-- The Live Monitor could not tell "ringing" from "connected": a call sat in one
-- lumped "in progress" state from the moment it was placed until something
-- finalized it — which, for a homeowner who never picked up, could be twelve
-- minutes later or never. Twilio always knew the difference. We just never asked
-- it, and had nowhere to put the answer.
--
-- The lifecycle is now monotonic and can only move forward:
--   initiated ──► ringing ──► in_progress ──► completed | failed
--   (placed)     (their      (they picked    (terminal, with an outcome)
--                 phone is    up — the talk
--                 ringing)    timer starts here)
-- ═════════════════════════════════════════════════════════════════════════════

-- ringing_at / connected_at are the moments Twilio reported each transition.
-- connected_at is what the on-call timer counts from: it previously counted from
-- started_at, so a call that was merely ringing already displayed a running talk
-- duration, which is precisely the lie this fixes.
alter table public.ai_conversations add column if not exists ringing_at   timestamptz;
alter table public.ai_conversations add column if not exists connected_at timestamptz;

-- The homeowner's Twilio leg (bridge mode). The status webhook arrives carrying
-- only a CallSid; without this column we cannot map it back to a conversation
-- when the query param is lost, and the event is discarded.
alter table public.ai_conversations add column if not exists customer_call_sid text;

create index if not exists ai_conversations_customer_sid_idx
  on public.ai_conversations (customer_call_sid)
  where customer_call_sid is not null;

-- CRITICAL: the stuck-call reconciler finds work through this partial index. It
-- was `state in ('initiated','in_progress')`. Adding a 'ringing' state without
-- adding it here would make every ringing call INVISIBLE to the reconciler — the
-- exact class of "stuck forever" bug this whole change exists to kill. The index
-- must be recreated, not just re-declared: `create index if not exists` is a
-- no-op against the old definition and would silently leave the gap open.
drop index if exists public.ai_conversations_stuck_idx;
create index ai_conversations_stuck_idx
  on public.ai_conversations (state, started_at)
  where state in ('initiated', 'ringing', 'in_progress');

-- Human calls get the same treatment. 'calling' is the pre-ring state (we've
-- asked Twilio to dial, the phone isn't ringing yet); connected_at again anchors
-- the talk timer instead of started_at.
--   calling ──► ringing ──► connected  (row is deleted on hangup)
alter table public.live_calls add column if not exists connected_at timestamptz;
comment on column public.live_calls.state is 'calling | ringing | connected';

-- Which lead actually picked up, in a parallel ("3X") dial. One room has N legs;
-- the losing legs are force-released and report `completed`/`canceled` moments
-- after the winner answers. Without knowing WHICH leg answered, a losing leg's
-- terminal event would delete the row and yank a live, connected call off the
-- monitor while the rep is still talking. We only end the row on a terminal event
-- for the leg recorded here.
alter table public.live_calls add column if not exists answered_lead_id text;

-- ═════════════════════════════════════════════════════════════════════════════
-- PART 11 — LIVE USER PRESENCE  (idempotent; safe to re-run)
--
-- The manager-level Team Status roster needs to know who is currently active —
-- not just who's on a call. `live_calls` only has a row while a call is ringing
-- or connected (deleted on hangup), so an idle-but-present rep is invisible to
-- it. This is presence, one row per USER (upserted on every heartbeat from the
-- dialer), not per call — status mirrors DialerStatus (idle | dialing | live |
-- wrapup | ai) and is simply overwritten as the rep moves between states.
--
-- Same trust model as `live_calls`: RLS on, no policies. The server (service
-- role) writes the caller's OWN row (identity from the session, never the
-- client) and reads scoped to the viewer's org + monitor.roster permission,
-- both enforced in application code. name/role are intentionally NOT stored
-- here — the read side joins organization_members so a display-name change
-- can't leave a stale row behind.
-- ═════════════════════════════════════════════════════════════════════════════
create table if not exists public.user_presence (
  user_id         uuid primary key,
  org_id          uuid,
  status          text not null default 'idle',   -- idle | dialing | live | wrapup | ai
  lead_name       text,
  lead_city       text,
  lead_phone      text,
  ai_active_count int not null default 0,
  updated_at      timestamptz not null default now(), -- last heartbeat (staleness)
  status_since    timestamptz not null default now()  -- when `status` last CHANGED (roster timer)
);
create index if not exists user_presence_org_idx on public.user_presence (org_id, updated_at desc);
alter table public.user_presence enable row level security;

-- Atomic upsert that preserves `status_since` when the status hasn't actually
-- changed (a heartbeat every ~20s would otherwise reset a "Live · 4:12" timer
-- back to :00 on every tick). A plain client-side .upsert() can't express this
-- "keep old value unless X changed" logic in one round trip without a race
-- between concurrent heartbeats, so it's a function like app_next_dial_seq.
create or replace function public.app_upsert_presence(
  p_user_id uuid,
  p_org_id uuid,
  p_status text,
  p_lead_name text,
  p_lead_city text,
  p_lead_phone text,
  p_ai_active_count int
) returns void
language plpgsql
security definer
set search_path = public
as $$
begin
  insert into public.user_presence
    (user_id, org_id, status, lead_name, lead_city, lead_phone, ai_active_count, updated_at, status_since)
  values
    (p_user_id, p_org_id, p_status, p_lead_name, p_lead_city, p_lead_phone, p_ai_active_count, now(), now())
  on conflict (user_id) do update set
    org_id           = excluded.org_id,
    status           = excluded.status,
    lead_name        = excluded.lead_name,
    lead_city        = excluded.lead_city,
    lead_phone       = excluded.lead_phone,
    ai_active_count  = excluded.ai_active_count,
    updated_at       = now(),
    status_since     = case
                          when public.user_presence.status = excluded.status
                          then public.user_presence.status_since
                          else now()
                        end;
end;
$$;

grant execute on function public.app_upsert_presence(uuid, uuid, text, text, text, text, int)
  to service_role;
-- CREATE FUNCTION grants PUBLIC execute by default — the grant above is
-- additive, not a replacement. Unlike app_next_dial_seq (an arbitrary atomic
-- counter, safe for anon/authenticated), this function trusts p_user_id /
-- p_org_id with no auth.uid() check, so it must ONLY ever be reachable via the
-- service-role client. Revoke the implicit PUBLIC grant explicitly.
revoke execute on function public.app_upsert_presence(uuid, uuid, text, text, text, text, int) from public;
revoke execute on function public.app_upsert_presence(uuid, uuid, text, text, text, text, int) from anon;
revoke execute on function public.app_upsert_presence(uuid, uuid, text, text, text, text, int) from authenticated;

-- ═════════════════════════════════════════════════════════════════════════════
-- PART 12 — APPOINTMENTS & CALENDAR  (idempotent; safe to re-run)
--
-- The appointments table was a flat list: a lead name, a nullable timestamp, a
-- status. That is enough to render a list and nothing else. A calendar needs an
-- END time (duration), a PLACE, a person it belongs to that is distinct from the
-- person who booked it, and a memory of what it used to be. It also needs to be
-- able to exist WITHOUT a call behind it — a manager scheduling a review by hand.
--
-- ── The one invariant everything here depends on ────────────────────────────
-- `scheduled_at` is declared timestamptz but it is NOT a true instant. It is a
-- FLOATING WALL-CLOCK time: the app writes an offset-less string
-- ("2026-06-23T18:00:00"), Postgres reads it as UTC, and the app strips the +00
-- again on the way out (`toFloatingLocal`). "6pm" means 6pm on whatever wall
-- clock the appointment belongs to — which is what `timezone` now records.
--
-- Do NOT "fix" this into real UTC without backfilling every existing row and
-- rewriting every reader. It is deliberate, it is consistent, and a half-done
-- migration would silently shift every appointment in the database by hours.
-- The single source of truth for reading/writing it is src/lib/appointments/time.ts.
--
-- `scheduled_at` is also NULLABLE and always will be — an AI call that books
-- "sometime next week" has a label and no timestamp. Those rows live in the
-- "later" bucket and never appear on the grid.
-- ═════════════════════════════════════════════════════════════════════════════
alter table public.appointments add column if not exists duration_min     int not null default 60;
alter table public.appointments add column if not exists location         text default '';
alter table public.appointments add column if not exists timezone         text;
alter table public.appointments add column if not exists assigned_to      uuid references auth.users (id) on delete set null;
alter table public.appointments add column if not exists created_by       uuid references auth.users (id) on delete set null;
alter table public.appointments add column if not exists call_record_id   uuid references public.call_records (id) on delete set null;
alter table public.appointments add column if not exists title            text default '';
alter table public.appointments add column if not exists cancel_reason    text;
alter table public.appointments add column if not exists rescheduled_from timestamptz;
alter table public.appointments add column if not exists reschedule_count int not null default 0;
alter table public.appointments add column if not exists notified_at      timestamptz;
alter table public.appointments add column if not exists updated_at       timestamptz not null default now();

-- The calendar's only range query: "every appointment in this org between X and Y".
create index if not exists appointments_calendar_idx on public.appointments (org_id, scheduled_at);
-- The per-rep calendar filter (a rep's own day/week).
create index if not exists appointments_assigned_idx on public.appointments (assigned_to, scheduled_at);

-- Every pre-existing row belongs to whoever booked it.
update public.appointments set assigned_to = owner_id where assigned_to is null;

-- Fill in the derivable columns so app code can never forget them: an unassigned
-- appointment belongs to its owner, and its wall clock is the lead's timezone.
create or replace function public.appointments_before_write()
returns trigger language plpgsql security definer set search_path = public as $$
begin
  if new.assigned_to is null then
    new.assigned_to := new.owner_id;
  end if;
  if coalesce(new.timezone, '') = '' and new.lead_id is not null then
    new.timezone := nullif((select timezone from public.leads where id = new.lead_id), '');
  end if;
  new.updated_at := now();
  return new;
end;
$$;
drop trigger if exists appointments_before_write on public.appointments;
create trigger appointments_before_write before insert or update on public.appointments
  for each row execute function public.appointments_before_write();

-- ═════════════════════════════════════════════════════════════════════════════
-- PART 13 — NOTIFICATION OUTBOX  (idempotent; safe to re-run)
--
-- "Email the sales lead whenever an appointment is set, and never fail silently."
--
-- The enqueue is a TRIGGER, not application code, and that is the whole point.
-- supabase-js has no transactions: an app-level "insert the appointment, then
-- insert the outbox row" can lose the second write to a cold lambda, a network
-- blip, or an unhandled throw — and a dropped notification is exactly what this
-- feature exists to prevent. A trigger is atomic with the INSERT by construction,
-- and it cannot be forgotten by whatever new booking path someone adds next year.
--
-- WHEN it fires is a product decision, not a technical one:
--   • INSERT with approved = true          → the rep booked it. It's real. Send.
--   • UPDATE approved false → true         → a human approved the AI's proposal.
--                                            THAT is when an AI booking becomes
--                                            real. Firing on the AI's raw proposal
--                                            would email a guess.
--   • scheduled_at changed, already notified → rescheduled. Tell them.
--   • status → cancelled, already notified   → cancelled. Tell them.
-- `notified_at` makes "set" at-most-once, so a re-approve can't double-send.
--
-- The trigger records only WHAT happened and the data to render it. WHO receives
-- it is resolved at SEND time by the drain (org settings → APPOINTMENT_NOTIFY_EMAILS
-- env fallback), because Postgres cannot see the app's environment.
--
-- Same trust model as user_presence: RLS on, NO policies. Service-role only,
-- org-scoped in application code.
-- ═════════════════════════════════════════════════════════════════════════════
create table if not exists public.notification_outbox (
  id              uuid primary key default gen_random_uuid(),
  org_id          uuid references public.organizations (id) on delete cascade,
  -- appointment_set | appointment_rescheduled | appointment_cancelled
  kind            text not null,
  appointment_id  uuid references public.appointments (id) on delete cascade,
  -- Everything the email needs, snapshotted at enqueue time. The drain does no joins.
  payload         jsonb not null default '{}'::jsonb,
  -- pending → sent | failed (retries exhausted) | skipped (nobody to email — benign)
  status          text not null default 'pending',
  attempts        int not null default 0,
  next_attempt_at timestamptz not null default now(),
  last_error      text,
  sent_at         timestamptz,
  provider_id     text,
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now()
);

-- The drain's ONLY query — "what is due?". Partial so it stays tiny no matter how
-- many thousands of sent rows accumulate behind it.
create index if not exists notification_outbox_due_idx
  on public.notification_outbox (next_attempt_at)
  where status = 'pending';
-- The alert surfaces ("has anything failed for this org?") and the audit trail.
create index if not exists notification_outbox_org_idx
  on public.notification_outbox (org_id, status, created_at desc);

alter table public.notification_outbox enable row level security;

create or replace function public.enqueue_appointment_notification()
returns trigger language plpgsql security definer set search_path = public as $$
declare
  k text;
  l record;
begin
  -- Our own `set notified_at` UPDATE below re-enters this trigger. Bail out of any
  -- nested invocation rather than relying on the branch conditions to be a fixed
  -- point — cheaper to reason about, and it can't loop.
  if pg_trigger_depth() > 1 then
    return new;
  end if;

  if tg_op = 'INSERT' then
    if new.approved and new.status = 'scheduled' then
      k := 'appointment_set';
    end if;
  else
    if new.status = 'cancelled' and coalesce(old.status, '') <> 'cancelled'
       and old.notified_at is not null then
      k := 'appointment_cancelled';
    elsif new.approved and not coalesce(old.approved, false)
          and new.status = 'scheduled' and old.notified_at is null then
      k := 'appointment_set';
    elsif old.notified_at is not null and new.status = 'scheduled'
          and new.scheduled_at is distinct from old.scheduled_at then
      k := 'appointment_rescheduled';
    end if;
  end if;

  if k is null then
    return new;
  end if;

  select first_name, last_name, phone, email, address, city, state, zip,
         utility_bill, solar_payment, utility_provider
    into l
    from public.leads
   where id = new.lead_id;

  insert into public.notification_outbox (org_id, kind, appointment_id, payload)
  values (
    new.org_id,
    k,
    new.id,
    jsonb_build_object(
      'appointmentId',  new.id,
      'ownerId',        new.owner_id,
      'assignedTo',     new.assigned_to,
      'leadId',         new.lead_id,
      'leadName',       coalesce(nullif(new.lead_name, ''), 'Homeowner'),
      -- Serialize the floating wall clock back out EXACTLY as the app stores it:
      -- read the timestamptz as UTC and drop the offset. See the PART 12 invariant.
      'scheduledAt',    case when new.scheduled_at is null then null
                             else to_char(new.scheduled_at at time zone 'UTC',
                                          'YYYY-MM-DD"T"HH24:MI:SS') end,
      'previousAt',     case when old is null or old.scheduled_at is null then null
                             else to_char(old.scheduled_at at time zone 'UTC',
                                          'YYYY-MM-DD"T"HH24:MI:SS') end,
      'scheduledLabel', coalesce(new.scheduled_label, ''),
      'durationMin',    new.duration_min,
      'timezone',       coalesce(new.timezone, ''),
      'location',       coalesce(new.location, ''),
      'notes',          coalesce(new.notes, ''),
      'source',         new.source,
      'status',         new.status,
      'cancelReason',   coalesce(new.cancel_reason, ''),
      'phone',          coalesce(l.phone, ''),
      'email',          coalesce(l.email, ''),
      'address',        coalesce(l.address, ''),
      'city',           coalesce(l.city, ''),
      'state',          coalesce(l.state, ''),
      'zip',            coalesce(l.zip, ''),
      'utilityBill',    l.utility_bill,
      'solarPayment',   l.solar_payment,
      'utilityProvider', coalesce(l.utility_provider, '')
    )
  );

  -- Mark it notified so a later reschedule/cancel knows there's something to
  -- correct, and so a second approve can't re-send the booking. The guard makes
  -- this a no-op (and fires no trigger) for the reschedule/cancel kinds.
  if k = 'appointment_set' then
    update public.appointments set notified_at = now()
     where id = new.id and notified_at is null;
  end if;

  return new;
end;
$$;

drop trigger if exists enqueue_appointment_notification on public.appointments;
create trigger enqueue_appointment_notification
  after insert or update on public.appointments
  for each row execute function public.enqueue_appointment_notification();

-- CREATE FUNCTION grants PUBLIC execute by default, which publishes both trigger
-- functions at /rest/v1/rpc/<name> for anon and authenticated. Postgres refuses to
-- run a trigger function as an ordinary call ("can only be called as a trigger"),
-- so this is not exploitable — but they are SECURITY DEFINER, they have no business
-- being in the public API surface, and the linter is right to flag them. Same
-- treatment as app_upsert_presence above.
revoke execute on function public.appointments_before_write() from public;
revoke execute on function public.appointments_before_write() from anon;
revoke execute on function public.appointments_before_write() from authenticated;
revoke execute on function public.enqueue_appointment_notification() from public;
revoke execute on function public.enqueue_appointment_notification() from anon;
revoke execute on function public.enqueue_appointment_notification() from authenticated;

-- ═════════════════════════════════════════════════════════════════════════════
-- PART 13 — ASSIGNED-REP DIAL ROUTING  (idempotent; safe to re-run)
--
-- `assigned_rep_id` already existed on `leads` but nothing ever read it. It now
-- routes leads into a rep's dial queue + Leads tab NON-DESTRUCTIVELY: a rep's
-- scope became `owner_id = me OR assigned_rep_id = me` (getDialQueue / getLeads),
-- so a supervisor can hand a bulk-imported list to a rep without rewriting who
-- uploaded it. That OR-scan filters on this column on every rep load, so index it
-- (it was an unindexed text column). Partial — only assigned rows are of interest.
-- ═════════════════════════════════════════════════════════════════════════════
create index if not exists leads_assigned_rep_idx
  on public.leads (assigned_rep_id) where assigned_rep_id is not null;

-- ═════════════════════════════════════════════════════════════════════════════
-- PART 14 — LEAD GEOGRAPHY GROUPS  (idempotent; safe to re-run)
--
-- Five fixed intake groups: fresno | houston | dallas | california | manual.
-- NULL means "unsorted" — reachable ONLY via the AI auto-sort path, for a lead
-- that doesn't clearly match one of the 4 geographic buckets. The AI classifier
-- never writes 'manual' (enforced by its JSON schema's enum in
-- src/lib/ai/geo-classify.ts, not just prompt wording) — that bucket exists
-- only for a human to file a lead into on purpose.
--
-- Orthogonal to campaign_id: campaigns are named/scoped by UTILITY PROVIDER
-- (e.g. "PG&E True-Up Recovery"), a different axis from geography — a lead
-- carries both a group and a campaign at once.
-- ═════════════════════════════════════════════════════════════════════════════
alter table public.leads add column if not exists lead_group text;

do $$
begin
  if not exists (select 1 from pg_constraint where conname = 'leads_lead_group_check') then
    alter table public.leads
      add constraint leads_lead_group_check
      check (lead_group in ('fresno','houston','dallas','california','manual'));
  end if;
end $$;

create index if not exists leads_lead_group_idx
  on public.leads (lead_group) where lead_group is not null;

-- ═════════════════════════════════════════════════════════════════════════════
-- PART 15 — AI AGENT ATTRIBUTION  (idempotent; safe to re-run)
--
-- Which AI persona ("primary" = Agent 1, "secondary" = Agent 2) placed a call,
-- and therefore closed any appointment it books. Stamped on the conversation at
-- placement (ai-dialer → seedAIConversation) and copied onto the appointment
-- when the booking is filed (routeDisposition), so the Appointments tab can be
-- split into a tab per agent. Null on rep-booked reviews and on legacy AI rows
-- from before this column existed (those simply appear only under "All").
-- ═════════════════════════════════════════════════════════════════════════════
alter table public.ai_conversations add column if not exists agent_key text;
alter table public.appointments     add column if not exists agent_key text;
create index if not exists appointments_agent_idx
  on public.appointments (org_id, agent_key) where agent_key is not null;

-- ═════════════════════════════════════════════════════════════════════════════
-- PART 16 — LEGAL ACCEPTANCE + CAMPAIGN COMPLIANCE CERTIFICATION
--           (idempotent; safe to re-run)
--
-- Two distinct compliance controls, deliberately kept in separate tables:
--
--   legal_acceptances       — the account-level clickwrap: "I agree to the
--                             Terms of Service / Privacy Policy / Acceptable
--                             Use Policy", captured once at signup with the
--                             audit trail a real dispute would need (who, what
--                             exact text, what version, from where, when).
--                             Append-only — never updated or deleted. A new
--                             row is added if a user re-accepts a bumped
--                             version; history is never overwritten.
--
--   campaign_certifications — the PER-CAMPAIGN (or org-wide "no campaign"
--                             bucket, campaign_id null) certification that a
--                             specific list of numbers has been legally
--                             vetted. Re-required whenever CAMPAIGN_CERT_VERSION
--                             bumps. This is what makes it possible to show a
--                             customer certified responsibility for THIS
--                             specific campaign, not just the platform in
--                             general months earlier.
--
-- Service-role only (RLS on, no policies): both are written exclusively by the
-- server AFTER an application-code auth/permission check (getUser() /
-- getScope()), exactly like audit_log and dial_counters above.
-- ═════════════════════════════════════════════════════════════════════════════
create table if not exists public.legal_acceptances (
  id               uuid primary key default gen_random_uuid(),
  user_id          uuid references auth.users (id) on delete set null,
  email            text not null default '',
  -- Filled in later if/when the user creates or joins an org — nothing about
  -- a business exists yet at the moment of account creation.
  org_id           uuid references public.organizations (id) on delete set null,
  business_name    text default '',
  terms_version    text not null,
  privacy_version  text not null,
  aup_version      text not null,
  -- The EXACT checkbox label shown, verbatim — proof of what was agreed to,
  -- independent of whatever the copy says today.
  acceptance_text  text not null,
  ip_address       text default '',
  user_agent       text default '',
  created_at       timestamptz not null default now()
);
create index if not exists legal_acceptances_user_idx on public.legal_acceptances (user_id, created_at desc);
alter table public.legal_acceptances enable row level security;

-- No uniqueness constraint on (org_id, campaign_id, version) on purpose: a
-- plain `unique` column set treats two NULL campaign_ids as distinct (standard
-- SQL), so it would silently fail to dedupe the org-wide "no campaign" bucket
-- anyway. A second certification row for the same campaign isn't a bug worth
-- a partial-index workaround for — it's harmless (the gate only checks
-- whether AT LEAST ONE current-version row exists) and arguably better audit
-- history: several people certifying the same campaign over time is real
-- signal, not noise.
create table if not exists public.campaign_certifications (
  id            uuid primary key default gen_random_uuid(),
  org_id        uuid not null references public.organizations (id) on delete cascade,
  -- null = the org-wide "no campaign" bucket (ad-hoc / manual-group imports).
  campaign_id   uuid references public.campaigns (id) on delete cascade,
  certified_by  uuid references auth.users (id) on delete set null,
  version       text not null,
  cert_text     text not null,
  created_at    timestamptz not null default now()
);
create index if not exists campaign_certifications_org_idx
  on public.campaign_certifications (org_id, campaign_id, version);
alter table public.campaign_certifications enable row level security;

-- ═════════════════════════════════════════════════════════════════════════════
-- PART 17 — ORG-DEFINED LEAD GROUPS + LEAD PACKS  (idempotent; safe to re-run)
--
-- Generalizes PART 14. `lead_group` used to be five hardcoded geographic buckets
-- (fresno/houston/dallas/california/manual) enforced by a CHECK constraint and
-- shared by every tenant, with per-org settings able to RENAME them but never
-- change what they were. A workspace whose book isn't Californian or Texan had
-- to file everything into someone else's taxonomy.
--
-- Two tables now:
--
--   lead_groups — the buckets THIS org sorts into, created by its own admins.
--     `description` is the plain-English rule the AI classifier sorts against
--     ("Dallas/Fort Worth area codes and cities"), so a group means whatever the
--     org says it means. `kind` is load-bearing:
--       'sorted' — the AI may assign leads here.
--       'manual' — a human files leads here on purpose; the AI NEVER assigns it
--                  (enforced by omitting it from the classifier's enum, exactly
--                  as the old geo classifier excluded 'manual').
--
--   lead_packs — numbered slices of ONE upload ("Jan list · Pack 7"), so a
--     10,000-row file can be handed out 100 at a time. Deliberately a SEPARATE
--     axis from groups: a lead has both, so "the North Texas leads in Pack 7"
--     is answerable and packs can be dealt to reps without disturbing grouping.
--
-- leads.lead_group stays TEXT holding a group key (not a uuid FK) so the 7,614
-- already-grouped rows keep working untouched and the legacy keys stay valid;
-- validity is enforced in application code against this org's rows, the same
-- way the rest of the app scopes by org. The old CHECK is dropped because it
-- would reject every custom key.
-- ═════════════════════════════════════════════════════════════════════════════

create table if not exists public.lead_groups (
  id          uuid primary key default gen_random_uuid(),
  org_id      uuid not null references public.organizations(id) on delete cascade,
  key         text not null,
  label       text not null,
  description text not null default '',
  kind        text not null default 'sorted' check (kind in ('sorted','manual')),
  sort_order  int  not null default 0,
  created_at  timestamptz not null default now(),
  unique (org_id, key)
);
create index if not exists lead_groups_org_idx on public.lead_groups (org_id, sort_order);
alter table public.lead_groups enable row level security;

create table if not exists public.lead_packs (
  id          uuid primary key default gen_random_uuid(),
  org_id      uuid not null references public.organizations(id) on delete cascade,
  batch       text not null default '',
  seq         int  not null default 1,
  label       text not null,
  size        int  not null default 0,
  created_by  uuid,
  created_at  timestamptz not null default now()
);
create index if not exists lead_packs_org_idx on public.lead_packs (org_id, created_at desc);
alter table public.lead_packs enable row level security;

alter table public.leads
  add column if not exists lead_pack_id uuid references public.lead_packs(id) on delete set null;
create index if not exists leads_lead_pack_idx
  on public.leads (lead_pack_id) where lead_pack_id is not null;

-- The five fixed keys are no longer the only legal values.
alter table public.leads drop constraint if exists leads_lead_group_check;

-- Seed every existing org with the legacy buckets so nothing an org already
-- filed becomes an orphan key, and so a workspace that never opens the new
-- admin screen behaves exactly as it did before.
insert into public.lead_groups (org_id, key, label, description, kind, sort_order)
select o.id, g.key, g.label, g.description, g.kind, g.sort_order
from public.organizations o
cross join (values
  ('fresno',     'Fresno',        'Fresno metro: Fresno, Clovis, Sanger, Selma and nearby Central Valley cities; ZIPs 936-937.', 'sorted', 0),
  ('houston',    'Houston',       'Houston metro: Houston, Sugar Land, Pearland, Katy, Spring, The Woodlands; ZIPs 770-775.',    'sorted', 1),
  ('dallas',     'Dallas',        'Dallas/Fort Worth metro: Dallas, Plano, Irving, Garland, Richardson; ZIPs 750-753.',          'sorted', 2),
  ('california', 'California',    'Any other California lead not in the Fresno metro.',                                          'sorted', 3),
  ('manual',     'Manual Dialing','Leads a human files here on purpose to dial by hand.',                                        'manual', 4)
) as g(key, label, description, kind, sort_order)
on conflict (org_id, key) do nothing;

-- RLS. Enabling RLS with NO policies denies everything to the session client,
-- which would have made every custom group invisible (listLeadGroups would fall
-- back to the legacy five and an admin's new group would simply never appear).
-- Members read their org's groups and packs; supervisors write them. Writes also
-- go through the service-role client after an application permission check, so
-- these are the second lock, not the only one.
drop policy if exists "lead_groups read" on public.lead_groups;
create policy "lead_groups read" on public.lead_groups for select using (
  app_is_superadmin() or (app_is_active() and app_is_org_member(org_id))
);
drop policy if exists "lead_groups write" on public.lead_groups;
create policy "lead_groups write" on public.lead_groups for all
  using (app_is_superadmin() or (app_is_active() and app_is_org_supervisor(org_id)))
  with check (app_is_superadmin() or (app_is_active() and app_is_org_supervisor(org_id)));

drop policy if exists "lead_packs read" on public.lead_packs;
create policy "lead_packs read" on public.lead_packs for select using (
  app_is_superadmin() or (app_is_active() and app_is_org_member(org_id))
);
drop policy if exists "lead_packs write" on public.lead_packs;
create policy "lead_packs write" on public.lead_packs for all
  using (app_is_superadmin() or (app_is_active() and app_is_org_supervisor(org_id)))
  with check (app_is_superadmin() or (app_is_active() and app_is_org_supervisor(org_id)));

-- ═════════════════════════════════════════════════════════════════════════════
-- PART: RLS READ LOCKDOWN (P0.4)
--
-- Placed at the END so every helper function (app_is_org_member, app_active_org,
-- app_is_superadmin) already exists. The original "orgs read"/"companies read"
-- policies above used `using (auth.uid() is not null)`, which let ANY signed-in
-- user read EVERY tenant's row via the public anon key — leaking each org's
-- join_code, caller IDs, AI system prompt, notification emails and billing.
-- These tightened policies override them (drop + recreate). Kept in sync with
-- supabase/rls-lockdown.sql.
-- ═════════════════════════════════════════════════════════════════════════════

-- Onboarding directory of joinable orgs — only non-sensitive columns. SECURITY
-- DEFINER so it works under the tightened organizations policy below.
create or replace function public.app_list_joinable_orgs()
returns table (id uuid, name text, industry text, slug text, require_approval boolean)
language sql stable security definer set search_path = public as $$
  select id, name, industry, slug, coalesce(require_approval, true)
  from public.organizations
  where status = 'active' and coalesce(allow_join, true) = true
  order by name asc;
$$;
-- NOT `to anon`. This is SECURITY DEFINER, and `anon` is the key that ships in
-- every browser bundle — so granting it here meant anyone could POST to
-- /rest/v1/rpc/app_list_joinable_orgs and receive the id, name, industry and
-- slug of EVERY active workspace on the platform. Confirmed over HTTP with the
-- public key before this was changed; it returned the whole list.
--
-- Its only caller is the Hub's workspace picker, behind the auth gate, using
-- the authenticated session client. There was never an anonymous caller.
--
-- `revoke from anon` alone does nothing: PUBLIC holds execute by default and
-- anon inherits it, which is how this stayed open. Revoke from PUBLIC too.
revoke execute on function public.app_list_joinable_orgs() from public, anon;
grant execute on function public.app_list_joinable_orgs() to authenticated, service_role;

-- Organizations: your active org (covers the member-row-less resilience bridge),
-- orgs you're an active member of (the Hub), or superadmin.
drop policy if exists "orgs read" on public.organizations;
create policy "orgs read" on public.organizations for select using (
  public.app_is_superadmin()
  or id = public.app_active_org()
  or public.app_is_org_member(id)
);

-- Companies: members of the company's org (or your active org) only.
drop policy if exists "companies read" on public.companies;
create policy "companies read" on public.companies for select using (
  public.app_is_superadmin()
  or org_id = public.app_active_org()
  or public.app_is_org_member(org_id)
);

-- Leads read/update: scope the shared-pool branch to the caller's ACTIVE org, so
-- a dual-org member can't reach the OTHER org's leads while active in one.
drop policy if exists "leads read" on public.leads;
create policy "leads read" on public.leads for select using (
  public.app_is_superadmin() or (public.app_is_active() and (
    (owner_id = auth.uid() and (org_id is null or org_id = public.app_active_org()))
    or (org_id is not null and org_id = public.app_active_org() and public.app_is_org_member(org_id)))));

drop policy if exists "leads update" on public.leads;
create policy "leads update" on public.leads for update
  using (public.app_is_superadmin() or (public.app_is_active() and (
    (owner_id = auth.uid() and (org_id is null or org_id = public.app_active_org()))
    or (org_id is not null and org_id = public.app_active_org() and public.app_is_org_member(org_id)))))
  with check (public.app_is_superadmin() or (public.app_is_active() and (
    (owner_id = auth.uid() and (org_id is null or org_id = public.app_active_org()))
    or (org_id is not null and org_id = public.app_active_org() and public.app_is_org_member(org_id)))));

-- ═════════════════════════════════════════════════════════════════════════════
-- PART: DO-NOT-CALL / SUPPRESSION (P1). Kept in sync with supabase/dnc.sql.
-- Phone-number-level suppression per org, written on every do_not_call
-- disposition (and inbound SMS STOP) and scrubbed at every dial path + on import.
-- ═════════════════════════════════════════════════════════════════════════════
create table if not exists public.dnc_numbers (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references public.organizations (id) on delete cascade,
  phone_digits text not null,
  reason text,
  source text,
  created_by uuid,
  created_at timestamptz not null default now(),
  unique (org_id, phone_digits)
);
create index if not exists dnc_numbers_org_phone_idx
  on public.dnc_numbers (org_id, phone_digits);

alter table public.dnc_numbers enable row level security;
drop policy if exists "dnc read" on public.dnc_numbers;
create policy "dnc read" on public.dnc_numbers for select using (
  public.app_is_superadmin() or (public.app_is_active() and public.app_is_org_member(org_id))
);

-- ═════════════════════════════════════════════════════════════════════════════
-- PART: ATOMIC NOTIFICATION CLAIM (P3). Kept in sync with supabase/outbox-claim.sql.
-- Claims a batch of due notifications under FOR UPDATE SKIP LOCKED so the two
-- per-minute crons can't send the same appointment email twice; reclaims rows
-- stuck in 'sending' >5min (a crashed drain). Service-role only.
-- ═════════════════════════════════════════════════════════════════════════════
create or replace function public.app_claim_notifications(p_limit int)
returns setof public.notification_outbox
language sql volatile security definer set search_path = public as $$
  update public.notification_outbox o
  set status = 'sending', updated_at = now()
  from (
    select id
    from public.notification_outbox
    where (status = 'pending' and next_attempt_at <= now())
       or (status = 'sending' and updated_at < now() - interval '5 minutes')
    order by next_attempt_at asc
    limit greatest(p_limit, 0)
    for update skip locked
  ) picked
  where o.id = picked.id
  returning o.*;
$$;

revoke all on function public.app_claim_notifications(int) from public, anon, authenticated;
grant execute on function public.app_claim_notifications(int) to service_role;

-- ═════════════════════════════════════════════════════════════════════════════
-- Server-side leads page (P4.PAGINATE)
--
-- One round trip for the Leads tab: a filtered, upload-ordered page of rows
-- plus the filtered total, scope-wide KPI aggregates, and smart-list counts.
-- Lives in SQL because the supervisor scope is a two-source union (org pool +
-- the caller's pre-org rows) that PostgREST filter strings cannot paginate,
-- and because phone search / smart lists need digit-stripping regexes.
-- SERVICE-ROLE ONLY: trusts p_user/p_org/p_supervisor with no auth.uid()
-- check — the app computes them first (same trust model as app_upsert_presence).
-- ═════════════════════════════════════════════════════════════════════════════

create index if not exists leads_org_created_idx   on public.leads (org_id, created_at, id);
create index if not exists leads_owner_created_idx on public.leads (owner_id, created_at, id);

-- Every existing overload must be dropped before the CREATE: adding a parameter
-- OVERLOADS the function rather than replacing it, and two candidates make
-- PostgREST's rpc() resolution ambiguous once defaults are in play.
--
-- Done by INTROSPECTION rather than by listing signatures literally. The
-- literal-list version silently rotted every time a parameter was added — a
-- signature written by hand drifted out of order from the real parameter list
-- and the whole migration died on `42883: function ... does not exist`. This
-- form cannot drift: it drops whatever is actually there, whatever its shape.
do $$
declare r record;
begin
  for r in
    select p.oid::regprocedure as sig
    from pg_proc p
    join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'public' and p.proname = 'app_leads_page'
  loop
    execute format('drop function if exists %s', r.sig);
  end loop;
end $$;

create or replace function public.app_leads_page(
  p_org        uuid,
  p_user       uuid,
  p_supervisor boolean,
  p_q          text    default null,
  p_status     text    default null,
  p_group      text    default null,   -- group key; '__misc__' = ungrouped
  p_county     text    default null,   -- 'County|ST' composite; '__none__' = no county on file
  p_city       text    default null,   -- 'City|ST' composite;   '__none__' = no city on file
  p_campaign   text    default null,   -- campaign id; '__none__' = unassigned
  p_uploader   uuid    default null,
  p_mine       boolean default false,
  p_smart      text    default null,   -- smart-list id (src/lib/leads/smart-lists.ts)
  p_offset     integer default 0,
  p_limit      integer default 50,
  p_sort       text    default null,   -- whitelisted sort key; anything else = upload order
  p_dir        text    default 'asc'
) returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_limit  int  := least(greatest(coalesce(p_limit, 50), 1), 200);
  v_offset int  := greatest(coalesce(p_offset, 0), 0);
  -- STRICT sort whitelist — p_sort arrives from a URL param and this function
  -- trusts its callers, so anything unrecognized silently falls back to upload
  -- order. The key is only ever matched in CASE arms below, never interpolated.
  -- Mirrored in JS by filterLeadsPage (src/lib/db/leads.ts) — keep in lockstep.
  v_sort   text := case when p_sort in
    ('name', 'city', 'state', 'status', 'utility_bill', 'solar_payment',
     'ai_score', 'last_contacted_at', 'created_at')
    then p_sort else null end;
  v_desc   boolean := lower(coalesce(p_dir, 'asc')) = 'desc';
  -- Escape LIKE wildcards in the user's text; separate digits variant for phone.
  v_q      text := nullif(replace(replace(replace(btrim(coalesce(p_q, '')), '\', '\\'), '%', '\%'), '_', '\_'), '');
  v_digits text := nullif(regexp_replace(coalesce(p_q, ''), '\D', '', 'g'), '');
  v_rows   jsonb;
  v_total  bigint;
  v_stats  jsonb;
begin
  -- 1-2 digit fragments match everyone — ignore (mirrors the old client rule).
  if v_digits is not null and length(v_digits) < 3 then
    v_digits := null;
  end if;

  with scope as (
    select l.*, coalesce(m.name, '') as owner_name
    from public.leads l
    left join public.organization_members m
      on m.org_id = l.org_id and m.user_id = l.owner_id and m.status = 'active'
    where case
      when p_supervisor
        then (l.org_id = p_org or (l.owner_id = p_user and l.org_id is null))
      else (
        (l.owner_id = p_user or l.assigned_rep_id = p_user::text)
        and (p_org is null or l.org_id = p_org)
      )
    end
  ),
  filtered as (
    select * from scope
    where (p_status is null or status = p_status)
      and (p_group is null
           or (case when p_group = '__misc__' then lead_group is null
                    else lead_group = p_group end))
      and (p_county is null
           or (case when p_county = '__none__' then county is null
                    else coalesce(county || '|' || state, '') = p_county end))
      -- City is compared case- and whitespace-insensitively: unlike county
      -- (which this app derives itself from ZIP, so it is always spelled one
      -- way) city is free text straight off a customer CSV, where "Fresno",
      -- "fresno " and "FRESNO" are all the same place and must land in one
      -- bucket. Mirrors cityKey()/filterLeadsPage in src/lib/db/leads.ts.
      -- City and state are compared as two SEPARATE equalities rather than one
      -- concatenated key, so `lower(btrim(city))` appears standalone and can
      -- actually be served by leads_org_city_lower_idx — a concatenation would
      -- have made that index dead weight. Each side is trimmed independently
      -- (a stored "Fresno " yields the key "Fresno |CA", so trimming only the
      -- outside of the composite would match nothing). Mirrors
      -- normalizeCityKey() in src/lib/db/leads.ts — keep the two in lockstep.
      and (p_city is null
           or (case when p_city = '__none__' then coalesce(btrim(city), '') = ''
                    else lower(btrim(city)) = lower(btrim(split_part(p_city, '|', 1)))
                     and lower(btrim(coalesce(state, ''))) = lower(btrim(split_part(p_city, '|', 2)))
                    end))
      and (p_campaign is null
           or (case when p_campaign = '__none__' then coalesce(campaign_id, '') = ''
                    else campaign_id = p_campaign end))
      and (p_uploader is null or owner_id = p_uploader)
      and (not p_mine or owner_id = p_user or assigned_rep_id = p_user::text)
      and (p_smart is null or case p_smart
        when 'high_bill'       then coalesce(utility_bill, 0) >= 200
        when 'big_load'        then (has_ev or has_pool or has_battery or multiple_systems)
        when 'fresh'           then (status = 'new' and last_contacted_at is null)
        when 'going_cold'      then (status in ('new', 'no_answer', 'callback')
                                     and last_contacted_at is not null
                                     and last_contacted_at < now() - interval '14 days')
        -- Mirrors isValidPhone(): 10 digits, or 11 starting with 1.
        when 'no_phone'        then not (
                                     length(regexp_replace(coalesce(phone, ''), '\D', '', 'g')) = 10
                                     or (length(regexp_replace(coalesce(phone, ''), '\D', '', 'g')) = 11
                                         and regexp_replace(coalesce(phone, ''), '\D', '', 'g') like '1%'))
        when 'missing_address' then (coalesce(btrim(address), '') = '' and coalesce(btrim(city), '') = '')
        else true end)
      and (v_q is null or (
        (first_name || ' ' || last_name) ilike ('%' || v_q || '%')
        or city ilike ('%' || v_q || '%')
        or utility_provider ilike ('%' || v_q || '%')
        or (v_digits is not null
            and regexp_replace(coalesce(phone, ''), '\D', '', 'g') like ('%' || v_digits || '%'))
      ))
  ),
  -- The total is computed INDEPENDENTLY of pagination: taking max(count(*)
  -- over ()) inside the LIMIT/OFFSET subquery reported total=0 whenever the
  -- offset landed past the last matching row (stale ?page=N links, deleting
  -- the last row of the last page), making the whole book look empty.
  total as (
    select count(*) as n from filtered
  ),
  -- One window, six CASE lanes (text / numeric / time × asc / desc): only the
  -- lane matching the active sort+direction produces values; every other lane
  -- is all-null and a no-op. Nulls sort LAST in every lane (missing scores and
  -- never-contacted rows go to the bottom regardless of direction), and
  -- (created_at, id) always closes the ORDER BY so ties — and therefore pages —
  -- stay stable. With v_sort null that closing pair IS the default: upload
  -- order, the deliberate product default (see ORDERING in src/lib/db/leads.ts).
  page as (
    select s.row_json, s.rn
    from (
      select
        to_jsonb(f.*) as row_json,
        row_number() over (order by
          case when not v_desc then case v_sort
            when 'name'   then lower(coalesce(f.last_name, '') || ' ' || coalesce(f.first_name, ''))
            when 'city'   then lower(coalesce(f.city, ''))
            when 'state'  then lower(coalesce(f.state, ''))
            when 'status' then f.status
          end end asc nulls last,
          case when v_desc then case v_sort
            when 'name'   then lower(coalesce(f.last_name, '') || ' ' || coalesce(f.first_name, ''))
            when 'city'   then lower(coalesce(f.city, ''))
            when 'state'  then lower(coalesce(f.state, ''))
            when 'status' then f.status
          end end desc nulls last,
          case when not v_desc then case v_sort
            when 'utility_bill'  then f.utility_bill
            when 'solar_payment' then f.solar_payment
            when 'ai_score'      then f.ai_score::numeric
          end end asc nulls last,
          case when v_desc then case v_sort
            when 'utility_bill'  then f.utility_bill
            when 'solar_payment' then f.solar_payment
            when 'ai_score'      then f.ai_score::numeric
          end end desc nulls last,
          case when not v_desc then case v_sort
            when 'last_contacted_at' then f.last_contacted_at
            when 'created_at'        then f.created_at
          end end asc nulls last,
          case when v_desc then case v_sort
            when 'last_contacted_at' then f.last_contacted_at
            when 'created_at'        then f.created_at
          end end desc nulls last,
          f.created_at asc, f.id asc
        ) as rn
      from filtered f
    ) s
    order by s.rn
    limit v_limit offset v_offset
  )
  select
    coalesce((select jsonb_agg(row_json order by rn) from page), '[]'::jsonb),
    (select n from total)
  into v_rows, v_total;

  -- Scope-wide aggregates, deliberately UNfiltered: the KPI tiles and the
  -- smart-list chips describe the whole book, not the current filter.
  select jsonb_build_object(
    'total',        count(*),
    'qualified',    count(*) filter (where status in ('qualified', 'appointment')),
    'appointments', count(*) filter (where status = 'appointment'),
    'avgScore',     coalesce(round(avg(ai_score)), 0),
    'smart', jsonb_build_object(
      'high_bill',       count(*) filter (where coalesce(utility_bill, 0) >= 200),
      'big_load',        count(*) filter (where has_ev or has_pool or has_battery or multiple_systems),
      'fresh',           count(*) filter (where status = 'new' and last_contacted_at is null),
      'going_cold',      count(*) filter (where status in ('new', 'no_answer', 'callback')
                                          and last_contacted_at is not null
                                          and last_contacted_at < now() - interval '14 days'),
      'no_phone',        count(*) filter (where not (
                           length(regexp_replace(coalesce(phone, ''), '\D', '', 'g')) = 10
                           or (length(regexp_replace(coalesce(phone, ''), '\D', '', 'g')) = 11
                               and regexp_replace(coalesce(phone, ''), '\D', '', 'g') like '1%'))),
      'missing_address', count(*) filter (where coalesce(btrim(address), '') = '' and coalesce(btrim(city), '') = '')
    )
  )
  into v_stats
  from public.leads l
  where case
    when p_supervisor
      then (l.org_id = p_org or (l.owner_id = p_user and l.org_id is null))
    else (
      (l.owner_id = p_user or l.assigned_rep_id = p_user::text)
      and (p_org is null or l.org_id = p_org)
    )
  end;

  return jsonb_build_object('rows', v_rows, 'total', v_total, 'stats', v_stats);
end;
$$;

-- CREATE FUNCTION grants PUBLIC execute by default; this function trusts its
-- p_* scope params with no auth.uid() check, so it must only ever be reachable
-- via the service-role client. Applied by introspection for the same reason the
-- drop above is — a hand-written signature here drifts the moment a parameter
-- is added, and a drifted GRANT fails the migration with 42883 (or, worse,
-- silently leaves the function callable by `anon`).
do $$
declare r record;
begin
  for r in
    select p.oid::regprocedure as sig
    from pg_proc p
    join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'public' and p.proname = 'app_leads_page'
  loop
    execute format('revoke execute on function %s from public', r.sig);
    execute format('revoke execute on function %s from anon', r.sig);
    execute format('revoke execute on function %s from authenticated', r.sig);
    execute format('grant  execute on function %s to service_role', r.sig);
  end loop;
end $$;

-- ═════════════════════════════════════════════════════════════════════════════
-- Persisted call transcripts (P5.TRANSCRIPT)
--
-- The ElevenLabs webhook received the full turn array, fed it once into
-- analyzeConversation, and threw it away — so the call dashboard re-fetched
-- the transcript from the ElevenLabs API on every poll (even for long-ended
-- calls) and no other AI surface could ever see it.
-- Shape: [{ "role": "agent"|"user", "message": text, "secs": number|null }]
-- ═════════════════════════════════════════════════════════════════════════════
alter table public.ai_conversations
  add column if not exists transcript jsonb;

-- ═════════════════════════════════════════════════════════════════════════════
-- Campaign script A/B testing (P5.SCRIPTAB)
--
-- Campaigns gain two script slots; every human call record notes which variant
-- the rep was reading, so the campaign detail page can split performance by
-- script. A campaign with only script_a set runs single-script (no test).
-- ═════════════════════════════════════════════════════════════════════════════
alter table public.campaigns
  add column if not exists script_a text not null default '',
  add column if not exists script_b text not null default '';
alter table public.call_records
  add column if not exists script_variant text
  check (script_variant is null or script_variant in ('a', 'b'));

-- ═════════════════════════════════════════════════════════════════════════════
-- Custom lead fields (P6.FIELDS — the generic-dialer epic)
--
-- The fixed solar-era columns stay as typed "core slots" (templates relabel or
-- hide them); every other CSV column lands here, keyed by a normalized
-- snake_case version of its header, with values stored as the type the
-- importer detected (string | number | boolean).
-- ═════════════════════════════════════════════════════════════════════════════
alter table public.leads
  add column if not exists custom_fields jsonb not null default '{}'::jsonb;

-- ═════════════════════════════════════════════════════════════════════════════
-- Atomic custom-fields patch (P6 review fix)
--
-- The JS read-modify-write in updateLead loses keys when two requests patch
-- DIFFERENT keys on the same lead nearly concurrently (qualify-panel flushes
-- from two tabs, a rep + a manager editing). jsonb || and - are atomic within
-- the UPDATE. SERVICE-ROLE ONLY: the app authorizes (canActOn) before calling.
-- ═════════════════════════════════════════════════════════════════════════════
create or replace function public.app_patch_lead_custom_fields(
  p_lead   uuid,
  p_set    jsonb   default '{}'::jsonb,
  p_delete text[]  default '{}'::text[]
) returns void
language sql volatile
security definer
set search_path = public
as $$
  update public.leads
  set custom_fields =
    (coalesce(custom_fields, '{}'::jsonb) || coalesce(p_set, '{}'::jsonb))
    - coalesce(p_delete, '{}'::text[])
  where id = p_lead;
$$;

grant execute on function public.app_patch_lead_custom_fields(uuid, jsonb, text[]) to service_role;
revoke execute on function public.app_patch_lead_custom_fields(uuid, jsonb, text[]) from public;
revoke execute on function public.app_patch_lead_custom_fields(uuid, jsonb, text[]) from anon;
revoke execute on function public.app_patch_lead_custom_fields(uuid, jsonb, text[]) from authenticated;

-- ─────────────────────────────────────────────────────────────────────────────
-- PART 18 — LEAD PACK ASSIGNMENT  (idempotent; safe to re-run)
--
-- PART 17 cuts an upload into numbered packs; this hands one to a rep.
--
-- The pack was always the unit a manager wants to deal out ("Marcus takes packs
-- 1-5"), but nothing recorded WHO holds one — assignment lived only on the
-- individual leads, so there was no way to ask "what is Marcus holding?" or to
-- take a pack back when he went on leave.
--
-- Assignment is recorded on the pack AND mirrored onto its leads'
-- assigned_rep_id (which is what the dial queue actually reads). The pack row
-- is the paperwork; the lead stamps are what route the work.
-- ─────────────────────────────────────────────────────────────────────────────
alter table public.lead_packs add column if not exists assigned_to  uuid references auth.users (id) on delete set null;
alter table public.lead_packs add column if not exists assigned_by  uuid references auth.users (id) on delete set null;
alter table public.lead_packs add column if not exists assigned_at  timestamptz;
create index if not exists lead_packs_assigned_idx on public.lead_packs (assigned_to);

-- ─────────────────────────────────────────────────────────────────────────────
-- PART 19 — LEAD COUNTY  (idempotent; safe to re-run)
--
-- `county` is a plain geographic fact about a lead's address, computed
-- deterministically from its ZIP at insert time (see
-- src/lib/leads/zip-county.ts) — NOT an org-defined bucket like lead_groups,
-- and deliberately not folded into that table: lead_groups is capped at 40
-- curated, admin-described buckets meant for AI classification, and a
-- nationwide book can easily span more than 40 counties. County is filtered
-- independently, alongside lead_group, not instead of it.
--
-- Existing rows are backfilled from the app (POST /api/leads/backfill-county,
-- managers+), not here — a bulk UPDATE across every org's full history has no
-- place in a migration that's meant to be safe to re-run blind.
-- ─────────────────────────────────────────────────────────────────────────────
alter table public.leads add column if not exists county text;
create index if not exists leads_org_county_idx on public.leads (org_id, county) where county is not null;

-- City needs no column (it has always been on `leads`) — only an index, and a
-- case-folded one, because the city filter compares lower(btrim(city)) so that
-- "Fresno" / "fresno " / "FRESNO" off three different customer CSVs all match
-- one bucket. A plain (org_id, city) index cannot serve that predicate.
create index if not exists leads_org_city_lower_idx
  on public.leads (org_id, lower(btrim(city)))
  where coalesce(btrim(city), '') <> '';

-- ─────────────────────────────────────────────────────────────────────────────
-- PART 20 — PER-REP CALLER-ID ASSIGNMENT  (idempotent; safe to re-run)
--
-- Until now the caller-ID rotation pool (organizations.settings.dialing.
-- callerIds) was purely org-wide: every rep cycled through every number. This
-- lets an admin pin 1-2 specific numbers to a specific rep — that rep's power
-- dialer then rotates ONLY among their assigned numbers, while owner/admin/
-- manager keep unrestricted access to the whole pool (see restrictToAssigned-
-- Numbers in src/lib/dialer/rotation.ts, and the role check there — an
-- assignment on a non-rep row is simply never consulted).
--
-- A plain text[] on the membership row, not a join table: it mirrors the
-- existing dialing.callerIds array-in-settings pattern, needs no referential
-- integrity beyond "is a member of this org" (already enforced by the row
-- it lives on), and every read of it is already keyed by member id.
-- ─────────────────────────────────────────────────────────────────────────────
alter table public.organization_members
  add column if not exists caller_ids text[] not null default '{}';

-- ─────────────────────────────────────────────────────────────────────────────
-- PART 21 — THE CALL ARCHIVE  (idempotent; safe to re-run)
--
-- Transcripts and recordings existed but were effectively unfindable. A
-- transcript lived only on `ai_conversations.transcript` (jsonb), reachable
-- solely by opening one call at a time from an unfiltered, unsearchable list on
-- the Reports page; a rep who remembered "the guy who said he'd just renewed"
-- had no way to get back to that call at all. Rep notes were written to
-- `leads.notes` and overwrote each other, so the note from call #1 was gone by
-- the end of call #2 and no call record carried what was said on it.
--
-- Two columns fix both:
--
--   transcript_text — the turn array flattened to plain text at finalize time.
--     Deliberately DENORMALIZED from ai_conversations.transcript: the archive
--     searches and snippets this column, while the detail view still renders the
--     structured turns from the source of truth. One indexed text column beats
--     scanning jsonb across a join on every keystroke.
--
--   notes — the rep's own notes, ATTACHED TO THE CALL. leads.notes remains the
--     lead's current note (the dialer still writes it); this is the immutable
--     per-call record that makes "Lead → Call → Disposition → Notes" an actual
--     history rather than a single overwritten field.
--
-- pg_trgm powers the ILIKE '%…%' search. Without the GIN index every archive
-- query is a sequential scan over the org's whole call history.
-- ─────────────────────────────────────────────────────────────────────────────
create extension if not exists pg_trgm;

alter table public.call_records
  add column if not exists transcript_text text,
  add column if not exists notes           text;

-- Search: name / phone / summary / notes / transcript, all ILIKE-substring.
create index if not exists call_records_lead_name_trgm_idx
  on public.call_records using gin (lead_name gin_trgm_ops);
create index if not exists call_records_summary_trgm_idx
  on public.call_records using gin (summary gin_trgm_ops);
create index if not exists call_records_transcript_trgm_idx
  on public.call_records using gin (transcript_text gin_trgm_ops);
create index if not exists call_records_notes_trgm_idx
  on public.call_records using gin (notes gin_trgm_ops);

-- The archive's default ordering + org scope. The existing owner index serves a
-- rep's own view; a supervisor's org-wide view had no index at all.
create index if not exists call_records_org_started_idx
  on public.call_records (org_id, started_at desc);

-- "Has a recording" is a first-class filter, and a partial index keeps it cheap
-- on books where most calls never connected.
create index if not exists call_records_org_recording_idx
  on public.call_records (org_id, started_at desc)
  where recording_url is not null;

-- Backfill transcripts for calls finalized before this column existed, so the
-- archive is complete from day one rather than only forward-looking. Bounded
-- and idempotent: only rows that are still null, and only where a conversation
-- transcript actually exists.
update public.call_records cr
set transcript_text = sub.txt
from (
  select
    c.conversation_id,
    string_agg(
      case when t->>'role' = 'agent' then 'Agent: ' else 'Contact: ' end ||
        coalesce(t->>'message', ''),
      E'\n' order by t_ord
    ) as txt
  from public.ai_conversations c
  cross join lateral jsonb_array_elements(c.transcript) with ordinality as x(t, t_ord)
  where jsonb_typeof(c.transcript) = 'array'
  group by c.conversation_id
) sub
where cr.conversation_id = sub.conversation_id
  and cr.transcript_text is null
  and sub.txt is not null;

-- ═════════════════════════════════════════════════════════════════════════════
-- PART 22 — SERVICE TELEMETRY (ops_metrics)                       [Phase 1 · A2]
-- Counters and timings from src/lib/telemetry.ts: event lag, reservation
-- conflicts, webhook anomalies, import failures, metric drift. Service-role
-- writes only (RLS on, no policies — same posture as notification_outbox).
-- Trend data, not billing data: rows are disposable; a retention sweep may
-- delete anything older than 30 days.
-- Rollback: drop table public.ops_metrics; (the writer is fire-and-forget and
-- tolerates the table's absence).
-- ═════════════════════════════════════════════════════════════════════════════
create table if not exists public.ops_metrics (
  id     bigint generated always as identity primary key,
  at     timestamptz not null default now(),
  org_id uuid,
  metric text not null,
  value  numeric not null default 1,
  tags   jsonb
);
create index if not exists ops_metrics_metric_at_idx on public.ops_metrics (metric, at desc);
alter table public.ops_metrics enable row level security;

-- ═════════════════════════════════════════════════════════════════════════════
-- PART 23 — CANONICAL CALL ATTEMPTS, LEGS, EVENTS            [Phase 1 · B2]
-- The business-level attempt (one per lead per dial decision), its provider
-- legs (parallel dialing creates many), and an immutable, idempotent event log.
-- call_records remains the reporting projection; these are the source of truth.
-- See docs/phase-1/call-state-machine.md for the transition rules.
-- Rollback: drop trigger call_events_immutable on public.call_events;
--           drop function public.app_call_events_immutable();
--           drop table public.call_events, public.call_legs, public.call_attempts;
-- ═════════════════════════════════════════════════════════════════════════════
create table if not exists public.call_attempts (
  id                uuid primary key default gen_random_uuid(),
  org_id            uuid references public.organizations (id) on delete cascade,
  lead_id           uuid references public.leads (id) on delete set null,
  owner_id          uuid references auth.users (id) on delete set null,
  campaign_id       text,
  channel           text not null default 'human',      -- 'human' | 'ai'
  dial_mode         text not null default 'manual',     -- 'manual'|'parallel'|'ai_interactive'|'ai_cron'
  client_attempt_id text,                               -- idempotency key minted by the dialer client
  room              text,                               -- hc-<id> conference (human path)
  conversation_id   text,                               -- ElevenLabs conversation (AI path)
  phone             text not null default '',
  state             text not null default 'queued',
  -- queued|reserved|dialing|ringing|human_connected|voicemail_connected|busy|
  -- declined|no_answer|failed|canceled|wrap_up|dispositioned|completed
  state_changed_at  timestamptz not null default now(),
  reserved_at       timestamptz,
  dialing_at        timestamptz,
  ringing_at        timestamptz,
  connected_at      timestamptz,
  ended_at          timestamptz,
  wrap_started_at   timestamptz,
  dispositioned_at  timestamptz,
  transport_outcome text,   -- canonical terminal transport state, stamped once
  terminal_reason   text,   -- RAW provider reason (busy|no-answer|failed|error code…)
  disposition       text,   -- business CallOutcome key once filed — never overwrites transport_outcome
  call_record_id    uuid references public.call_records (id) on delete set null,
  created_at        timestamptz not null default now()
);
create unique index if not exists call_attempts_client_key
  on public.call_attempts (org_id, client_attempt_id) where client_attempt_id is not null;
-- NOT unique: a parallel (3X) round dials three leads into ONE room — three
-- attempts share the room, resolved by (room, lead_id). The status callback URL
-- carries both.
create unique index if not exists call_attempts_room_lead_key
  on public.call_attempts (room, lead_id) where room is not null and lead_id is not null;
create index if not exists call_attempts_room_idx
  on public.call_attempts (room) where room is not null;
create unique index if not exists call_attempts_convo_key
  on public.call_attempts (conversation_id) where conversation_id is not null;
create index if not exists call_attempts_org_created_idx on public.call_attempts (org_id, created_at desc);
create index if not exists call_attempts_lead_idx        on public.call_attempts (lead_id, created_at desc);
create index if not exists call_attempts_live_idx        on public.call_attempts (org_id, state, state_changed_at)
  where state in ('queued','reserved','dialing','ringing','human_connected','voicemail_connected','wrap_up');

create table if not exists public.call_legs (
  id              uuid primary key default gen_random_uuid(),
  attempt_id      uuid not null references public.call_attempts (id) on delete cascade,
  org_id          uuid,
  provider        text not null default 'twilio',
  provider_sid    text,                                 -- Twilio CallSid
  lead_id         uuid,                                 -- parallel: which lead this leg dialed
  role            text not null default 'customer',     -- 'customer' | 'rep' | 'agent'
  status          text,                                 -- last raw provider status
  answered_by     text,                                 -- AMD verdict when present
  error_code      int,
  ring_started_at timestamptz,
  answered_at     timestamptz,
  ended_at        timestamptz,
  created_at      timestamptz not null default now()
);
create unique index if not exists call_legs_provider_sid_key
  on public.call_legs (provider, provider_sid) where provider_sid is not null;
create index if not exists call_legs_attempt_idx on public.call_legs (attempt_id);

create table if not exists public.call_events (
  id                bigint generated always as identity primary key,
  org_id            uuid,
  attempt_id        uuid references public.call_attempts (id) on delete cascade,
  leg_id            uuid references public.call_legs (id) on delete set null,
  source            text not null,        -- 'twilio' | 'elevenlabs' | 'app' | 'rep' | 'cron'
  event_type        text not null,        -- canonical type (src/lib/calls/state-machine.ts)
  provider_event_id text,                 -- dedupe fingerprint (providerEventFingerprint)
  event_time        timestamptz not null default now(), -- provider clock when known
  ingested_at       timestamptz not null default now(),
  payload           jsonb not null default '{}'::jsonb,
  payload_version   int not null default 1
);
create unique index if not exists call_events_provider_key
  on public.call_events (source, provider_event_id) where provider_event_id is not null;
create index if not exists call_events_attempt_idx  on public.call_events (attempt_id, event_time);
create index if not exists call_events_org_time_idx on public.call_events (org_id, ingested_at desc);

-- Immutability: append-only. Blocks UPDATE/DELETE even from the service role —
-- raw provider history can be enriched elsewhere but never rewritten.
create or replace function public.app_call_events_immutable() returns trigger
language plpgsql as $fn$ begin raise exception 'call_events is append-only'; end $fn$;
drop trigger if exists call_events_immutable on public.call_events;
create trigger call_events_immutable
  before update or delete on public.call_events
  for each row execute function public.app_call_events_immutable();

-- RLS: service-role writes; org members may read their own org's rows.
alter table public.call_attempts enable row level security;
alter table public.call_legs     enable row level security;
alter table public.call_events   enable row level security;
drop policy if exists "attempts org read" on public.call_attempts;
create policy "attempts org read" on public.call_attempts for select using (
  public.app_is_superadmin() or (public.app_is_active() and public.app_is_org_member(org_id))
);
drop policy if exists "legs org read" on public.call_legs;
create policy "legs org read" on public.call_legs for select using (
  public.app_is_superadmin() or (public.app_is_active() and public.app_is_org_member(org_id))
);
drop policy if exists "events org read" on public.call_events;
create policy "events org read" on public.call_events for select using (
  public.app_is_superadmin() or (public.app_is_active() and public.app_is_org_member(org_id))
);

-- ═════════════════════════════════════════════════════════════════════════════
-- PART 24 — CALL RECORD IDEMPOTENCY + CONNECT PROJECTION      [Phase 1 · B2]
-- The duplicate-disposition bug: the client outbox replays any POST whose
-- response was lost, and insertCallRecord was a bare INSERT — every replay of a
-- successful-but-unacknowledged save created a duplicate call_records row AND a
-- duplicate appointment/callback via routeDisposition. Three partial unique
-- keys make the projection idempotent; the app recovers the existing row on
-- 23505 and skips routing.
-- Dedupe BEFORE the indexes: existing duplicates are ARCHIVED (never deleted
-- outright) to call_records_dupes — keep that table >= 30 days.
-- Rollback: drop the three unique indexes; restore with
--   insert into public.call_records select * from public.call_records_dupes
--   on conflict do nothing;
-- ═════════════════════════════════════════════════════════════════════════════
alter table public.call_records add column if not exists attempt_id        uuid;
alter table public.call_records add column if not exists client_attempt_id text;
-- ── Two columns NOTHING WRITES, deliberately ────────────────────────────────
--
-- Measured 2026-08-30: 0 non-null of 34,079 rows for each, and grep across the
-- application finds only reads. That is not an oversight to fix by stamping
-- something plausible into them — it is what the data honestly supports today,
-- and it is written down here so the next reader does not assume otherwise.
--
--   human_connected — "did a PERSON pick up". Distinguishing a person from an
--     answering machine needs AMD, which is off: call_legs.answered_by is null
--     on all 893 rows. Every consumer coalesces to the outcome-based definition
--     instead (see isConnectedRecord, and touches_v below). Writing this column
--     from anything weaker would be worse than leaving it null, because the
--     column's whole value is that it OVERRIDES the inference — 359 of 430
--     "answered" attempts here are dispositioned no_answer, which is what
--     voicemail pickups counted as answers looks like.
--
--   talk_sec — conversation seconds, as opposed to call seconds. Nothing on
--     either channel reports it. Consumers fall back to duration_sec, which
--     counts ring and voicemail time; the glossary entry for talk_time_total
--     says so in the tooltip a user actually reads, rather than presenting the
--     proxy as the measurement.
--
-- To populate them, in order: enable AMD and persist Twilio's AnsweredBy to
-- call_legs.answered_by; add a greeting-to-bridge timestamp; then backfill
-- forward-only, never over the 34,079 existing rows, which cannot be recovered.
alter table public.call_records add column if not exists human_connected   boolean;
alter table public.call_records add column if not exists talk_sec          int;

create table if not exists public.call_records_dupes
  (like public.call_records including defaults);
alter table public.call_records_dupes enable row level security;

-- Archive-then-delete duplicate conversation rows (best row wins: an outcome
-- beats none, then earliest started_at). Idempotent: re-running finds nothing.
with ranked as (
  select id, row_number() over (
    partition by conversation_id
    order by (outcome is not null) desc, started_at asc, id asc
  ) rn
  from public.call_records where conversation_id is not null
), moved as (
  insert into public.call_records_dupes
  select cr.* from public.call_records cr
  join ranked r on r.id = cr.id where r.rn > 1
  returning id
)
delete from public.call_records where id in (select id from moved);

-- Same for duplicate room rows (a replayed manual disposition).
with ranked as (
  select id, row_number() over (
    partition by room
    order by (outcome is not null) desc, started_at asc, id asc
  ) rn
  from public.call_records where room is not null
), moved as (
  insert into public.call_records_dupes
  select cr.* from public.call_records cr
  join ranked r on r.id = cr.id where r.rn > 1
  returning id
)
delete from public.call_records where id in (select id from moved);

create unique index if not exists call_records_client_attempt_key
  on public.call_records (org_id, client_attempt_id) where client_attempt_id is not null;
create unique index if not exists call_records_room_key
  on public.call_records (room) where room is not null;
create unique index if not exists call_records_conversation_key
  on public.call_records (conversation_id) where conversation_id is not null;
create index if not exists call_records_attempt_idx
  on public.call_records (attempt_id) where attempt_id is not null;

-- ═════════════════════════════════════════════════════════════════════════════
-- PART 25 — LEAD RESERVATION + ATTEMPT COUNTERS               [Phase 1 · B3]
-- The eligibility/reservation engine. Reservation state lives ON the lead
-- (single-row CAS, no join in the hot path); claims are atomic via
-- FOR UPDATE SKIP LOCKED (the app_claim_notifications pattern); expiry is a
-- timestamp comparison, so expired holds are simply claimable — no sweeper.
-- TS twin: src/lib/dialer/eligibility.ts — LOCKSTEP: keep the WHERE clause and
-- ORDER BY in sync with evaluateEligibility/compareDialOrder.
-- Rollback: drop the four app_*_dial_* functions + leads_dial_order_idx; the
-- columns may stay (harmless); clearing reserved_by/reserved_until restores
-- legacy behavior instantly, as does settings.dialing.reservations=false.
-- ═════════════════════════════════════════════════════════════════════════════
alter table public.leads add column if not exists attempt_count    int not null default 0;
alter table public.leads add column if not exists last_attempt_at  timestamptz;
alter table public.leads add column if not exists next_eligible_at timestamptz;
alter table public.leads add column if not exists reserved_by      uuid;
alter table public.leads add column if not exists reserved_until   timestamptz;

-- Backfill counters from history. Idempotent: only rows still at zero.
update public.leads l
set attempt_count = h.n, last_attempt_at = h.latest
from (
  select lead_id, count(*)::int as n, max(started_at) as latest
  from public.call_records where lead_id is not null group by lead_id
) h
where l.id = h.lead_id and l.attempt_count = 0;

-- Never-dialed-first queue order in one index: attempt_count ascending puts
-- the untouched (0) leads strictly first; ties then oldest-attempted first.
create index if not exists leads_dial_order_idx
  on public.leads (org_id, attempt_count asc, last_attempt_at asc nulls first, created_at asc, id asc)
  where status in ('new','no_answer','callback');

-- ── Atomic claim. SERVICE-ROLE ONLY (same trust model as app_leads_page): the
-- app validates the caller and sanitizes p_statuses ('dnc' can never pass).
-- LOCKSTEP: WHERE mirrors evaluateEligibility, ORDER BY mirrors compareDialOrder
-- (src/lib/dialer/eligibility.ts). The per-lead-timezone calling-window check
-- lives in TS (area-code inference isn't in SQL) — claimDialLeads re-checks and
-- releases out-of-window leads.
-- PART 25b: p_preserve_order picks candidates in the CALLER's list order —
-- the server half of the dialer queue-fidelity fix (claims used to ignore the
-- rep's loaded queue entirely). Signature changed, so re-applying on a live DB
-- must DROP the old 11-arg overload first (see the PART 25b migration).
drop function if exists public.app_claim_dial_leads(uuid, uuid, boolean, int, int, text[], text, uuid, int, int, uuid[]);
create or replace function public.app_claim_dial_leads(
  p_org uuid, p_user uuid, p_supervisor boolean,
  p_limit int, p_ttl_seconds int default 180,
  p_statuses text[] default array['new','no_answer','callback'],
  p_campaign text default null, p_pack uuid default null,
  p_cooldown_minutes int default 0, p_max_attempts int default 0,
  p_lead_ids uuid[] default null,
  p_preserve_order boolean default false
) returns setof public.leads
language sql volatile security definer set search_path = public as $$
  update public.leads l
  set reserved_by = p_user,
      reserved_until = now() + make_interval(secs => greatest(coalesce(p_ttl_seconds, 180), 30))
  from (
    select x.id from public.leads x
    where x.org_id = p_org
      and x.status = any(p_statuses)
      and (p_supervisor or x.owner_id = p_user or x.assigned_rep_id = p_user::text)
      and (p_campaign is null or x.campaign_id = p_campaign)
      and (p_pack is null or x.lead_pack_id = p_pack)
      and (p_lead_ids is null or x.id = any(p_lead_ids))
      and length(regexp_replace(coalesce(x.phone, ''), '\D', '', 'g')) >= 10
      and not exists (
        select 1 from public.dnc_numbers d
        where d.org_id = p_org
          and d.phone_digits = right(regexp_replace(coalesce(x.phone, ''), '\D', '', 'g'), 10))
      and (x.reserved_until is null or x.reserved_until < now() or x.reserved_by = p_user)
      and (x.next_eligible_at is null or x.next_eligible_at <= now())
      and (p_cooldown_minutes <= 0 or x.last_attempt_at is null
           or x.last_attempt_at < now() - make_interval(mins => p_cooldown_minutes))
      and (p_max_attempts <= 0 or x.attempt_count < p_max_attempts)
    order by
      case when p_preserve_order and p_lead_ids is not null
           then array_position(p_lead_ids, x.id) end asc nulls last,
      x.attempt_count asc,
      x.last_attempt_at asc nulls first,
      x.created_at asc, x.id asc
    limit greatest(coalesce(p_limit, 0), 0)
    for update skip locked
  ) picked
  where l.id = picked.id
  returning l.*;
$$;
revoke all on function public.app_claim_dial_leads(uuid, uuid, boolean, int, int, text[], text, uuid, int, int, uuid[], boolean) from public, anon, authenticated;
grant execute on function public.app_claim_dial_leads(uuid, uuid, boolean, int, int, text[], text, uuid, int, int, uuid[], boolean) to service_role;

create or replace function public.app_release_dial_leads(
  p_org uuid, p_user uuid, p_lead_ids uuid[]
) returns int language sql volatile security definer set search_path = public as $$
  with r as (
    update public.leads set reserved_by = null, reserved_until = null
    where org_id = p_org and reserved_by = p_user and id = any(p_lead_ids)
    returning id
  )
  select count(*)::int from r;
$$;
revoke all on function public.app_release_dial_leads(uuid, uuid, uuid[]) from public, anon, authenticated;
grant execute on function public.app_release_dial_leads(uuid, uuid, uuid[]) to service_role;

create or replace function public.app_renew_dial_reservations(
  p_org uuid, p_user uuid, p_lead_ids uuid[], p_ttl_seconds int
) returns int language sql volatile security definer set search_path = public as $$
  with r as (
    update public.leads
    set reserved_until = now() + make_interval(secs => greatest(coalesce(p_ttl_seconds, 180), 30))
    where org_id = p_org and reserved_by = p_user and id = any(p_lead_ids)
      and reserved_until > now()   -- an expired hold cannot be revived
    returning id
  )
  select count(*)::int from r;
$$;
revoke all on function public.app_renew_dial_reservations(uuid, uuid, uuid[], int) from public, anon, authenticated;
grant execute on function public.app_renew_dial_reservations(uuid, uuid, uuid[], int) to service_role;

-- Stamp the attempt at provider initiation: bump the counter, record the time,
-- set the next-eligible gate, release the hold. last_contacted_at is untouched
-- (it means "disposition filed" — a different fact).
create or replace function public.app_mark_lead_attempted(
  p_org uuid, p_lead uuid, p_at timestamptz, p_next_eligible timestamptz
) returns void language sql volatile security definer set search_path = public as $$
  update public.leads
  set attempt_count = attempt_count + 1,
      last_attempt_at = greatest(coalesce(last_attempt_at, p_at), p_at),
      next_eligible_at = p_next_eligible,
      reserved_by = null, reserved_until = null
  where id = p_lead and org_id = p_org;
$$;
revoke all on function public.app_mark_lead_attempted(uuid, uuid, timestamptz, timestamptz) from public, anon, authenticated;
grant execute on function public.app_mark_lead_attempted(uuid, uuid, timestamptz, timestamptz) to service_role;

notify pgrst, 'reload schema';

-- ═════════════════════════════════════════════════════════════════════════════
-- PART 26 — app_leads_page RECREATE: Average-AI-Score aggregate removed  [B4]
-- The spec (docs/phase_one.md §4) removes the "Average AI Score" aggregate.
-- Per-lead ai_score is retained (dial ordering, per-lead display, export
-- column); only the avgScore stat dies, replaced by neverDialed — the count
-- the leads KPI row actually needs. Everything else in the function is
-- byte-identical to the PART above; the drop/grant-by-introspection blocks
-- are reused verbatim.
-- Rollback: re-apply the previous function body from git history.
-- ═════════════════════════════════════════════════════════════════════════════
-- Every existing overload must be dropped before the CREATE: adding a parameter
-- OVERLOADS the function rather than replacing it, and two candidates make
-- PostgREST's rpc() resolution ambiguous once defaults are in play.
--
-- Done by INTROSPECTION rather than by listing signatures literally. The
-- literal-list version silently rotted every time a parameter was added — a
-- signature written by hand drifted out of order from the real parameter list
-- and the whole migration died on `42883: function ... does not exist`. This
-- form cannot drift: it drops whatever is actually there, whatever its shape.
do $$
declare r record;
begin
  for r in
    select p.oid::regprocedure as sig
    from pg_proc p
    join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'public' and p.proname = 'app_leads_page'
  loop
    execute format('drop function if exists %s', r.sig);
  end loop;
end $$;

create or replace function public.app_leads_page(
  p_org        uuid,
  p_user       uuid,
  p_supervisor boolean,
  p_q          text    default null,
  p_status     text    default null,
  p_group      text    default null,   -- group key; '__misc__' = ungrouped
  p_county     text    default null,   -- 'County|ST' composite; '__none__' = no county on file
  p_city       text    default null,   -- 'City|ST' composite;   '__none__' = no city on file
  p_campaign   text    default null,   -- campaign id; '__none__' = unassigned
  p_uploader   uuid    default null,
  p_mine       boolean default false,
  p_smart      text    default null,   -- smart-list id (src/lib/leads/smart-lists.ts)
  p_offset     integer default 0,
  p_limit      integer default 50,
  p_sort       text    default null,   -- whitelisted sort key; anything else = upload order
  p_dir        text    default 'asc'
) returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_limit  int  := least(greatest(coalesce(p_limit, 50), 1), 200);
  v_offset int  := greatest(coalesce(p_offset, 0), 0);
  -- STRICT sort whitelist — p_sort arrives from a URL param and this function
  -- trusts its callers, so anything unrecognized silently falls back to upload
  -- order. The key is only ever matched in CASE arms below, never interpolated.
  -- Mirrored in JS by filterLeadsPage (src/lib/db/leads.ts) — keep in lockstep.
  v_sort   text := case when p_sort in
    ('name', 'city', 'state', 'status', 'utility_bill', 'solar_payment',
     'ai_score', 'last_contacted_at', 'created_at')
    then p_sort else null end;
  v_desc   boolean := lower(coalesce(p_dir, 'asc')) = 'desc';
  -- Escape LIKE wildcards in the user's text; separate digits variant for phone.
  v_q      text := nullif(replace(replace(replace(btrim(coalesce(p_q, '')), '\', '\\'), '%', '\%'), '_', '\_'), '');
  v_digits text := nullif(regexp_replace(coalesce(p_q, ''), '\D', '', 'g'), '');
  v_rows   jsonb;
  v_total  bigint;
  v_stats  jsonb;
begin
  -- 1-2 digit fragments match everyone — ignore (mirrors the old client rule).
  if v_digits is not null and length(v_digits) < 3 then
    v_digits := null;
  end if;

  with scope as (
    select l.*, coalesce(m.name, '') as owner_name
    from public.leads l
    left join public.organization_members m
      on m.org_id = l.org_id and m.user_id = l.owner_id and m.status = 'active'
    where case
      when p_supervisor
        then (l.org_id = p_org or (l.owner_id = p_user and l.org_id is null))
      else (
        (l.owner_id = p_user or l.assigned_rep_id = p_user::text)
        and (p_org is null or l.org_id = p_org)
      )
    end
  ),
  filtered as (
    select * from scope
    where (p_status is null or status = p_status)
      and (p_group is null
           or (case when p_group = '__misc__' then lead_group is null
                    else lead_group = p_group end))
      and (p_county is null
           or (case when p_county = '__none__' then county is null
                    else coalesce(county || '|' || state, '') = p_county end))
      -- City is compared case- and whitespace-insensitively: unlike county
      -- (which this app derives itself from ZIP, so it is always spelled one
      -- way) city is free text straight off a customer CSV, where "Fresno",
      -- "fresno " and "FRESNO" are all the same place and must land in one
      -- bucket. Mirrors cityKey()/filterLeadsPage in src/lib/db/leads.ts.
      -- City and state are compared as two SEPARATE equalities rather than one
      -- concatenated key, so `lower(btrim(city))` appears standalone and can
      -- actually be served by leads_org_city_lower_idx — a concatenation would
      -- have made that index dead weight. Each side is trimmed independently
      -- (a stored "Fresno " yields the key "Fresno |CA", so trimming only the
      -- outside of the composite would match nothing). Mirrors
      -- normalizeCityKey() in src/lib/db/leads.ts — keep the two in lockstep.
      and (p_city is null
           or (case when p_city = '__none__' then coalesce(btrim(city), '') = ''
                    else lower(btrim(city)) = lower(btrim(split_part(p_city, '|', 1)))
                     and lower(btrim(coalesce(state, ''))) = lower(btrim(split_part(p_city, '|', 2)))
                    end))
      and (p_campaign is null
           or (case when p_campaign = '__none__' then coalesce(campaign_id, '') = ''
                    else campaign_id = p_campaign end))
      and (p_uploader is null or owner_id = p_uploader)
      and (not p_mine or owner_id = p_user or assigned_rep_id = p_user::text)
      and (p_smart is null or case p_smart
        when 'high_bill'       then coalesce(utility_bill, 0) >= 200
        when 'big_load'        then (has_ev or has_pool or has_battery or multiple_systems)
        when 'fresh'           then (status = 'new' and last_contacted_at is null)
        when 'going_cold'      then (status in ('new', 'no_answer', 'callback')
                                     and last_contacted_at is not null
                                     and last_contacted_at < now() - interval '14 days')
        -- Mirrors isValidPhone(): 10 digits, or 11 starting with 1.
        when 'no_phone'        then not (
                                     length(regexp_replace(coalesce(phone, ''), '\D', '', 'g')) = 10
                                     or (length(regexp_replace(coalesce(phone, ''), '\D', '', 'g')) = 11
                                         and regexp_replace(coalesce(phone, ''), '\D', '', 'g') like '1%'))
        when 'missing_address' then (coalesce(btrim(address), '') = '' and coalesce(btrim(city), '') = '')
        else true end)
      and (v_q is null or (
        (first_name || ' ' || last_name) ilike ('%' || v_q || '%')
        or city ilike ('%' || v_q || '%')
        or utility_provider ilike ('%' || v_q || '%')
        or (v_digits is not null
            and regexp_replace(coalesce(phone, ''), '\D', '', 'g') like ('%' || v_digits || '%'))
      ))
  ),
  -- The total is computed INDEPENDENTLY of pagination: taking max(count(*)
  -- over ()) inside the LIMIT/OFFSET subquery reported total=0 whenever the
  -- offset landed past the last matching row (stale ?page=N links, deleting
  -- the last row of the last page), making the whole book look empty.
  total as (
    select count(*) as n from filtered
  ),
  -- One window, six CASE lanes (text / numeric / time × asc / desc): only the
  -- lane matching the active sort+direction produces values; every other lane
  -- is all-null and a no-op. Nulls sort LAST in every lane (missing scores and
  -- never-contacted rows go to the bottom regardless of direction), and
  -- (created_at, id) always closes the ORDER BY so ties — and therefore pages —
  -- stay stable. With v_sort null that closing pair IS the default: upload
  -- order, the deliberate product default (see ORDERING in src/lib/db/leads.ts).
  page as (
    select s.row_json, s.rn
    from (
      select
        to_jsonb(f.*) as row_json,
        row_number() over (order by
          case when not v_desc then case v_sort
            when 'name'   then lower(coalesce(f.last_name, '') || ' ' || coalesce(f.first_name, ''))
            when 'city'   then lower(coalesce(f.city, ''))
            when 'state'  then lower(coalesce(f.state, ''))
            when 'status' then f.status
          end end asc nulls last,
          case when v_desc then case v_sort
            when 'name'   then lower(coalesce(f.last_name, '') || ' ' || coalesce(f.first_name, ''))
            when 'city'   then lower(coalesce(f.city, ''))
            when 'state'  then lower(coalesce(f.state, ''))
            when 'status' then f.status
          end end desc nulls last,
          case when not v_desc then case v_sort
            when 'utility_bill'  then f.utility_bill
            when 'solar_payment' then f.solar_payment
            when 'ai_score'      then f.ai_score::numeric
          end end asc nulls last,
          case when v_desc then case v_sort
            when 'utility_bill'  then f.utility_bill
            when 'solar_payment' then f.solar_payment
            when 'ai_score'      then f.ai_score::numeric
          end end desc nulls last,
          case when not v_desc then case v_sort
            when 'last_contacted_at' then f.last_contacted_at
            when 'created_at'        then f.created_at
          end end asc nulls last,
          case when v_desc then case v_sort
            when 'last_contacted_at' then f.last_contacted_at
            when 'created_at'        then f.created_at
          end end desc nulls last,
          f.created_at asc, f.id asc
        ) as rn
      from filtered f
    ) s
    order by s.rn
    limit v_limit offset v_offset
  )
  select
    coalesce((select jsonb_agg(row_json order by rn) from page), '[]'::jsonb),
    (select n from total)
  into v_rows, v_total;

  -- Scope-wide aggregates, deliberately UNfiltered: the KPI tiles and the
  -- smart-list chips describe the whole book, not the current filter.
  select jsonb_build_object(
    'total',        count(*),
    'qualified',    count(*) filter (where status in ('qualified', 'appointment')),
    'appointments', count(*) filter (where status = 'appointment'),
    'neverDialed',  count(*) filter (where attempt_count = 0 and last_contacted_at is null and status in ('new', 'no_answer', 'callback')),
    'smart', jsonb_build_object(
      'high_bill',       count(*) filter (where coalesce(utility_bill, 0) >= 200),
      'big_load',        count(*) filter (where has_ev or has_pool or has_battery or multiple_systems),
      'fresh',           count(*) filter (where status = 'new' and last_contacted_at is null),
      'going_cold',      count(*) filter (where status in ('new', 'no_answer', 'callback')
                                          and last_contacted_at is not null
                                          and last_contacted_at < now() - interval '14 days'),
      'no_phone',        count(*) filter (where not (
                           length(regexp_replace(coalesce(phone, ''), '\D', '', 'g')) = 10
                           or (length(regexp_replace(coalesce(phone, ''), '\D', '', 'g')) = 11
                               and regexp_replace(coalesce(phone, ''), '\D', '', 'g') like '1%'))),
      'missing_address', count(*) filter (where coalesce(btrim(address), '') = '' and coalesce(btrim(city), '') = '')
    )
  )
  into v_stats
  from public.leads l
  where case
    when p_supervisor
      then (l.org_id = p_org or (l.owner_id = p_user and l.org_id is null))
    else (
      (l.owner_id = p_user or l.assigned_rep_id = p_user::text)
      and (p_org is null or l.org_id = p_org)
    )
  end;

  return jsonb_build_object('rows', v_rows, 'total', v_total, 'stats', v_stats);
end;
$$;

-- CREATE FUNCTION grants PUBLIC execute by default; this function trusts its
-- p_* scope params with no auth.uid() check, so it must only ever be reachable
-- via the service-role client. Applied by introspection for the same reason the
-- drop above is — a hand-written signature here drifts the moment a parameter
-- is added, and a drifted GRANT fails the migration with 42883 (or, worse,
-- silently leaves the function callable by `anon`).
do $$
declare r record;
begin
  for r in
    select p.oid::regprocedure as sig
    from pg_proc p
    join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'public' and p.proname = 'app_leads_page'
  loop
    execute format('revoke execute on function %s from public', r.sig);
    execute format('revoke execute on function %s from anon', r.sig);
    execute format('revoke execute on function %s from authenticated', r.sig);
    execute format('grant  execute on function %s to service_role', r.sig);
  end loop;
end $$;

notify pgrst, 'reload schema';

-- ═════════════════════════════════════════════════════════════════════════════
-- PART 27 — SHARED METRICS AGGREGATES                          [Phase 1 · B4]
-- One SQL source for the numbers every surface shows, replacing per-surface
-- 50k-row JS aggregation. Definitions live in src/lib/metrics/definitions.ts
-- (the glossary as code) and docs/phase-1/metric-glossary.md — the TS compute
-- twin (src/lib/metrics/compute.ts) must agree with these FILTER clauses.
-- SERVICE-ROLE ONLY: trusts p_user/p_org/p_supervisor, same as app_leads_page.
-- Rollback: drop function public.app_metrics_summary, public.app_metrics_hourly.
-- ═════════════════════════════════════════════════════════════════════════════
create or replace function public.app_metrics_summary(
  p_org uuid, p_user uuid, p_supervisor boolean,
  p_from timestamptz, p_to timestamptz,
  p_campaign text default null, p_rep uuid default null, p_channel text default null
) returns jsonb
language sql stable security definer set search_path = public as $$
  with rows as (
    select * from public.call_records cr
    where cr.started_at >= p_from and cr.started_at < p_to
      and case when p_supervisor
            then (cr.org_id = p_org or (cr.owner_id = p_user and cr.org_id is null))
            else (cr.owner_id = p_user and (cr.org_id = p_org or cr.org_id is null))
          end
      and (p_campaign is null or cr.campaign_id = p_campaign)
      and (p_rep is null or cr.owner_id = p_rep)
      and (p_channel is null or coalesce(cr.channel, 'human') = p_channel)
  ),
  agg as (
    select
      count(*) as calls,
      -- System failures (provider refused before anyone was reached) are
      -- excluded from the connect-rate denominator — glossary: connect_rate.
      count(*) filter (where failure_kind is not null and outcome is null) as system_failures,
      -- Canonical connect: the human_connected projection when stamped, else
      -- the legacy outcome-based inference — glossary: human_connects.
      count(*) filter (where coalesce(human_connected,
        outcome in ('appointment_booked','callback_scheduled','qualified',
                    'not_interested','do_not_call'))) as connects,
      count(*) filter (where outcome = 'voicemail') as voicemails,
      sum(coalesce(talk_sec, duration_sec)) filter (where coalesce(human_connected,
        outcome in ('appointment_booked','callback_scheduled','qualified',
                    'not_interested','do_not_call'))) as talk_secs
    from rows
  )
  select jsonb_build_object(
    'calls',            agg.calls,
    'eligibleAttempts', agg.calls - agg.system_failures,
    'humanConnects',    agg.connects,
    'voicemails',       agg.voicemails,
    'connectRate',      case when (agg.calls - agg.system_failures) > 0
                          then round(agg.connects::numeric * 1000
                                     / (agg.calls - agg.system_failures)) / 10
                          else 0 end,
    'avgTalkSec',       case when agg.connects > 0
                          then round(coalesce(agg.talk_secs, 0) / agg.connects)
                          else 0 end,
    'outcomes', (select coalesce(jsonb_object_agg(o.outcome, o.n), '{}'::jsonb)
                 from (select outcome, count(*) as n from rows
                       where outcome is not null group by outcome) o),
    'noOutcome', (select count(*) from rows where outcome is null),
    -- Appointments SET: distinct non-cancelled rows CREATED in the window —
    -- edits/reschedules never inflate this (glossary: appointments_set).
    'appointmentsSet', (
      select count(*) from public.appointments a
      where a.created_at >= p_from and a.created_at < p_to
        and coalesce(a.status, '') not in ('cancelled', 'canceled')
        and case when p_supervisor then a.org_id = p_org
                 else a.owner_id = p_user end)
  ) from agg;
$$;
revoke all on function public.app_metrics_summary(uuid, uuid, boolean, timestamptz, timestamptz, text, uuid, text) from public, anon, authenticated;
grant execute on function public.app_metrics_summary(uuid, uuid, boolean, timestamptz, timestamptz, text, uuid, text) to service_role;

-- Hourly productivity for ONE org-local day. p_tz shifts each call's start into
-- local time before bucketing, so DST days bucket correctly by construction
-- (a 23/25-hour day simply has fewer/more populated buckets).
create or replace function public.app_metrics_hourly(
  p_org uuid, p_user uuid, p_supervisor boolean,
  p_day date, p_tz text, p_campaign text default null
) returns jsonb
language sql stable security definer set search_path = public as $$
  with rows as (
    select
      extract(hour from (cr.started_at at time zone p_tz))::int as local_hour,
      coalesce(cr.human_connected,
        cr.outcome in ('appointment_booked','callback_scheduled','qualified',
                       'not_interested','do_not_call')) as connected
    from public.call_records cr
    where (cr.started_at at time zone p_tz)::date = p_day
      and case when p_supervisor
            then (cr.org_id = p_org or (cr.owner_id = p_user and cr.org_id is null))
            else (cr.owner_id = p_user and (cr.org_id = p_org or cr.org_id is null))
          end
      and (p_campaign is null or cr.campaign_id = p_campaign)
  )
  select coalesce(jsonb_agg(jsonb_build_object(
    'hour', h.local_hour, 'calls', h.calls, 'connects', h.connects
  ) order by h.local_hour), '[]'::jsonb)
  from (
    select local_hour, count(*) as calls,
           count(*) filter (where connected) as connects
    from rows group by local_hour
  ) h;
$$;
revoke all on function public.app_metrics_hourly(uuid, uuid, boolean, date, text, text) from public, anon, authenticated;
grant execute on function public.app_metrics_hourly(uuid, uuid, boolean, date, text, text) to service_role;

notify pgrst, 'reload schema';

-- ═════════════════════════════════════════════════════════════════════════════
-- PART 28 — LEAD OPERATIONS FOUNDATION                          [Phase 1 · C]
-- Import jobs (observable, rollbackable), per-lead import provenance, the
-- chunk-sized dedupe probe that replaces the O(book×chunks) phone scan,
-- mapping templates, per-lead audit events (Lead 360's timeline), and the two
-- columns the typed filter system needs (dialing_preference, archived_at).
-- Rollback: drop the new tables/functions/index; the leads columns may stay.
-- ═════════════════════════════════════════════════════════════════════════════
create table if not exists public.import_jobs (
  id           uuid primary key default gen_random_uuid(),
  org_id       uuid not null references public.organizations (id) on delete cascade,
  created_by   uuid references auth.users (id) on delete set null,
  file_name    text not null default '',
  status       text not null default 'running',  -- running | completed | canceled | failed | rolled_back
  has_header   boolean not null default true,
  delimiter    text not null default ',',
  dedupe_mode  text not null default 'skip',     -- skip | update | create_new
  destination  jsonb not null default '{}'::jsonb,
  column_plan  jsonb,
  rows_total   int not null default 0,
  created_ct   int not null default 0,
  updated_ct   int not null default 0,
  duplicate_ct int not null default 0,
  dnc_ct       int not null default 0,
  invalid_ct   int not null default 0,
  skipped_ct   int not null default 0,
  failed_ct    int not null default 0,
  error_rows   jsonb not null default '[]'::jsonb,
  created_at   timestamptz not null default now(),
  finished_at  timestamptz,
  rolled_back_at timestamptz
);
create index if not exists import_jobs_org_idx on public.import_jobs (org_id, created_at desc);
alter table public.import_jobs enable row level security;
drop policy if exists "import_jobs org read" on public.import_jobs;
create policy "import_jobs org read" on public.import_jobs for select using (
  public.app_is_superadmin() or (public.app_is_active() and public.app_is_org_member(org_id))
);

alter table public.leads add column if not exists import_job_id uuid references public.import_jobs (id) on delete set null;
alter table public.leads add column if not exists source_file   text;
alter table public.leads add column if not exists original_row  int;
alter table public.leads add column if not exists dialing_preference text not null default 'either'; -- ai | manual | either | none
alter table public.leads add column if not exists archived_at   timestamptz;
create index if not exists leads_import_job_idx on public.leads (import_job_id) where import_job_id is not null;

-- Atomic accounting bump — chunks arrive as separate requests.
create or replace function public.app_import_job_bump(
  p_job uuid, p_rows int, p_created int, p_updated int, p_dup int,
  p_dnc int, p_invalid int, p_skipped int, p_failed int, p_errors jsonb
) returns void language sql volatile security definer set search_path = public as $$
  update public.import_jobs set
    rows_total   = rows_total   + coalesce(p_rows, 0),
    created_ct   = created_ct   + coalesce(p_created, 0),
    updated_ct   = updated_ct   + coalesce(p_updated, 0),
    duplicate_ct = duplicate_ct + coalesce(p_dup, 0),
    dnc_ct       = dnc_ct       + coalesce(p_dnc, 0),
    invalid_ct   = invalid_ct   + coalesce(p_invalid, 0),
    skipped_ct   = skipped_ct   + coalesce(p_skipped, 0),
    failed_ct    = failed_ct    + coalesce(p_failed, 0),
    error_rows   = case when jsonb_array_length(error_rows) < 1000
                        then error_rows || coalesce(p_errors, '[]'::jsonb)
                        else error_rows end
  where id = p_job;
$$;
revoke all on function public.app_import_job_bump(uuid, int, int, int, int, int, int, int, int, jsonb) from public, anon, authenticated;
grant execute on function public.app_import_job_bump(uuid, int, int, int, int, int, int, int, int, jsonb) to service_role;

-- Chunk-sized dedupe probe: which of these last-10-digit keys already exist in
-- the org, and on which lead? Replaces insertLeads' "read every phone in the
-- org per chunk" scan (O(book × chunks) → one indexed probe per chunk).
create or replace function public.app_phone_matches(p_org uuid, p_digits text[])
returns table (digits text, lead_id uuid)
language sql stable security definer set search_path = public as $$
  select right(regexp_replace(coalesce(l.phone, ''), '\D', '', 'g'), 10), l.id
  from public.leads l
  where l.org_id = p_org
    and right(regexp_replace(coalesce(l.phone, ''), '\D', '', 'g'), 10) = any(p_digits);
$$;
revoke all on function public.app_phone_matches(uuid, text[]) from public, anon, authenticated;
grant execute on function public.app_phone_matches(uuid, text[]) to service_role;
create index if not exists leads_org_phone10_idx
  on public.leads (org_id, right(regexp_replace(coalesce(phone, ''), '\D', '', 'g'), 10));

create table if not exists public.import_mapping_templates (
  id         uuid primary key default gen_random_uuid(),
  org_id     uuid not null references public.organizations (id) on delete cascade,
  name       text not null,
  header_sig text not null default '',
  plan       jsonb not null,
  created_by uuid,
  created_at timestamptz not null default now(),
  last_used_at timestamptz
);
create index if not exists import_templates_org_idx on public.import_mapping_templates (org_id, header_sig);
alter table public.import_mapping_templates enable row level security;
drop policy if exists "import_templates org read" on public.import_mapping_templates;
create policy "import_templates org read" on public.import_mapping_templates for select using (
  public.app_is_superadmin() or (public.app_is_active() and public.app_is_org_member(org_id))
);

-- Per-lead audit events — Lead 360's timeline backbone (status transitions,
-- assignment changes, DNC add/remove, field edits, notes).
create table if not exists public.lead_events (
  id         uuid primary key default gen_random_uuid(),
  org_id     uuid,
  lead_id    uuid not null references public.leads (id) on delete cascade,
  actor_id   uuid,
  kind       text not null,   -- status | assignment | dnc | field_change | note
  payload    jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now()
);
create index if not exists lead_events_lead_idx on public.lead_events (lead_id, created_at desc);
alter table public.lead_events enable row level security;
drop policy if exists "lead_events org read" on public.lead_events;
create policy "lead_events org read" on public.lead_events for select using (
  public.app_is_superadmin() or (public.app_is_active() and public.app_is_org_member(org_id))
);

-- ═════════════════════════════════════════════════════════════════════════════
-- PART 29 — TYPED FILTER COMPILER + ACCURATE LEAD COUNTS       [Phase 1 · C2]
-- app_filter_leads executes a sanitized FilterSpec (src/lib/leads/filter-spec.ts
-- — the TS evaluator is the semantic twin; the shared parity fixture in
-- tests/filter-evaluator.test.ts is the contract). Injection safety is
-- structural: every column comes from a CASE whitelist, every operator from a
-- CASE whitelist, every VALUE passes through quote_literal/%L — nothing user-
-- supplied is ever interpolated raw, and an unknown key/op raises.
-- SERVICE-ROLE ONLY, same trust model as app_leads_page.
-- Rollback: drop function public.app_flt_frag, public.app_filter_leads,
--           public.app_lead_counts;
-- ═════════════════════════════════════════════════════════════════════════════

-- Compile ONE condition to a WHERE fragment (alias l = leads).
create or replace function public.app_flt_frag(cond jsonb, p_org uuid, p_user uuid)
returns text
language plpgsql immutable as $$
declare
  v_kind text := coalesce(cond->>'kind', 'core');
  v_key  text := cond->>'key';
  v_cmp  text := cond->>'cmp';
  v_val  jsonb := cond->'value';
  v_txt  text := cond->>'value';
  v_expr text;      -- SQL expression for the field
  v_type text;      -- text | number | boolean | date
  v_list text;      -- quoted IN-list
  v_esc  text;      -- LIKE-escaped text value
begin
  -- ── Derived keys: fixed templates, cmp only selects polarity ────────────────
  if v_kind = 'derived' or v_key in
     ('phone_valid','dnc','never_dialed','dial_eligible','latest_outcome',
      'has_open_callback','has_scheduled_appointment','unassigned','archived','search') then
    v_expr := case v_key
      when 'phone_valid' then
        '(length(regexp_replace(coalesce(l.phone, ''''), ''\D'', '''', ''g'')) = 10
          or (length(regexp_replace(coalesce(l.phone, ''''), ''\D'', '''', ''g'')) = 11
              and regexp_replace(coalesce(l.phone, ''''), ''\D'', '''', ''g'') like ''1%''))'
      when 'dnc' then
        format('(l.status = ''dnc'' or exists (select 1 from public.dnc_numbers d
           where d.org_id = %L
             and d.phone_digits = right(regexp_replace(coalesce(l.phone, ''''), ''\D'', '''', ''g''), 10)))', p_org)
      when 'never_dialed' then
        '(coalesce(l.attempt_count, 0) = 0 and l.last_contacted_at is null)'
      when 'dial_eligible' then
        format('(l.status in (''new'', ''no_answer'', ''callback'')
          and l.archived_at is null
          and (length(regexp_replace(coalesce(l.phone, ''''), ''\D'', '''', ''g'')) >= 10)
          and not exists (select 1 from public.dnc_numbers d
               where d.org_id = %L
                 and d.phone_digits = right(regexp_replace(coalesce(l.phone, ''''), ''\D'', '''', ''g''), 10))
          and (l.reserved_until is null or l.reserved_until < now())
          and (l.next_eligible_at is null or l.next_eligible_at <= now()))', p_org)
      when 'has_open_callback' then
        '(exists (select 1 from public.callbacks cb where cb.lead_id = l.id and cb.status = ''due''))'
      when 'has_scheduled_appointment' then
        '(exists (select 1 from public.appointments a where a.lead_id = l.id and a.status = ''scheduled''))'
      when 'unassigned' then '(l.assigned_rep_id is null)'
      when 'archived' then '(l.archived_at is not null)'
      else null
    end;
    if v_key = 'search' then
      v_esc := replace(replace(replace(coalesce(v_txt, ''), '\', '\\'), '%', '\%'), '_', '\_');
      return format('((l.first_name || '' '' || l.last_name) ilike %L
        or l.city ilike %L
        or regexp_replace(coalesce(l.phone, ''''), ''\D'', '''', ''g'') like %L)',
        '%' || v_esc || '%', '%' || v_esc || '%',
        '%' || regexp_replace(coalesce(v_txt, ''), '\D', '', 'g') || '%');
    end if;
    if v_key = 'latest_outcome' then
      v_expr := '(select cr.outcome from public.call_records cr
                  where cr.lead_id = l.id order by cr.started_at desc limit 1)';
      if v_cmp = 'eq' then return format('%s = %L', v_expr, v_txt);
      elsif v_cmp = 'neq' then return format('%s is distinct from %L', v_expr, v_txt);
      elsif v_cmp = 'in' then
        select string_agg(quote_literal(x.v), ',') into v_list
        from jsonb_array_elements_text(v_val) x(v);
        return format('%s in (%s)', v_expr, coalesce(v_list, 'null'));
      elsif v_cmp = 'is_empty' then return format('%s is null', v_expr);
      elsif v_cmp = 'not_empty' then return format('%s is not null', v_expr);
      else raise exception 'bad cmp % for latest_outcome', v_cmp;
      end if;
    end if;
    if v_expr is null then raise exception 'unknown derived key %', v_key; end if;
    return case when v_cmp in ('is_false') then '(not ' || v_expr || ')' else v_expr end;
  end if;

  -- ── Custom fields (l.custom_fields jsonb) ───────────────────────────────────
  if v_kind = 'custom' then
    if v_key !~ '^[a-z0-9_]{1,64}$' then raise exception 'bad custom key %', v_key; end if;
    v_type := coalesce(cond->>'type', 'text');
    v_type := case when v_type in ('number','currency') then 'number'
                   when v_type = 'boolean' then 'boolean'
                   when v_type = 'date' then 'date'
                   else 'text' end;
    v_expr := format('(l.custom_fields->>%L)', v_key);
    if v_type = 'number' then
      -- Numeric guard mirrors the TS evaluator: a non-numeric stored value
      -- never matches a numeric comparison.
      v_expr := format('(case when %s ~ ''^-?[0-9]+(\.[0-9]+)?$'' then (%s)::numeric end)', v_expr, v_expr);
    end if;
  else
    -- ── Core columns: strict whitelist ────────────────────────────────────────
    v_expr := case v_key
      when 'status'             then 'l.status'
      when 'campaign_id'        then 'l.campaign_id'
      when 'lead_group'         then 'l.lead_group'
      when 'lead_pack_id'       then 'l.lead_pack_id::text'
      when 'assigned_rep_id'    then 'l.assigned_rep_id'
      when 'owner_id'           then 'l.owner_id::text'
      when 'address'            then 'l.address'
      when 'city'               then 'lower(btrim(coalesce(l.city, '''')))'
      when 'state'              then 'lower(btrim(coalesce(l.state, '''')))'
      when 'county'             then 'l.county'
      when 'zip'                then 'l.zip'
      when 'timezone'           then 'l.timezone'
      when 'source_file'        then 'l.source_file'
      when 'dialing_preference' then 'coalesce(l.dialing_preference, ''either'')'
      when 'import_job_id'      then 'l.import_job_id::text'
      when 'created_at'         then 'l.created_at'
      when 'last_contacted_at'  then 'l.last_contacted_at'
      when 'last_attempt_at'    then 'l.last_attempt_at'
      when 'next_eligible_at'   then 'l.next_eligible_at'
      when 'utility_bill'       then 'l.utility_bill'
      when 'solar_payment'      then 'l.solar_payment'
      when 'attempt_count'      then 'coalesce(l.attempt_count, 0)'
      when 'has_ev'             then 'coalesce(l.has_ev, false)'
      when 'has_pool'           then 'coalesce(l.has_pool, false)'
      when 'has_battery'        then 'coalesce(l.has_battery, false)'
      when 'multiple_systems'   then 'coalesce(l.multiple_systems, false)'
      else null
    end;
    if v_expr is null then raise exception 'unknown filter key %', v_key; end if;
    v_type := case
      when v_key in ('created_at','last_contacted_at','last_attempt_at','next_eligible_at') then 'date'
      when v_key in ('utility_bill','solar_payment','attempt_count') then 'number'
      when v_key in ('has_ev','has_pool','has_battery','multiple_systems') then 'boolean'
      else 'text' end;
    -- City/state comparisons are case/space-folded on both sides.
    if v_key in ('city','state') and v_cmp in ('eq','neq','in','nin') then
      v_txt := lower(btrim(coalesce(v_txt, '')));
    end if;
  end if;

  -- ── Generic operators per type ──────────────────────────────────────────────
  if v_cmp = 'is_empty' then
    return case v_type
      when 'text' then format('(coalesce(btrim(%s), '''') = '''')', v_expr)
      else format('(%s is null)', v_expr) end;
  elsif v_cmp = 'not_empty' then
    return case v_type
      when 'text' then format('(coalesce(btrim(%s), '''') <> '''')', v_expr)
      else format('(%s is not null)', v_expr) end;
  elsif v_cmp = 'is_true'  and v_type = 'boolean' then return '(' || v_expr || ')';
  elsif v_cmp = 'is_false' and v_type = 'boolean' then return '(not ' || v_expr || ')';
  elsif v_cmp = 'eq'  then return format('(%s = %L%s)', v_expr, v_txt,
    case v_type when 'number' then '::numeric' when 'date' then '::timestamptz' else '' end);
  elsif v_cmp = 'neq' then return format('(%s is distinct from %L%s)', v_expr, v_txt,
    case v_type when 'number' then '::numeric' when 'date' then '::timestamptz' else '' end);
  elsif v_cmp in ('in', 'nin') then
    select string_agg(quote_literal(case when v_key in ('city','state')
                                         then lower(btrim(x.v)) else x.v end), ',')
      into v_list
    from jsonb_array_elements_text(v_val) x(v);
    if v_list is null then raise exception 'empty list for %', v_key; end if;
    return case when v_cmp = 'in'
      then format('(%s in (%s))', v_expr, v_list)
      else format('(%s not in (%s) or %s is null)', v_expr, v_list, v_expr) end;
  elsif v_cmp = 'contains' and v_type = 'text' then
    v_esc := replace(replace(replace(coalesce(v_txt, ''), '\', '\\'), '%', '\%'), '_', '\_');
    return format('(%s ilike %L)', v_expr, '%' || v_esc || '%');
  elsif v_cmp = 'starts_with' and v_type = 'text' then
    v_esc := replace(replace(replace(coalesce(v_txt, ''), '\', '\\'), '%', '\%'), '_', '\_');
    return format('(%s ilike %L)', v_expr, v_esc || '%');
  elsif v_cmp in ('gt','gte','lt','lte') and v_type = 'number' then
    if v_txt !~ '^-?[0-9]+(\.[0-9]+)?$' then raise exception 'bad number %', v_txt; end if;
    return format('(%s %s %L::numeric)', v_expr,
      case v_cmp when 'gt' then '>' when 'gte' then '>=' when 'lt' then '<' else '<=' end, v_txt);
  elsif v_cmp = 'between' and v_type = 'number' then
    if (v_val->>0) !~ '^-?[0-9]+(\.[0-9]+)?$' or (v_val->>1) !~ '^-?[0-9]+(\.[0-9]+)?$' then
      raise exception 'bad between for %', v_key;
    end if;
    return format('(%s between %L::numeric and %L::numeric)', v_expr, v_val->>0, v_val->>1);
  elsif v_cmp = 'before' and v_type = 'date' then
    return format('(%s < %L::timestamptz)', v_expr, v_txt);
  elsif v_cmp = 'after' and v_type = 'date' then
    return format('(%s > %L::timestamptz)', v_expr, v_txt);
  elsif v_cmp = 'within_days' and v_type = 'date' then
    if v_txt !~ '^[0-9]{1,4}$' then raise exception 'bad days %', v_txt; end if;
    return format('(%s >= now() - make_interval(days => %s))', v_expr, v_txt);
  elsif v_cmp = 'older_than_days' and v_type = 'date' then
    if v_txt !~ '^[0-9]{1,4}$' then raise exception 'bad days %', v_txt; end if;
    return format('(%s < now() - make_interval(days => %s))', v_expr, v_txt);
  end if;
  raise exception 'bad cmp % for % (%)', v_cmp, v_key, v_type;
end;
$$;
revoke all on function public.app_flt_frag(jsonb, uuid, uuid) from public, anon, authenticated;

create or replace function public.app_filter_leads(
  p_org uuid, p_user uuid, p_supervisor boolean,
  p_filter jsonb,
  p_sort jsonb default null,
  p_offset int default 0, p_limit int default 50,
  p_count_only boolean default false
) returns jsonb
language plpgsql stable security definer set search_path = public as $$
declare
  v_limit  int := least(greatest(coalesce(p_limit, 50), 1), 1000);
  v_offset int := greatest(coalesce(p_offset, 0), 0);
  v_where  text := '';
  v_groups text[] := '{}';
  v_conds  text[];
  v_grp    jsonb;
  v_cond   jsonb;
  v_order  text := '';
  v_sorts  text[] := '{}';
  v_s      jsonb;
  v_dir    text;
  v_expr   text;
  v_rows   jsonb;
  v_total  bigint;
  v_scope  text;
  v_sql    text;
begin
  -- Same two-branch scope as app_leads_page.
  v_scope := case when p_supervisor
    then format('(l.org_id = %L or (l.owner_id = %L and l.org_id is null))', p_org, p_user)
    else format('((l.owner_id = %L or l.assigned_rep_id = %L) and (l.org_id = %L or l.org_id is null))',
                p_user, p_user::text, p_org) end;

  -- Compile the FilterSpec: root op over groups, each group an op over conds.
  -- Caps mirror sanitizeFilterSpec (≤8 groups × ≤8 conditions).
  if p_filter is not null and jsonb_typeof(p_filter->'groups') = 'array' then
    for v_grp in select * from jsonb_array_elements(p_filter->'groups') limit 8 loop
      v_conds := '{}';
      if jsonb_typeof(v_grp->'conditions') = 'array' then
        for v_cond in select * from jsonb_array_elements(v_grp->'conditions') limit 8 loop
          v_conds := v_conds || public.app_flt_frag(v_cond, p_org, p_user);
        end loop;
      end if;
      if array_length(v_conds, 1) > 0 then
        v_groups := v_groups || ('(' || array_to_string(v_conds,
          case when coalesce(v_grp->>'op', 'and') = 'or' then ' or ' else ' and ' end) || ')');
      end if;
    end loop;
  end if;
  if array_length(v_groups, 1) > 0 then
    v_where := ' and (' || array_to_string(v_groups,
      case when coalesce(p_filter->>'op', 'and') = 'or' then ' or ' else ' and ' end) || ')';
  end if;

  -- Archived rows are excluded from every result UNLESS the filter itself
  -- references the archived key (drilling into the archived bucket).
  if position('"archived"' in coalesce(p_filter::text, '')) = 0 then
    v_where := v_where || ' and l.archived_at is null';
  end if;

  -- Sort: whitelisted keys only, ≤3, (created_at, id) always closes.
  if p_sort is not null and jsonb_typeof(p_sort) = 'array' then
    for v_s in select * from jsonb_array_elements(p_sort) limit 3 loop
      v_dir := case when lower(coalesce(v_s->>'dir', 'asc')) = 'desc' then 'desc' else 'asc' end;
      v_expr := case v_s->>'key'
        when 'name'   then 'lower(coalesce(l.last_name, '''') || '' '' || coalesce(l.first_name, ''''))'
        when 'city'   then 'lower(coalesce(l.city, ''''))'
        when 'state'  then 'lower(coalesce(l.state, ''''))'
        when 'status' then 'l.status'
        when 'utility_bill'      then 'l.utility_bill'
        when 'solar_payment'     then 'l.solar_payment'
        when 'ai_score'          then 'l.ai_score'
        when 'last_contacted_at' then 'l.last_contacted_at'
        when 'created_at'        then 'l.created_at'
        when 'attempt_count'     then 'coalesce(l.attempt_count, 0)'
        when 'last_attempt_at'   then 'l.last_attempt_at'
        when 'next_eligible_at'  then 'l.next_eligible_at'
        else null end;
      if v_expr is not null then
        v_sorts := v_sorts || (v_expr || ' ' || v_dir || ' nulls last');
      end if;
    end loop;
  end if;
  v_order := case when array_length(v_sorts, 1) > 0
    then array_to_string(v_sorts, ', ') || ', l.created_at asc, l.id asc'
    else 'l.created_at asc, l.id asc' end;

  v_sql := 'from public.leads l where ' || v_scope || v_where;

  execute 'select count(*) ' || v_sql into v_total;
  if p_count_only then
    return jsonb_build_object('total', v_total);
  end if;

  execute 'select coalesce(jsonb_agg(row_json), ''[]''::jsonb) from (
      select to_jsonb(l.*) as row_json ' || v_sql ||
    ' order by ' || v_order ||
    format(' limit %s offset %s', v_limit, v_offset) || ') s'
  into v_rows;

  return jsonb_build_object('rows', v_rows, 'total', v_total);
end;
$$;
do $$
declare r record;
begin
  for r in
    select p.oid::regprocedure as sig from pg_proc p
    join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'public' and p.proname = 'app_filter_leads'
  loop
    execute format('revoke execute on function %s from public', r.sig);
    execute format('revoke execute on function %s from anon', r.sig);
    execute format('revoke execute on function %s from authenticated', r.sig);
    execute format('grant  execute on function %s to service_role', r.sig);
  end loop;
end $$;

-- The 8 drillable lead-count tiles — one scan, FILTER clauses, definitions in
-- docs/phase-1/metric-glossary.md ("Lead counts"). Unique lead ROWS, not phones.
create or replace function public.app_lead_counts(p_org uuid, p_user uuid, p_supervisor boolean)
returns jsonb
language sql stable security definer set search_path = public as $$
  with scope as (
    select l.*,
      right(regexp_replace(coalesce(l.phone, ''), '\D', '', 'g'), 10) as p10,
      length(regexp_replace(coalesce(l.phone, ''), '\D', '', 'g')) as plen
    from public.leads l
    where case when p_supervisor
      then (l.org_id = p_org or (l.owner_id = p_user and l.org_id is null))
      else ((l.owner_id = p_user or l.assigned_rep_id = p_user::text)
            and (l.org_id = p_org or l.org_id is null)) end
  ),
  dnc as (select phone_digits from public.dnc_numbers where org_id = p_org)
  select jsonb_build_object(
    'active',       count(*) filter (where archived_at is null and status <> 'dnc'),
    'dialEligible', count(*) filter (where archived_at is null
                      and status in ('new', 'no_answer', 'callback')
                      and plen >= 10
                      and p10 not in (select phone_digits from dnc)
                      and (reserved_until is null or reserved_until < now())
                      and (next_eligible_at is null or next_eligible_at <= now())),
    'assigned',     count(*) filter (where archived_at is null and status <> 'dnc' and assigned_rep_id is not null),
    'unassigned',   count(*) filter (where archived_at is null and status <> 'dnc' and assigned_rep_id is null),
    'neverDialed',  count(*) filter (where archived_at is null
                      and coalesce(attempt_count, 0) = 0 and last_contacted_at is null
                      and status in ('new', 'no_answer', 'callback')),
    'attempted',    count(*) filter (where archived_at is null
                      and (coalesce(attempt_count, 0) > 0 or last_contacted_at is not null)),
    'dnc',          count(*) filter (where status = 'dnc' or p10 in (select phone_digits from dnc)),
    'archived',     count(*) filter (where archived_at is not null or plen < 10)
  ) from scope;
$$;
revoke all on function public.app_lead_counts(uuid, uuid, boolean) from public, anon, authenticated;
grant execute on function public.app_lead_counts(uuid, uuid, boolean) to service_role;

notify pgrst, 'reload schema';

-- ═════════════════════════════════════════════════════════════════════════════
-- PART 30 — SMART LISTS 2.0                                    [Phase 1 · C3]
-- Dynamic saved queries (FilterSpec jsonb + saved view config) replacing the
-- six hardcoded rules in src/lib/leads/smart-lists.ts. The legacy rules are
-- seeded per org; the two solar-specific ones only for solar-template orgs
-- (they used to show for every vertical). Writes are service-role after app
-- permission checks; any member may read.
-- Rollback: drop table public.smart_lists;
-- ═════════════════════════════════════════════════════════════════════════════
create table if not exists public.smart_lists (
  id          uuid primary key default gen_random_uuid(),
  org_id      uuid not null references public.organizations (id) on delete cascade,
  key         text,                              -- non-null only for seeded legacy lists
  name        text not null,
  description text not null default '',
  tone        text not null default 'neutral',
  filter      jsonb not null,                    -- FilterSpec
  columns     jsonb,
  sort        jsonb,
  owner_id    uuid,
  shared      boolean not null default true,
  favorite    boolean not null default false,
  version     int not null default 1,
  updated_by  uuid,
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now(),
  unique (org_id, key)
);
alter table public.smart_lists enable row level security;
drop policy if exists "smart_lists org read" on public.smart_lists;
create policy "smart_lists org read" on public.smart_lists for select using (
  public.app_is_superadmin() or (public.app_is_active() and public.app_is_org_member(org_id))
);

-- Seed the four vertical-neutral legacy lists for every org.
-- Every seeded FilterSpec MUST be sanitize-stable (sanitizeFilterSpec accepts it
-- UNCHANGED) — tests/smart-list-migration.test.ts parses these literals and
-- pins that. An earlier revision seeded going_cold's day count as the STRING
-- "14", which the TS sanitizer drops, silently widening the list; hence the
-- corrective ON CONFLICT below: never-edited seed rows (version = 1) get their
-- filter repaired on re-run, user-versioned lists are never touched.
insert into public.smart_lists (org_id, key, name, description, tone, filter)
select o.id, s.key, s.name, s.description, s.tone, s.filter::jsonb
from public.organizations o
cross join (values
  ('fresh', 'Never called', 'New leads that haven''t been contacted yet.', 'primary',
   '{"op":"and","groups":[{"op":"and","conditions":[{"kind":"core","key":"status","cmp":"eq","value":"new"},{"kind":"derived","key":"never_dialed","cmp":"is_true"}]}]}'),
  ('going_cold', 'Going cold', 'Contacted once, then nothing for two weeks.', 'warning',
   '{"op":"and","groups":[{"op":"and","conditions":[{"kind":"core","key":"status","cmp":"in","value":["new","no_answer","callback"]},{"kind":"core","key":"last_contacted_at","cmp":"older_than_days","value":14}]}]}'),
  ('no_phone', 'No valid phone', 'Rows whose phone can''t be dialed.', 'danger',
   '{"op":"and","groups":[{"op":"and","conditions":[{"kind":"derived","key":"phone_valid","cmp":"is_false"}]}]}'),
  ('missing_address', 'Missing address', 'No street address or city on file.', 'warning',
   '{"op":"and","groups":[{"op":"and","conditions":[{"kind":"core","key":"address","cmp":"is_empty"},{"kind":"core","key":"city","cmp":"is_empty"}]}]}')
) s(key, name, description, tone, filter)
on conflict (org_id, key) do update
  set filter = excluded.filter, updated_at = now()
  where smart_lists.version = 1 and smart_lists.filter is distinct from excluded.filter;

-- The two solar-vertical rules, only where the vertical warrants them.
insert into public.smart_lists (org_id, key, name, description, tone, filter)
select o.id, s.key, s.name, s.description, s.tone, s.filter::jsonb
from public.organizations o
cross join (values
  ('high_bill', 'High utility bill', 'Monthly utility bill of $200 or more.', 'success',
   '{"op":"and","groups":[{"op":"and","conditions":[{"kind":"core","key":"utility_bill","cmp":"gte","value":200}]}]}'),
  ('big_load', 'Big energy load', 'EV, pool, battery, or multiple systems.', 'primary',
   '{"op":"and","groups":[{"op":"or","conditions":[{"kind":"core","key":"has_ev","cmp":"is_true"},{"kind":"core","key":"has_pool","cmp":"is_true"},{"kind":"core","key":"has_battery","cmp":"is_true"},{"kind":"core","key":"multiple_systems","cmp":"is_true"}]}]}')
) s(key, name, description, tone, filter)
where coalesce(o.dialer_template, '') in ('solar', 'sunrun')
on conflict (org_id, key) do update
  set filter = excluded.filter, updated_at = now()
  where smart_lists.version = 1 and smart_lists.filter is distinct from excluded.filter;

-- ═════════════════════════════════════════════════════════════════════════════
-- PART 31 — EXPORT AUDIT                                        [Phase 1 · C4]
-- Every export writes who/what/how-many (spec §6 requires an export audit
-- event). Service-role writes; supervisor read via app policies later if a UI
-- needs it.
-- Rollback: drop table public.export_audit;
-- ═════════════════════════════════════════════════════════════════════════════
create table if not exists public.export_audit (
  id         uuid primary key default gen_random_uuid(),
  org_id     uuid,
  user_id    uuid,
  row_count  int not null default 0,
  columns    jsonb not null default '[]'::jsonb,
  filter     jsonb,
  truncated  boolean not null default false,
  created_at timestamptz not null default now()
);
create index if not exists export_audit_org_idx on public.export_audit (org_id, created_at desc);
alter table public.export_audit enable row level security;

notify pgrst, 'reload schema';

-- ═════════════════════════════════════════════════════════════════════════════
-- PART 32 — PACKS BECOME ASSIGNMENTS                            [Phase 1 · D1]
-- lead_packs evolves IN PLACE into the assignment unit (no rename — the table
-- is live; the UI says "Assignment"). New columns are all defaulted, so legacy
-- behavior is unchanged until the Assignment Center reads them. Allocation is
-- atomic (FOR UPDATE SKIP LOCKED) with never-dialed-first ordering; candidate
-- narrowing by FilterSpec happens app-side via app_filter_leads (ids →
-- p_lead_ids), keeping ONE filter compiler.
-- Rollback: drop the two RPCs + assignment_events; the columns may stay.
-- ═════════════════════════════════════════════════════════════════════════════
alter table public.lead_packs add column if not exists status         text not null default 'active'; -- active|paused|completed|archived
alter table public.lead_packs add column if not exists priority       int  not null default 0;
alter table public.lead_packs add column if not exists due_date       timestamptz;
alter table public.lead_packs add column if not exists dialing_mode   text not null default 'either'; -- manual|ai|either
alter table public.lead_packs add column if not exists max_attempts   int;
alter table public.lead_packs add column if not exists cooldown_hours int;
alter table public.lead_packs add column if not exists ordering       text not null default 'file';   -- file|priority
alter table public.lead_packs add column if not exists source         text not null default 'import'; -- import|manual|filter|smart_list
alter table public.lead_packs add column if not exists filter_snapshot jsonb;
alter table public.lead_packs add column if not exists campaign_id    text;
create index if not exists lead_packs_assignee_status_idx on public.lead_packs (org_id, assigned_to, status);

create table if not exists public.assignment_events (
  id         uuid primary key default gen_random_uuid(),
  org_id     uuid not null references public.organizations (id) on delete cascade,
  pack_id    uuid references public.lead_packs (id) on delete set null,
  actor_id   uuid,
  action     text not null,  -- created|assigned|reclaimed|reassigned|paused|resumed|rebalanced|edited|completed|campaign_cloned
  payload    jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now()
);
create index if not exists assignment_events_pack_idx on public.assignment_events (pack_id, created_at desc);
create index if not exists assignment_events_org_idx  on public.assignment_events (org_id, created_at desc);
alter table public.assignment_events enable row level security;
drop policy if exists "assignment_events org read" on public.assignment_events;
create policy "assignment_events org read" on public.assignment_events for select using (
  public.app_is_superadmin() or (public.app_is_active() and public.app_is_org_member(org_id))
);

-- Count what an allocation WOULD take, with exact exclusion reasons. No locks.
create or replace function public.app_preview_assignment(
  p_org uuid, p_lead_ids uuid[], p_count int
) returns jsonb
language sql stable security definer set search_path = public as $$
  with pool as (
    select l.*,
      length(regexp_replace(coalesce(l.phone, ''), '\D', '', 'g')) as plen,
      right(regexp_replace(coalesce(l.phone, ''), '\D', '', 'g'), 10) as p10
    from public.leads l
    where l.org_id = p_org
      and (p_lead_ids is null or l.id = any(p_lead_ids))
  ),
  cls as (
    select case
      when status = 'dnc' or p10 in (select phone_digits from public.dnc_numbers where org_id = p_org) then 'dnc'
      when plen < 10 then 'no_phone'
      when assigned_rep_id is not null then 'assigned'
      when archived_at is not null or status not in ('new', 'no_answer', 'callback') then 'ineligible'
      else 'eligible' end as bucket
    from pool
  )
  select jsonb_build_object(
    'eligible',           count(*) filter (where bucket = 'eligible'),
    'wouldAllocate',      least(count(*) filter (where bucket = 'eligible'), greatest(coalesce(p_count, 0), 0)),
    'excludedDnc',        count(*) filter (where bucket = 'dnc'),
    'excludedNoPhone',    count(*) filter (where bucket = 'no_phone'),
    'excludedAssigned',   count(*) filter (where bucket = 'assigned'),
    'excludedIneligible', count(*) filter (where bucket = 'ineligible')
  ) from cls;
$$;
revoke all on function public.app_preview_assignment(uuid, uuid[], int) from public, anon, authenticated;
grant execute on function public.app_preview_assignment(uuid, uuid[], int) to service_role;

-- Atomically allocate up to p_count eligible UNASSIGNED leads into a new pack
-- for p_rep. Never-dialed first (mirrors app_claim_dial_leads' ORDER BY).
create or replace function public.app_allocate_assignment(
  p_org uuid, p_actor uuid, p_rep uuid, p_count int,
  p_label text, p_opts jsonb default '{}'::jsonb,
  p_lead_ids uuid[] default null
) returns jsonb
language plpgsql volatile security definer set search_path = public as $$
declare
  v_pack uuid;
  v_n    int;
begin
  insert into public.lead_packs (
    org_id, batch, seq, label, size, created_by,
    assigned_to, assigned_by, assigned_at,
    status, priority, due_date, dialing_mode, max_attempts, cooldown_hours,
    ordering, source, filter_snapshot, campaign_id
  ) values (
    p_org, coalesce(p_opts->>'batch', 'assignment'), 0, p_label, 0, p_actor,
    p_rep, p_actor, now(),
    'active',
    coalesce((p_opts->>'priority')::int, 0),
    (p_opts->>'dueDate')::timestamptz,
    coalesce(p_opts->>'dialingMode', 'either'),
    (p_opts->>'maxAttempts')::int,
    (p_opts->>'cooldownHours')::int,
    coalesce(p_opts->>'ordering', 'file'),
    coalesce(p_opts->>'source', 'manual'),
    p_opts->'filterSnapshot',
    p_opts->>'campaignId'
  ) returning id into v_pack;

  with picked as (
    select l.id from public.leads l
    where l.org_id = p_org
      and (p_lead_ids is null or l.id = any(p_lead_ids))
      and l.assigned_rep_id is null
      and l.archived_at is null
      and l.status in ('new', 'no_answer', 'callback')
      and length(regexp_replace(coalesce(l.phone, ''), '\D', '', 'g')) >= 10
      and not exists (select 1 from public.dnc_numbers d
           where d.org_id = p_org
             and d.phone_digits = right(regexp_replace(coalesce(l.phone, ''), '\D', '', 'g'), 10))
    order by coalesce(l.attempt_count, 0) asc,
             l.last_attempt_at asc nulls first,
             l.created_at asc, l.id asc
    limit greatest(coalesce(p_count, 0), 0)
    for update skip locked
  ),
  moved as (
    update public.leads l
    set lead_pack_id = v_pack, assigned_rep_id = p_rep::text
    from picked where l.id = picked.id
    returning l.id
  )
  select count(*)::int into v_n from moved;

  update public.lead_packs set size = v_n where id = v_pack;
  insert into public.assignment_events (org_id, pack_id, actor_id, action, payload)
  values (p_org, v_pack, p_actor, 'created',
          jsonb_build_object('rep', p_rep, 'allocated', v_n, 'requested', p_count));

  if v_n = 0 then
    delete from public.lead_packs where id = v_pack;
    return jsonb_build_object('packId', null, 'allocated', 0);
  end if;
  return jsonb_build_object('packId', v_pack, 'allocated', v_n);
end;
$$;
revoke all on function public.app_allocate_assignment(uuid, uuid, uuid, int, text, jsonb, uuid[]) from public, anon, authenticated;
grant execute on function public.app_allocate_assignment(uuid, uuid, uuid, int, text, jsonb, uuid[]) to service_role;

-- ═════════════════════════════════════════════════════════════════════════════
-- PART 33 — CALLBACK WORKSPACE v2                               [Phase 1 · D2]
-- Callbacks gain ownership, priority, provenance, attempts, and a CLAIM so two
-- users can never execute the same callback (15-minute stale takeover).
-- Rollback: drop function public.app_claim_callback; columns may stay.
-- ═════════════════════════════════════════════════════════════════════════════
alter table public.callbacks add column if not exists priority       int not null default 0;
alter table public.callbacks add column if not exists assigned_to    uuid;
alter table public.callbacks add column if not exists campaign_id    text;
alter table public.callbacks add column if not exists call_record_id uuid references public.call_records (id) on delete set null;
alter table public.callbacks add column if not exists attempt_count  int not null default 0;
alter table public.callbacks add column if not exists last_attempt_at timestamptz;
alter table public.callbacks add column if not exists claimed_by     uuid;
alter table public.callbacks add column if not exists claimed_at     timestamptz;
alter table public.callbacks add column if not exists timezone       text;

-- ═════════════════════════════════════════════════════════════════════════════
-- leads.timezone: a default that pretended to be data
-- ═════════════════════════════════════════════════════════════════════════════
-- The column was declared `text default 'America/Los_Angeles'` (see the leads
-- table above), so every row carried a zone nobody had chosen — and the app
-- could not tell "somebody set Los Angeles" apart from "nobody set anything".
--
-- Measured 2026-08-30 against production: 37,987 lead rows, zero nulls, exactly
-- ONE distinct value. Meanwhile the book's largest area codes are 334 (Alabama),
-- 817/214/469 (Texas) and 870/479/501 (Arkansas) — Central. Every contact's
-- local time was being computed two hours behind the truth, in the direction
-- that makes an out-of-hours call look fine.
--
-- Dropping the default makes future rows honest. The application already treats
-- the legacy value as absent (storedLeadTimezone in
-- src/lib/dialer/lead-timezone.ts) and infers from the area code instead, so
-- this is safe to run at any time and nothing depends on it having run.
--
-- OPTIONAL, and deliberately NOT included: backfilling the existing rows with
--     update public.leads set timezone = null
--      where timezone = 'America/Los_Angeles';
-- The measurement above shows that would destroy nothing, but it is a write
-- over the whole book and belongs to whoever owns the data, not to this file.
alter table public.leads alter column timezone drop default;

create or replace function public.app_claim_callback(p_id uuid, p_user uuid)
returns boolean language sql volatile security definer set search_path = public as $$
  with c as (
    update public.callbacks
    set claimed_by = p_user, claimed_at = now()
    where id = p_id and status = 'due'
      and (claimed_by is null or claimed_by = p_user
           or claimed_at < now() - interval '15 minutes')
    returning id
  )
  select exists (select 1 from c);
$$;
revoke all on function public.app_claim_callback(uuid, uuid) from public, anon, authenticated;
grant execute on function public.app_claim_callback(uuid, uuid) to service_role;

-- ═════════════════════════════════════════════════════════════════════════════
-- PART 34 — CAMPAIGNS BECOME OPERATIONAL OBJECTS                [Phase 1 · D4]
-- Campaign columns for audience/policy/goals; leads.campaign_id STAYS text (no
-- FK migration on live rows — the lead_group precedent); the funnel RPC returns
-- mutually exclusive CURRENT-STATE buckets, each drillable app-side.
-- Rollback: drop function public.app_campaign_funnel + the index; columns stay.
-- ═════════════════════════════════════════════════════════════════════════════
alter table public.campaigns add column if not exists description      text not null default '';
alter table public.campaigns add column if not exists objective        text not null default '';
alter table public.campaigns add column if not exists archived_at      timestamptz;
alter table public.campaigns add column if not exists audience         jsonb;
alter table public.campaigns add column if not exists dialing_policy   jsonb;
alter table public.campaigns add column if not exists caller_ids       text[] not null default '{}';
alter table public.campaigns add column if not exists retry_policy     jsonb;
alter table public.campaigns add column if not exists disposition_keys text[] not null default '{}';
alter table public.campaigns add column if not exists goals            jsonb;
create index if not exists leads_org_campaign_idx on public.leads (org_id, campaign_id) where campaign_id is not null;

-- One bucket per lead, priority-ordered so the funnel never double-counts:
-- dnc > appointment > converted > callback > connected > exhausted > attempted
-- > assigned > eligible > excluded (archived / invalid phone / parked status).
create or replace function public.app_campaign_funnel(p_org uuid, p_campaign text)
returns jsonb
language sql stable security definer set search_path = public as $$
  with pool as (
    select l.*,
      length(regexp_replace(coalesce(l.phone, ''), '\D', '', 'g')) as plen,
      right(regexp_replace(coalesce(l.phone, ''), '\D', '', 'g'), 10) as p10,
      coalesce((select (c.retry_policy->>'maxAttempts')::int
                from public.campaigns c where c.id::text = p_campaign), 0) as max_att
    from public.leads l
    where l.org_id = p_org and l.campaign_id = p_campaign
  ),
  cls as (
    select case
      when status = 'dnc' or p10 in (select phone_digits from public.dnc_numbers where org_id = p_org) then 'dnc'
      when status = 'appointment' then 'appointment'
      when status = 'qualified' then 'converted'
      when status = 'callback' then 'callback'
      when exists (select 1 from public.call_records cr
                   where cr.lead_id = pool.id
                     and coalesce(cr.human_connected,
                       cr.outcome in ('appointment_booked','callback_scheduled','qualified',
                                      'not_interested','do_not_call'))) then 'connected'
      when max_att > 0 and coalesce(attempt_count, 0) >= max_att then 'exhausted'
      when coalesce(attempt_count, 0) > 0 or last_contacted_at is not null then 'attempted'
      when assigned_rep_id is not null then 'assigned'
      when archived_at is null and status in ('new', 'no_answer') and plen >= 10 then 'eligible'
      else 'excluded' end as bucket
    from pool
  )
  select jsonb_build_object(
    'eligible',    count(*) filter (where bucket = 'eligible'),
    'assigned',    count(*) filter (where bucket = 'assigned'),
    'attempted',   count(*) filter (where bucket = 'attempted'),
    'connected',   count(*) filter (where bucket = 'connected'),
    'callback',    count(*) filter (where bucket = 'callback'),
    'appointment', count(*) filter (where bucket = 'appointment'),
    'converted',   count(*) filter (where bucket = 'converted'),
    'exhausted',   count(*) filter (where bucket = 'exhausted'),
    'dnc',         count(*) filter (where bucket = 'dnc'),
    'excluded',    count(*) filter (where bucket = 'excluded'),
    'total',       count(*)
  ) from cls;
$$;
revoke all on function public.app_campaign_funnel(uuid, text) from public, anon, authenticated;
grant execute on function public.app_campaign_funnel(uuid, text) to service_role;

notify pgrst, 'reload schema';

-- ═════════════════════════════════════════════════════════════════════════════
-- PART 35 — REALTIME: PRIVATE ORG BROADCAST CHANNELS           [Phase 1 · E1]
-- One private channel per org (topic org:<uuid>:floor). The SERVER publishes
-- (service role bypasses RLS); clients may only RECEIVE broadcasts + track
-- presence — a client can never forge a call.state/transcript event. Join is
-- authorized by active-org membership, so a dual-org member only receives
-- their ACTIVE org's floor.
-- Rollback: drop policy both policies on realtime.messages; drop function
--           public.app_can_join_org_topic; clients degrade to polling.
-- ═════════════════════════════════════════════════════════════════════════════
create or replace function public.app_can_join_org_topic(topic text)
returns boolean
language sql stable security definer set search_path = public as $$
  select case
    when topic ~ '^org:[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}:floor$' then
      split_part(topic, ':', 2)::uuid = public.app_active_org()
      and public.app_is_org_member(split_part(topic, ':', 2)::uuid)
      and public.app_is_active()
    else false
  end;
$$;

drop policy if exists "org members receive floor events" on realtime.messages;
create policy "org members receive floor events"
on realtime.messages for select to authenticated
using (
  realtime.messages.extension in ('broadcast', 'presence')
  and public.app_can_join_org_topic(realtime.topic())
);

drop policy if exists "org members track presence" on realtime.messages;
create policy "org members track presence"
on realtime.messages for insert to authenticated
with check (
  realtime.messages.extension = 'presence'
  and public.app_can_join_org_topic(realtime.topic())
);

-- ═════════════════════════════════════════════════════════════════════════════
-- PART 36 — CALL INTELLIGENCE                                   [Phase 1 · F1]
-- Structured AI artifacts with provenance + an append-only supersede chain
-- (an AI writer may NEVER supersede a human row); immutable transcript
-- segments with timestamps (audio↔transcript sync); the shared live-poll
-- cursor (N supervisors share ONE provider poll); the needs-review queue.
-- All service-role write, org-member read where policies exist.
-- Rollback: drop the four tables.
-- ═════════════════════════════════════════════════════════════════════════════
create table if not exists public.call_artifacts (
  id              uuid primary key default gen_random_uuid(),
  org_id          uuid,
  call_record_id  uuid references public.call_records (id) on delete cascade,
  conversation_id text,
  kind            text not null,   -- summary|facts|objections|commitments|appointment_signals|compliance_flags|proposed_disposition|coaching
  payload         jsonb not null,
  confidence      numeric,         -- 0..1; null for human-authored
  evidence        int[] not null default '{}',  -- transcript turn indices
  model           text,
  prompt_version  text,
  source          text not null default 'ai',    -- ai | human
  status          text not null default 'active',-- active | superseded
  supersedes      uuid references public.call_artifacts (id),
  created_by      uuid,
  created_at      timestamptz not null default now()
);
create index if not exists call_artifacts_call_idx on public.call_artifacts (call_record_id, kind, status);
create index if not exists call_artifacts_org_idx  on public.call_artifacts (org_id, created_at desc);
alter table public.call_artifacts enable row level security;
drop policy if exists "call_artifacts org read" on public.call_artifacts;
create policy "call_artifacts org read" on public.call_artifacts for select using (
  public.app_is_superadmin() or (public.app_is_active() and public.app_is_org_member(org_id))
);

create table if not exists public.call_transcript_segments (
  id              bigint generated always as identity primary key,
  org_id          uuid,
  conversation_id text not null,
  call_record_id  uuid,
  turn_index      int  not null,
  role            text not null,          -- agent | contact
  message         text not null,
  secs            numeric,                -- offset from call start
  source          text not null default 'elevenlabs',
  interim         boolean not null default false,
  supersedes_turn int,
  created_at      timestamptz not null default now(),
  unique (conversation_id, turn_index)
);
create index if not exists cts_convo_idx on public.call_transcript_segments (conversation_id, turn_index);
alter table public.call_transcript_segments enable row level security;
drop policy if exists "cts org read" on public.call_transcript_segments;
create policy "cts org read" on public.call_transcript_segments for select using (
  public.app_is_superadmin() or (public.app_is_active() and public.app_is_org_member(org_id))
);

create table if not exists public.transcript_cursors (
  conversation_id text primary key,
  last_turn       int not null default -1,
  fetched_at      timestamptz not null default now()
);
alter table public.transcript_cursors enable row level security;

create table if not exists public.call_review_queue (
  id             uuid primary key default gen_random_uuid(),
  org_id         uuid,
  call_record_id uuid references public.call_records (id) on delete cascade,
  reason         text not null,  -- low_confidence|high_impact|conflict|missing_transcript|rep_flagged
  proposed_disposition text,
  confidence     numeric,
  status         text not null default 'open',  -- open|resolved|dismissed
  resolved_by    uuid,
  resolved_at    timestamptz,
  resolution     text,
  created_at     timestamptz not null default now()
);
create index if not exists call_review_org_idx on public.call_review_queue (org_id, status, created_at desc);
alter table public.call_review_queue enable row level security;
drop policy if exists "review org read" on public.call_review_queue;
create policy "review org read" on public.call_review_queue for select using (
  public.app_is_superadmin() or (public.app_is_active() and public.app_is_org_member(org_id))
);

notify pgrst, 'reload schema';

-- ═════════════════════════════════════════════════════════════════════════════
-- PART 37 — OPPORTUNITY & ORCHESTRATION FOUNDATION              [Phase 2 · P2.1]
-- The canonical pursuit wrapped around a lead: ownership, lifecycle stage,
-- SLA clocks, work items, signals, and versioned playbooks with exactly-once
-- step execution. Design authority: docs/phase-2/opportunity-domain-and-
-- state-machines.md. leads.status remains the Phase 1 reporting authority
-- until the dual-write parity criterion is met — nothing here is read by any
-- Phase 1 surface.
-- All service-role write, org-member read. Rollback: docs/phase-2/migration-
-- and-rollback.md (drop the seven tables + view + functions; the backfill is
-- delete-where-backfilled).
-- ═════════════════════════════════════════════════════════════════════════════

create table if not exists public.opportunities (
  id                       uuid primary key default gen_random_uuid(),
  org_id                   uuid not null,
  lead_id                  uuid not null references public.leads (id) on delete cascade,
  previous_opportunity_id  uuid references public.opportunities (id),
  -- attribution (history lives in opportunity_events; these are current).
  -- campaign_id is TEXT: the Phase 1 convention on leads/call_records ("" =
  -- none) — an opportunity attributes to whatever its lead attributes to.
  source                   text not null default '',
  original_source          text not null default '',
  campaign_id              text,
  -- ownership
  owner_id                 uuid,
  owner_team               text,
  assignment_reason        text,
  owner_assigned_at        timestamptz,
  -- sales lifecycle (see stage-machine.ts — LOCKSTEP with STAGES there)
  stage                    text not null default 'new' check (stage in (
    'new','assigned','attempting','contacted','interested',
    'appointment_booked','appointment_completed','sold',
    'nurture','lost','invalid','dnc_suppressed','exhausted','duplicate','disqualified')),
  stage_entered_at         timestamptz not null default now(),
  -- operational work state (§5): open | waiting | paused | closed
  op_status                text not null default 'open' check (op_status in ('open','waiting','paused','closed')),
  waiting_until            timestamptz,
  paused_reason            text,
  next_action_kind         text,
  next_action_due_at       timestamptz,
  -- priority / hot signal surface
  priority                 int not null default 0,
  priority_reason          text,
  hot_until                timestamptz,
  -- speed-to-lead clocks (§7)
  first_received_at        timestamptz,
  eligible_at              timestamptz,
  first_assigned_at        timestamptz,
  first_attempted_at       timestamptz,
  first_contacted_at       timestamptz,
  last_touched_at          timestamptz,
  closed_at                timestamptz,
  close_reason             text,
  -- counters (repaired from canonical events by reconcile, never trusted blindly)
  attempt_count            int not null default 0,
  contact_count            int not null default 0,
  -- orchestration
  active_playbook_id       uuid,
  active_playbook_version  int,
  -- provenance
  backfilled               boolean not null default false,
  created_at               timestamptz not null default now(),
  updated_at               timestamptz not null default now()
);
-- Uniqueness policy (§4): at most ONE non-closed opportunity per lead.
create unique index if not exists opportunities_one_open_per_lead
  on public.opportunities (org_id, lead_id) where (op_status <> 'closed');
create index if not exists opportunities_org_stage_idx
  on public.opportunities (org_id, stage, op_status);
create index if not exists opportunities_owner_idx
  on public.opportunities (org_id, owner_id, op_status);
create index if not exists opportunities_next_action_idx
  on public.opportunities (org_id, next_action_due_at) where (op_status = 'open');
create index if not exists opportunities_lead_idx
  on public.opportunities (lead_id);
alter table public.opportunities enable row level security;
drop policy if exists "opportunities org read" on public.opportunities;
create policy "opportunities org read" on public.opportunities for select using (
  public.app_is_superadmin() or (public.app_is_active() and public.app_is_org_member(org_id))
);

-- Append-only transition/audit log — the §21 reconstructibility requirement.
create table if not exists public.opportunity_events (
  id             bigint generated always as identity primary key,
  org_id         uuid not null,
  opportunity_id uuid not null references public.opportunities (id) on delete cascade,
  type           text not null,          -- stage_changed|owner_changed|clock_stamped|priority_changed|status_changed|backfilled|…
  actor_kind     text not null default 'system',  -- rep|manager|ai|system
  actor_id       uuid,
  from_stage     text,
  to_stage       text,
  detail         jsonb not null default '{}'::jsonb,
  created_at     timestamptz not null default now()
);
create index if not exists opportunity_events_opp_idx
  on public.opportunity_events (opportunity_id, created_at);
-- Append-only, with ONE exception: the cascade that destroys the parent.
--
-- This used to raise on every DELETE, full stop. But opportunity_events
-- cascades from opportunities, which cascades from leads — so the trigger fired
-- on the RI cascade and aborted the transaction, which made any lead that had
-- ever produced an opportunity IMPOSSIBLE TO DELETE. Reps deleting a batch saw
-- the raw "opportunity_events is append-only" and lost the whole selection,
-- because one undeletable lead fails the batch it's in.
--
-- The guarantee this trigger exists for is "history is never rewritten or
-- quietly erased", not "leads are permanent". Both hold now: an UPDATE is
-- always refused, and a DELETE is refused while the parent opportunity is still
-- there. During a cascade the parent row is already gone by the time this
-- fires, and that absence is exactly what distinguishes "the opportunity is
-- being destroyed, take its log with it" from "someone is erasing an audit
-- trail out from under a live record".
create or replace function public.app_opportunity_events_immutable() returns trigger
language plpgsql as $fn$
begin
  if (tg_op = 'UPDATE') then
    raise exception 'opportunity_events is append-only';
  end if;
  if exists (select 1 from public.opportunities o where o.id = old.opportunity_id) then
    raise exception 'opportunity_events is append-only';
  end if;
  return old;
end $fn$;
drop trigger if exists opportunity_events_immutable on public.opportunity_events;
create trigger opportunity_events_immutable
  before update or delete on public.opportunity_events
  for each row execute function public.app_opportunity_events_immutable();
alter table public.opportunity_events enable row level security;
drop policy if exists "opportunity_events org read" on public.opportunity_events;
create policy "opportunity_events org read" on public.opportunity_events for select using (
  public.app_is_superadmin() or (public.app_is_active() and public.app_is_org_member(org_id))
);

-- All actionable work, human or automated (§4). The dedupe_key partial unique
-- is the "one trigger cannot create duplicate work" guarantee: however many
-- times a webhook or cron replays, only one LIVE item per key exists.
create table if not exists public.work_items (
  id                  uuid primary key default gen_random_uuid(),
  org_id              uuid not null,
  opportunity_id      uuid references public.opportunities (id) on delete cascade,
  lead_id             uuid,
  type                text not null,
  status              text not null default 'pending' check (status in (
    'pending','reserved','in_progress','waiting','completed',
    'canceled','skipped','expired','blocked','needs_review')),
  owner_id            uuid,
  queue               text,
  priority            int not null default 0,
  reason              text not null default '',
  due_at              timestamptz,
  scheduled_at        timestamptz,
  timezone            text,
  escalation_at       timestamptz,
  source_kind         text,
  source_id           text,
  dedupe_key          text,
  automation_eligible boolean not null default false,
  requires_approval   boolean not null default false,
  reserved_by         uuid,
  reserved_until      timestamptz,
  completed_by        uuid,
  completed_at        timestamptz,
  completion_evidence jsonb,
  created_at          timestamptz not null default now(),
  updated_at          timestamptz not null default now()
);
create unique index if not exists work_items_dedupe_live
  on public.work_items (org_id, dedupe_key)
  where (dedupe_key is not null
         and status in ('pending','reserved','in_progress','waiting'));
create index if not exists work_items_due_idx
  on public.work_items (org_id, status, due_at);
create index if not exists work_items_owner_idx
  on public.work_items (org_id, owner_id, status);
alter table public.work_items enable row level security;
drop policy if exists "work_items org read" on public.work_items;
create policy "work_items org read" on public.work_items for select using (
  public.app_is_superadmin() or (public.app_is_active() and public.app_is_org_member(org_id))
);

-- Explainable, time-bound urgency facts (§13). Repeat detections bump
-- seen_count/last_seen_at on the live row instead of stacking new ones.
create table if not exists public.signals (
  id              uuid primary key default gen_random_uuid(),
  org_id          uuid not null,
  opportunity_id  uuid references public.opportunities (id) on delete cascade,
  lead_id         uuid,
  type            text not null,
  severity        int not null default 3 check (severity between 1 and 5),
  confidence      numeric,
  evidence        jsonb not null default '{}'::jsonb,
  source_kind     text,
  source_id       text,
  dedupe_key      text,
  detected_at     timestamptz not null default now(),
  last_seen_at    timestamptz not null default now(),
  seen_count      int not null default 1,
  expires_at      timestamptz,
  acknowledged_by uuid,
  acknowledged_at timestamptz,
  resolved_at     timestamptz,
  resolution      text,             -- actioned|expired|dismissed|false_positive
  created_at      timestamptz not null default now()
);
create unique index if not exists signals_dedupe_open
  on public.signals (org_id, dedupe_key)
  where (dedupe_key is not null and resolved_at is null);
create index if not exists signals_open_idx
  on public.signals (org_id, resolved_at, severity desc, detected_at desc);
alter table public.signals enable row level security;
drop policy if exists "signals org read" on public.signals;
create policy "signals org read" on public.signals for select using (
  public.app_is_superadmin() or (public.app_is_active() and public.app_is_org_member(org_id))
);

-- Versioned playbook definitions. The AI can NEVER write this table (§6);
-- publish/pause/retire are authorized human actions through the API.
create table if not exists public.playbooks (
  id           uuid primary key default gen_random_uuid(),
  org_id       uuid not null,
  name         text not null,
  version      int not null default 1,
  status       text not null default 'draft' check (status in ('draft','published','paused','retired')),
  definition   jsonb not null,
  created_by   uuid,
  published_by uuid,
  published_at timestamptz,
  supersedes   uuid references public.playbooks (id),
  created_at   timestamptz not null default now(),
  updated_at   timestamptz not null default now()
);
create index if not exists playbooks_org_idx on public.playbooks (org_id, status);
alter table public.playbooks enable row level security;
drop policy if exists "playbooks org read" on public.playbooks;
create policy "playbooks org read" on public.playbooks for select using (
  public.app_is_superadmin() or (public.app_is_active() and public.app_is_org_member(org_id))
);

-- One activation per opportunity per playbook (while active).
create table if not exists public.playbook_instances (
  id               uuid primary key default gen_random_uuid(),
  org_id           uuid not null,
  playbook_id      uuid not null references public.playbooks (id) on delete cascade,
  playbook_version int not null,
  opportunity_id   uuid not null references public.opportunities (id) on delete cascade,
  status           text not null default 'active' check (status in ('active','waiting','completed','stopped','failed')),
  current_step     int not null default 0,
  wait_until       timestamptz,
  stopped_reason   text,
  started_at       timestamptz not null default now(),
  ended_at         timestamptz,
  updated_at       timestamptz not null default now()
);
create unique index if not exists playbook_instances_one_active
  on public.playbook_instances (playbook_id, opportunity_id)
  where (status in ('active','waiting'));
create index if not exists playbook_instances_due_idx
  on public.playbook_instances (org_id, status, wait_until);
alter table public.playbook_instances enable row level security;
drop policy if exists "playbook_instances org read" on public.playbook_instances;
create policy "playbook_instances org read" on public.playbook_instances for select using (
  public.app_is_superadmin() or (public.app_is_active() and public.app_is_org_member(org_id))
);

-- Append-only step execution log. The UNIQUE idempotency_key is the
-- exactly-once gate (§6): insert first, act only if the insert won.
create table if not exists public.playbook_executions (
  id              bigint generated always as identity primary key,
  org_id          uuid not null,
  instance_id     uuid not null references public.playbook_instances (id) on delete cascade,
  step_index      int not null,
  action_kind     text not null,
  idempotency_key text not null unique,
  status          text not null default 'succeeded' check (status in ('succeeded','failed','skipped_policy')),
  attempt         int not null default 1,
  detail          jsonb not null default '{}'::jsonb,
  error           text,
  executed_at     timestamptz not null default now()
);
create index if not exists playbook_executions_instance_idx
  on public.playbook_executions (instance_id, step_index);
alter table public.playbook_executions enable row level security;
drop policy if exists "playbook_executions org read" on public.playbook_executions;
create policy "playbook_executions org read" on public.playbook_executions for select using (
  public.app_is_superadmin() or (public.app_is_active() and public.app_is_org_member(org_id))
);

-- Channel-neutral TOUCH view v0 (§4 — honest Partial: becomes a table when the
-- first non-call channel lands). security_invoker: reads ride the caller's RLS.
create or replace view public.touches_v
  with (security_invoker = true) as
select
  cr.id                       as touch_id,
  cr.org_id                   as org_id,
  cr.lead_id                  as lead_id,
  'outbound'                  as direction,
  case when cr.channel = 'ai' then 'ai_call' else 'manual_call' end as channel,
  cr.call_sid                 as provider_id,
  cr.conversation_id          as conversation_id,
  cr.client_attempt_id        as idempotency_key,
  cr.started_at               as initiated_at,
  coalesce(cr.human_connected, false) as connected,
  cr.duration_sec             as duration_sec,
  cr.talk_sec                 as talk_sec,
  cr.outcome                  as outcome,
  cr.disposition              as disposition,
  case when cr.channel = 'ai' then 'ai_agent' else 'rep' end as actor_kind,
  cr.owner_id                 as actor_id,
  cr.campaign_id              as campaign_id
from public.call_records cr;

-- The §5 leak detector: OPEN opportunities with no future next action, no live
-- work item, and no waiting/paused hold. Plain SQL + security invoker — org
-- members see exactly their own org's leaks through the tables' own RLS.
create or replace function public.app_pipeline_leaks(p_org uuid)
returns setof public.opportunities
language sql stable security invoker as $$
  select o.*
  from public.opportunities o
  where o.org_id = p_org
    and o.op_status = 'open'
    and (o.next_action_due_at is null or o.next_action_due_at < now())
    -- An ARCHIVED lead's opportunity is not a leak: the record is out of the
    -- book, so chasing it is not work anyone can do. Excluding it also keeps
    -- the CRM board honest — its lane counts inner-join leads and drop
    -- archived ones, so a headline that counted them contradicted the
    -- "archived excluded" note sitting beside it.
    and exists (
      select 1 from public.leads l
      where l.id = o.lead_id
        and l.archived_at is null
    )
    and not exists (
      select 1 from public.work_items w
      where w.opportunity_id = o.id
        and w.status in ('pending','reserved','in_progress','waiting')
        and (w.due_at is null or w.due_at > now() - interval '30 days')
    );
$$;

-- Atomic work-item claiming — the reservation engine's pattern (FOR UPDATE
-- SKIP LOCKED + TTL lease), so two reps or two cron ticks can never grab the
-- same item. Expired reservations are simply claimable again; no sweeper.
create or replace function public.app_claim_work_items(
  p_org uuid,
  p_user uuid,
  p_limit int default 5,
  p_ttl_seconds int default 300,
  p_types text[] default null,
  p_queue text default null
) returns setof public.work_items
language plpgsql security definer set search_path = public as $$
begin
  return query
  with candidates as (
    select w.id from public.work_items w
    where w.org_id = p_org
      and (
        w.status = 'pending'
        or (w.status = 'reserved' and w.reserved_until < now())
      )
      and (w.due_at is null or w.due_at <= now())
      and (p_types is null or w.type = any (p_types))
      and (p_queue is null or w.queue = p_queue)
      and (w.owner_id is null or w.owner_id = p_user)
    order by w.priority desc, w.due_at asc nulls last, w.created_at asc
    limit greatest(1, least(p_limit, 50))
    for update skip locked
  )
  update public.work_items w
     set status = 'reserved',
         reserved_by = p_user,
         reserved_until = now() + make_interval(secs => greatest(30, p_ttl_seconds)),
         updated_at = now()
    from candidates c
   where w.id = c.id
  returning w.*;
end;
$$;
revoke all on function public.app_claim_work_items(uuid, uuid, int, int, text[], text) from public, anon, authenticated;

-- ── Backfill: one opportunity per non-archived lead (idempotent) ─────────────
-- Clocks are approximations from lead timestamps; `backfilled` marks them so
-- reports can say so. Re-run safety is the NOT EXISTS guard (any opportunity
-- for the lead, open or closed) — the partial unique alone would let CLOSED
-- backfill rows duplicate on a second run, since they don't match its
-- predicate. The ON CONFLICT clause then only absorbs a concurrent racer.
insert into public.opportunities (
  org_id, lead_id, stage, op_status, owner_id, owner_assigned_at,
  first_received_at, first_attempted_at, last_touched_at,
  closed_at, close_reason,
  attempt_count, campaign_id, source, backfilled, created_at
)
select
  l.org_id,
  l.id,
  case l.status
    when 'new'            then case when l.assigned_rep_id is null then 'new' else 'assigned' end
    when 'no_answer'      then 'attempting'
    when 'contacted'      then 'contacted'
    when 'callback'       then 'contacted'
    when 'qualified'      then 'interested'
    when 'appointment'    then 'appointment_booked'
    when 'bills_fine'     then 'nurture'
    when 'not_interested' then 'lost'
    when 'dnc'            then 'dnc_suppressed'
    else 'new'
  end,
  case when l.status in ('not_interested','dnc') then 'closed' else 'open' end,
  -- assigned_rep_id is TEXT on leads (all values are UUIDs in practice);
  -- pattern-guard the cast so one stray value can't fail the whole backfill.
  coalesce(
    case when l.assigned_rep_id ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
         then l.assigned_rep_id::uuid end,
    l.owner_id
  ),
  case when l.assigned_rep_id is not null then l.created_at end,
  l.created_at,
  l.last_attempt_at,
  coalesce(l.last_attempt_at, l.created_at),
  case when l.status in ('not_interested','dnc')
       then coalesce(l.last_attempt_at, l.created_at) end,
  case l.status when 'not_interested' then 'lost'
                when 'dnc'            then 'dnc_suppressed' end,
  coalesce(l.attempt_count, 0),
  l.campaign_id,
  'phase1_backfill',
  true,
  l.created_at
from public.leads l
where l.org_id is not null
  and l.archived_at is null
  and not exists (
    select 1 from public.opportunities o where o.lead_id = l.id
  )
on conflict (org_id, lead_id) where (op_status <> 'closed') do nothing;


-- Global orchestration kill switch (superadmin; checked FIRST every tick).
alter table public.app_settings
  add column if not exists orchestration_paused boolean not null default false;

-- ─────────────────────────────────────────────────────────────────────────────
-- PART 38 — orchestration heartbeat.
--
-- Without this, a workspace that switches orchestration ON and sees nothing
-- happen has no way to tell the difference between "no work matched" and "the
-- engine is not running at all" (the orchestrate cron is scheduled by hand —
-- see cron.sql — so 'not running at all' is the default state). The tick
-- stamps this column; Admin -> Playbooks reads it and says so plainly.
-- Additive and safe to run repeatedly.
-- ─────────────────────────────────────────────────────────────────────────────
alter table public.app_settings
  add column if not exists orchestration_last_tick_at timestamptz;

-- ─────────────────────────────────────────────────────────────────────────────
-- PART 39 — signal audience.
--
-- A playbook's `escalate` step declares `to: owner | managers | queue`, and the
-- escalation ladder depends on the distinction: nudge the rep first, tell a
-- manager only if it is still unresolved. Signals were written identically
-- either way and every audience saw both, so the ladder had one rung.
--
-- 'owner' is the default because it is the narrower audience: an existing row
-- keeps being visible to exactly who could already see it.
-- ─────────────────────────────────────────────────────────────────────────────
alter table public.signals
  add column if not exists audience text not null default 'owner'
  check (audience in ('owner','managers'));

-- ─────────────────────────────────────────────────────────────────────────────
-- PART 40 — CONSENT LEDGER                                        [Phase 2 · W1]
--
-- Consent is keyed on the NUMBER, not the lead. leads.phone changes, the book
-- contains duplicates of the same human, and consent can arrive before a lead
-- row exists at all (someone texts in). lead_id is attribution, never identity.
--
-- THE RULE THIS SCHEMA EXISTS TO ENFORCE: absence of a row means `unknown`, and
-- unknown is treated exactly like `revoked` for anything promotional. There is
-- deliberately NO backfill. Consent provenance for the existing book is not
-- known, and inventing a row for 37,000 people would be manufacturing evidence
-- of permission nobody can point at. No row = no evidence = no promotional
-- send, by construction, with zero migration risk.
--
-- DNC and consent both gate and neither replaces the other: DNC is suppression
-- ("never contact this number"), consent is affirmative permission ("they said
-- yes, here is what they said"). A number can be absent from DNC and still have
-- no consent, which is the state almost every imported record is in.
-- ─────────────────────────────────────────────────────────────────────────────

-- The ledger. Append-only, like opportunity_events and for the same reason: it
-- is the artifact you produce when someone asks you to prove permission.
create table if not exists public.consent_events (
  id            bigint generated always as identity primary key,
  org_id        uuid not null,
  -- Last 10 digits, matching dnc_numbers.phone_digits so the two agree about
  -- what "the same number" means.
  phone_digits  text not null,
  channel       text not null check (channel in ('sms','voice','email')),
  action        text not null check (action in ('granted','revoked')),
  -- What they agreed to. An inbound-initiated conversation grants
  -- 'transactional' only: they texted us, we may answer. It is never promoted
  -- to 'promotional' by anything other than an explicit opt-in.
  scope         text not null default 'transactional'
                check (scope in ('transactional','promotional')),
  source        text not null,
  -- The words, AS SHOWN OR SAID. Not a pointer to a settings row: settings
  -- change, and the artifact must not change with them.
  evidence      text not null default '',
  -- Where to find the original: a call record, a message, a form submission.
  evidence_ref  text,
  lead_id       uuid,
  actor_id      uuid,
  captured_at   timestamptz not null default now(),
  created_at    timestamptz not null default now()
);
create index if not exists consent_events_key_idx
  on public.consent_events (org_id, phone_digits, channel, captured_at desc);
create index if not exists consent_events_lead_idx
  on public.consent_events (lead_id) where (lead_id is not null);

create or replace function public.app_consent_events_immutable() returns trigger
language plpgsql as $fn$ begin raise exception 'consent_events is append-only'; end $fn$;
drop trigger if exists consent_events_immutable on public.consent_events;
create trigger consent_events_immutable
  before update or delete on public.consent_events
  for each row execute function public.app_consent_events_immutable();

alter table public.consent_events enable row level security;
drop policy if exists "consent_events org read" on public.consent_events;
create policy "consent_events org read" on public.consent_events for select using (
  public.app_is_superadmin() or (public.app_is_active() and public.app_is_org_member(org_id))
);

-- The projection the send gate point-reads. One row per (org, number, channel),
-- always reflecting the most recent event. Revocation is a NEW EVENT plus an
-- update here — never a delete: internal do-not-contact retention runs five
-- years from the request, so the ledger has to keep the revocation itself.
create table if not exists public.consent_state (
  org_id       uuid not null,
  phone_digits text not null,
  channel      text not null check (channel in ('sms','voice','email')),
  status       text not null check (status in ('granted','revoked')),
  scope        text not null default 'transactional'
               check (scope in ('transactional','promotional')),
  source       text not null default '',
  captured_at  timestamptz not null,
  -- The ledger row this state was projected from, so any state can be traced
  -- back to the words behind it.
  event_id     bigint not null,
  updated_at   timestamptz not null default now(),
  primary key (org_id, phone_digits, channel)
);
create index if not exists consent_state_status_idx
  on public.consent_state (org_id, channel, status);

alter table public.consent_state enable row level security;
drop policy if exists "consent_state org read" on public.consent_state;
create policy "consent_state org read" on public.consent_state for select using (
  public.app_is_superadmin() or (public.app_is_active() and public.app_is_org_member(org_id))
);

-- Record consent and project it in one statement, so the two can never
-- disagree. A LATER captured_at always wins; an out-of-order arrival (a webhook
-- retry, a backdated import) cannot demote a newer decision. Application code
-- calls this rather than writing either table directly.
create or replace function public.app_record_consent(
  p_org uuid,
  p_digits text,
  p_channel text,
  p_action text,
  p_scope text,
  p_source text,
  p_evidence text default '',
  p_evidence_ref text default null,
  p_lead uuid default null,
  p_actor uuid default null,
  p_captured_at timestamptz default now()
) returns bigint
language plpgsql security definer set search_path = public as $$
declare
  v_id bigint;
begin
  insert into public.consent_events (
    org_id, phone_digits, channel, action, scope, source,
    evidence, evidence_ref, lead_id, actor_id, captured_at
  ) values (
    p_org, p_digits, p_channel, p_action, p_scope, p_source,
    coalesce(p_evidence, ''), p_evidence_ref, p_lead, p_actor,
    coalesce(p_captured_at, now())
  ) returning id into v_id;

  insert into public.consent_state (
    org_id, phone_digits, channel, status, scope, source, captured_at, event_id, updated_at
  ) values (
    p_org, p_digits, p_channel, p_action, p_scope, p_source,
    coalesce(p_captured_at, now()), v_id, now()
  )
  on conflict (org_id, phone_digits, channel) do update
    set status      = excluded.status,
        scope       = excluded.scope,
        source      = excluded.source,
        captured_at = excluded.captured_at,
        event_id    = excluded.event_id,
        updated_at  = now()
    where excluded.captured_at >= public.consent_state.captured_at;

  return v_id;
end;
$$;
revoke all on function public.app_record_consent(
  uuid, text, text, text, text, text, text, text, uuid, uuid, timestamptz
) from public, anon, authenticated;

-- ─────────────────────────────────────────────────────────────────────────────
-- PART 41 — CUSTOMER MESSAGING                                    [Phase 2 · W2]
--
-- THE ONE ARCHITECTURAL DECISION, ENFORCED HERE RATHER THAN BY CONVENTION:
--
--   The engine never sends. The engine proposes. A named human sends.
--
-- `messages_approved_by_required` below is that rule as a constraint. A row
-- cannot reach a sendable status without a named approver, so a future refactor
-- that tries to auto-send is refused by Postgres rather than by a code review.
-- Rep-initiated 1:1 messages are not exempt — they are SELF-approved, so
-- author == approver and the audit row says so. One path, one constraint, two
-- permission shapes.
--
-- Deliberately NOT built on notification_outbox. app_claim_notifications is
-- kind-agnostic and drainOutbox is not: an SMS row placed there would be
-- claimed by the email drain, cast to an appointment email kind, and rendered
-- to the org's appointment recipients. That is a cross-channel content leak,
-- and it is only the first of five disqualifying reasons.
-- ─────────────────────────────────────────────────────────────────────────────

-- Versioned, approved wording. A template is authored as a draft and published;
-- exactly one version per key may be live at a time.
create table if not exists public.message_templates (
  id           uuid primary key default gen_random_uuid(),
  org_id       uuid not null,
  key          text not null,
  version      int  not null default 1,
  name         text not null default '',
  channel      text not null default 'sms' check (channel in ('sms','email')),
  -- What this message IS, which decides which consent scope it needs.
  scope        text not null default 'transactional'
               check (scope in ('transactional','promotional')),
  body         text not null,
  -- Variables the body references, so an unresolved one is a publish-time
  -- error rather than a customer receiving "Hi {{firstName}}".
  variables    text[] not null default '{}',
  status       text not null default 'draft' check (status in ('draft','published','archived')),
  -- Ships INERT: the drain refuses to auto-send whatever this says. It exists
  -- so the column does not have to be added later under time pressure.
  auto_send    boolean not null default false,
  created_by   uuid,
  published_by uuid,
  published_at timestamptz,
  created_at   timestamptz not null default now(),
  updated_at   timestamptz not null default now()
);
create unique index if not exists message_templates_one_live
  on public.message_templates (org_id, key) where (status = 'published');
create index if not exists message_templates_org_idx
  on public.message_templates (org_id, status, key);
alter table public.message_templates enable row level security;
drop policy if exists "message_templates org read" on public.message_templates;
create policy "message_templates org read" on public.message_templates for select using (
  public.app_is_superadmin() or (public.app_is_active() and public.app_is_org_member(org_id))
);

-- One conversation per person per org per channel, keyed on the last 10 digits
-- so the same human never ends up with two threads. The sender number is
-- STICKY: caller-ID rotation is right for dialing and catastrophic for a
-- conversation, where a reply must come from the number they were texted from.
create table if not exists public.message_threads (
  id             uuid primary key default gen_random_uuid(),
  org_id         uuid not null,
  contact_digits text not null,
  channel        text not null default 'sms' check (channel in ('sms','email')),
  lead_id        uuid,
  opportunity_id uuid references public.opportunities (id) on delete set null,
  sender_number  text,
  -- True when the lead could not be resolved unambiguously; the Unmatched
  -- inbox works these rather than the system guessing.
  ambiguous_match boolean not null default false,
  last_inbound_at  timestamptz,
  last_outbound_at timestamptz,
  unread_count   int not null default 0,
  created_at     timestamptz not null default now(),
  updated_at     timestamptz not null default now()
);
create unique index if not exists message_threads_one_per_contact
  on public.message_threads (org_id, contact_digits, channel);
create index if not exists message_threads_lead_idx
  on public.message_threads (org_id, lead_id);
alter table public.message_threads enable row level security;
drop policy if exists "message_threads org read" on public.message_threads;
create policy "message_threads org read" on public.message_threads for select using (
  public.app_is_superadmin() or (public.app_is_active() and public.app_is_org_member(org_id))
);

create table if not exists public.messages (
  id             uuid primary key default gen_random_uuid(),
  org_id         uuid not null,
  thread_id      uuid not null references public.message_threads (id) on delete cascade,
  lead_id        uuid,
  opportunity_id uuid references public.opportunities (id) on delete set null,
  direction      text not null check (direction in ('outbound','inbound')),
  channel        text not null default 'sms' check (channel in ('sms','email')),
  -- The honest lifecycle. `sent` and `delivered` are written ONLY by a provider
  -- status callback — never by the send call returning, which reports `queued`.
  status         text not null check (status in (
                   'draft','needs_approval','approved','queued','sending',
                   'sent','delivered','undelivered','failed','blocked',
                   'rejected','canceled','needs_review','received')),
  body           text not null default '',
  -- Rendered ONCE at proposal time and frozen. The approver approved specific
  -- words to a specific person; re-rendering at send would deliver words nobody
  -- read.
  template_id    uuid references public.message_templates (id),
  template_key   text,
  template_version int,
  scope          text not null default 'transactional'
                 check (scope in ('transactional','promotional')),
  from_number    text,
  to_number      text,
  -- Provider truth, kept separate from our own lifecycle.
  provider       text not null default 'twilio',
  provider_sid   text,
  provider_status text,
  error_code     text,
  error_message  text,
  segments       int,
  -- Exactly-once creation. The orchestration engine's idempotency discipline.
  idempotency_key text,
  -- The approval columns the constraint below depends on.
  created_by     uuid,
  approved_by    uuid,
  approved_at    timestamptz,
  rejected_by    uuid,
  rejected_at    timestamptz,
  reject_reason  text,
  -- Why the gate refused, when it did. Plural: the gate returns ALL reasons.
  blocked_reasons text[],
  next_attempt_at timestamptz,
  attempts       int not null default 0,
  queued_at      timestamptz,
  sent_at        timestamptz,
  delivered_at   timestamptz,
  -- An AGENT of ours read it. SMS has no read receipt and this never means the
  -- customer read anything.
  read_at        timestamptz,
  source_kind    text,
  source_id      text,
  created_at     timestamptz not null default now(),
  updated_at     timestamptz not null default now(),
  -- THE RULE. A message cannot become sendable without a named human.
  constraint messages_approved_by_required check (
    status not in ('approved','queued','sending','sent','delivered')
    or approved_by is not null
  )
);
create unique index if not exists messages_idempotency
  on public.messages (org_id, idempotency_key) where (idempotency_key is not null);
-- Globally unique, not per-org: Twilio retries an inbound webhook with the same
-- SID, and the dedupe has to hold before we know which org it belongs to.
create unique index if not exists messages_provider_sid
  on public.messages (provider_sid) where (provider_sid is not null);
-- The drain's only query. Partial, so it stays tiny behind millions of rows.
create index if not exists messages_drain_idx
  on public.messages (next_attempt_at)
  where (status in ('approved','queued'));
create index if not exists messages_thread_idx
  on public.messages (thread_id, created_at desc);
create index if not exists messages_approvals_idx
  on public.messages (org_id, status, created_at) where (status = 'needs_approval');
create index if not exists messages_cap_idx
  on public.messages (org_id, to_number, created_at)
  where (direction = 'outbound' and provider_sid is not null);

alter table public.messages enable row level security;
drop policy if exists "messages org read" on public.messages;
create policy "messages org read" on public.messages for select using (
  public.app_is_superadmin() or (public.app_is_active() and public.app_is_org_member(org_id))
);

-- Atomic claim for the send drain: same FOR UPDATE SKIP LOCKED lease pattern as
-- app_claim_work_items. Two cron ticks overlapping must never both pick up the
-- same message, because Twilio's Messages API has NO idempotency key and a
-- second send is a second real text to a real person.
create or replace function public.app_claim_messages(
  p_limit int default 20
) returns setof public.messages
language plpgsql security definer set search_path = public as $$
begin
  return query
  with candidates as (
    select m.id from public.messages m
    where m.status in ('approved','queued')
      and (m.next_attempt_at is null or m.next_attempt_at <= now())
      and m.approved_by is not null
    order by m.next_attempt_at asc nulls first, m.created_at asc
    limit greatest(1, least(p_limit, 100))
    for update skip locked
  )
  update public.messages m
     set status = 'queued',
         attempts = m.attempts + 1,
         updated_at = now()
    from candidates c
   where m.id = c.id
  returning m.*;
end;
$$;
revoke all on function public.app_claim_messages(int) from public, anon, authenticated;

-- The platform-wide messaging kill switch, and the send drain's heartbeat.
--
-- Flipping `messaging_paused` must leave approved rows exactly as they are, not
-- cancel them: rollback has to be reversible, and a pause that destroyed the
-- queue would be a one-way door. The drain simply refuses to claim while it is
-- on, and resumes where it left off when it is off.
alter table public.app_settings
  add column if not exists messaging_paused boolean not null default false;
alter table public.app_settings
  add column if not exists messaging_last_tick_at timestamptz;

-- ── Three profile column defaults that fabricate answers ────────────────────
--
-- `handle_new_user` inserts only (id, full_name), so every one of these fires
-- on every signup and the value is indistinguishable from a chosen one.
--
--   role         default 'manager' — the worst of the three. getScope() and six
--                db modules read profiles.role to decide whether somebody sees
--                their own uploads or the whole organization's book, so a row
--                nobody ever set read as a supervisor. Measured before the fix:
--                eight profiles whose profiles.role and organization_members.role
--                disagree, one of them a `rep` in the members table reading as
--                `admin` here. The application no longer trusts this column for
--                that decision (see resolveSupervisor in src/lib/db/scope.ts) —
--                dropping the default stops it seeding the drift in the first
--                place.
--   team         default 'AIATWORK' — the product is multi-tenant; a workspace
--                in another industry got this company's name on every new user.
--   avatar_color default '#3B82F6' — nothing in the application has ever written
--                this column (all 50 rows carry the default), so the `seed`-based
--                tone that tracks light and dark was permanently unreachable
--                behind a fixed hex that does not.
--
-- Existing rows are NOT rewritten: the honest fix for a value nobody chose is to
-- stop fabricating new ones, not to fabricate a different one over the top.
alter table public.profiles alter column role drop default;
alter table public.profiles alter column team drop default;
alter table public.profiles alter column avatar_color drop default;

-- ── …and the org timezone default, which was a TCPA input ───────────────────
--
-- `organizations.timezone` defaulted to America/Los_Angeles and nothing in
-- createOrganization or onboarding ever set the column, so it was
-- indistinguishable from a zone an admin had chosen. Measured: ten of eleven
-- workspaces carried it; the eleventh chose Europe/Stockholm, which is what a
-- real choice looks like.
--
-- It is the LAST-RESORT zone for the calling-window check (the contact's own
-- zone, inferred from their area code, is tried first), and it is the zone every
-- "today" boundary rolls on. For a Central-time workspace that means the window
-- ran two hours behind and the day rolled at 2am local — and orgTimezone()'s
-- documented America/Chicago fallback could never fire, because the column was
-- never empty.
--
-- Existing rows keep their value; the application treats the exact default
-- string as unset (storedOrgTimezone) and the settings form now says so rather
-- than showing a pre-filled zone nobody picked.
alter table public.organizations alter column timezone drop default;

-- ── Counts that used to be page lengths ─────────────────────────────────────
--
-- Three screens computed their totals by FETCHING rows and taking `.length`,
-- with a `.limit()` far above the PostgREST response ceiling and no `.range()`.
-- A limit above that ceiling is not a limit, it is a lie about one: the
-- response is truncated silently and the count is a share of one page.
--
-- Measured before these existed: 9,816 leads across 73 packs shared out among
-- every pack on the Assignments board, and 34,079 call records sampled at ~59%
-- and rendered as six campaign totals plus a conversion funnel. Neither screen
-- said anything.
--
-- These functions GROUP only. Every classification rule — which statuses are
-- dialable, what counts as connected, which bucket a lead lands in — stays in
-- TypeScript where there is exactly one copy of it; the callers sum the `n`
-- column. Two definitions of "connected", one in SQL and one in JS, is the
-- failure mode these deliberately avoid.
create or replace function public.app_pack_progress(p_pack_ids uuid[])
returns table (lead_pack_id uuid, status text, contacted boolean, n bigint)
language sql stable security definer set search_path = public as $$
  select l.lead_pack_id,
         coalesce(l.status, 'new')            as status,
         (l.last_contacted_at is not null)    as contacted,
         count(*)                             as n
    from public.leads l
   where l.lead_pack_id = any(p_pack_ids)
   group by 1, 2, 3;
$$;
revoke all on function public.app_pack_progress(uuid[]) from public, anon, authenticated;

-- ── Who may ask a definer function about whom ───────────────────────────────
--
-- Three of the counting functions below are called with the SESSION client, not
-- the service-role one: getCampaigns and getReportingData fall back to
-- own-scoped reads when isAdminConfigured() is false. A security-definer
-- function with execute revoked from `authenticated` simply fails there.
--
-- So the grant has to exist — and the moment it does, a definer function that
-- takes an org id is a cross-tenant read with extra steps, because definer
-- bypasses the RLS that would otherwise have stopped it. This enforces for
-- itself what RLS would have: service_role may ask anything; anybody else may
-- only ask about THEMSELVES.
--
-- Verified against the live database: an authenticated caller asking for
-- another org's rows is REFUSED, for another user's rows REFUSED, for their own
-- ALLOWED.
create or replace function public.app_guard_self_scope(p_column text, p_value uuid)
returns void language plpgsql stable security definer set search_path = public as $$
begin
  if current_setting('request.jwt.claims', true) is null
     or coalesce(current_setting('request.jwt.claim.role', true),
                 (current_setting('request.jwt.claims', true)::json ->> 'role')) = 'service_role' then
    return;
  end if;
  if p_column <> 'owner_id' or p_value is distinct from auth.uid() then
    raise exception 'not allowed: this role may only read its own rows';
  end if;
end;
$$;
revoke all on function public.app_guard_self_scope(text, uuid) from public, anon;
grant execute on function public.app_guard_self_scope(text, uuid) to authenticated, service_role;

-- p_column is whitelisted rather than interpolated: it reaches format() and
-- there is no version of this where a caller-supplied identifier goes through
-- unchecked.
drop function if exists public.app_campaign_lead_counts(text, uuid);
create function public.app_campaign_lead_counts(
  p_column text, p_value uuid
) returns table (campaign_id text, status text, contacted boolean, n bigint)
language plpgsql stable security definer set search_path = public as $$
begin
  if p_column not in ('org_id', 'owner_id') then
    raise exception 'app_campaign_lead_counts: p_column must be org_id or owner_id';
  end if;
  perform public.app_guard_self_scope(p_column, p_value);
  return query execute format($q$
    select coalesce(l.campaign_id::text, '')  as campaign_id,
           coalesce(l.status, 'new')          as status,
           (l.last_contacted_at is not null)  as contacted,
           count(*)                           as n
      from public.leads l
     where l.%I = $1
     group by 1, 2, 3
  $q$, p_column) using p_value;
end;
$$;
revoke all on function public.app_campaign_lead_counts(text, uuid) from public, anon;
grant execute on function public.app_campaign_lead_counts(text, uuid) to authenticated, service_role;

drop function if exists public.app_campaign_call_counts(text, uuid);
create function public.app_campaign_call_counts(
  p_column text, p_value uuid
) returns table (
  campaign_id text, outcome text, script_variant text,
  human_connected boolean, n bigint
)
language plpgsql stable security definer set search_path = public as $$
begin
  if p_column not in ('org_id', 'owner_id') then
    raise exception 'app_campaign_call_counts: p_column must be org_id or owner_id';
  end if;
  perform public.app_guard_self_scope(p_column, p_value);
  return query execute format($q$
    select coalesce(c.campaign_id::text, '') as campaign_id,
           c.outcome::text                   as outcome,
           c.script_variant::text            as script_variant,
           c.human_connected                 as human_connected,
           count(*)                          as n
      from public.call_records c
     where c.%I = $1
     group by 1, 2, 3, 4
  $q$, p_column) using p_value;
end;
$$;
revoke all on function public.app_campaign_call_counts(text, uuid) from public, anon;
grant execute on function public.app_campaign_call_counts(text, uuid) to authenticated, service_role;

-- Per-rep call counts for a calendar day in the org's OWN zone.
--
-- Both Live Floor surfaces fetched the call ROWS for a 26-hour window with
-- `.limit(20000)` and no `.range()`, so the real bound was the response ceiling.
-- The rows are ordered started_at DESC, which means what truncation removed was
-- THIS MORNING. Measured: the busiest day here is 2,678 calls — already past it,
-- so a rep has been shown fewer calls than they made.
--
-- The day key uses `at time zone`, the same calendar-day rule zonedDayKey
-- applies in JS; the 26-hour window straddles two of them, which is why the key
-- is returned rather than assumed.
create or replace function public.app_floor_calls_by_day(
  p_org uuid, p_since timestamptz, p_tz text
) returns table (owner_id uuid, day_key text, n bigint)
language sql stable security definer set search_path = public as $$
  select c.owner_id,
         to_char((c.started_at at time zone p_tz)::date, 'YYYY-MM-DD') as day_key,
         count(*) as n
    from public.call_records c
   where c.org_id = p_org
     and c.started_at >= p_since
   group by 1, 2;
$$;
revoke all on function public.app_floor_calls_by_day(uuid, timestamptz, text) from public, anon, authenticated;

-- How many leads one person owns, per org. Backs /api/leads/debug, whose entire
-- job is answering "did my leads vanish?" — and whose decision rule was
-- `ownedTotalAnyOrg === 0 ⇒ the rows really are gone`, evaluated against a page
-- length. Seven owners here hold more than the ceiling; the largest holds
-- 13,347. Only org_id is grouped, so no contact data leaves the table.
create or replace function public.app_owned_lead_counts(p_owner uuid)
returns table (org_id uuid, n bigint)
language sql stable security definer set search_path = public as $$
  select l.org_id, count(*) as n
    from public.leads l
   where l.owner_id = p_owner
   group by 1;
$$;
revoke all on function public.app_owned_lead_counts(uuid) from public, anon, authenticated;

-- ── CSV export enrichment: exactly ONE row per lead ─────────────────────────
--
-- These were `.in("lead_id", […1,000 ids]).limit(20_000)` with no `.range()`,
-- newest-first, first-wins in JS. Measured: 3,201 leads have calls, averaging
-- 10.6 each, so a 1,000-lead page carries about 890 call rows against a
-- 1,000-row ceiling — at the edge on an average page, over it on any busier
-- one. Past it, "latest outcome" exported BLANK for leads that plainly have
-- call history. The appointments query was ASCENDING, so what it dropped was
-- every far-future booking.
--
-- DISTINCT ON applies the same ordering the loops used, so the definitions of
-- "latest" and "next" are unchanged, and the row count is now bounded by the
-- number of leads being enriched rather than by their history.
create or replace function public.app_export_latest_call(p_lead_ids uuid[])
returns table (lead_id uuid, outcome text, disposition text)
language sql stable security definer set search_path = public as $$
  select distinct on (c.lead_id)
         c.lead_id, c.outcome::text, c.disposition::text
    from public.call_records c
   where c.lead_id = any(p_lead_ids)
   order by c.lead_id, c.started_at desc;
$$;
revoke all on function public.app_export_latest_call(uuid[]) from public, anon, authenticated;

create or replace function public.app_export_next_appointment(p_lead_ids uuid[])
returns table (lead_id uuid, scheduled_at timestamptz)
language sql stable security definer set search_path = public as $$
  select distinct on (a.lead_id) a.lead_id, a.scheduled_at
    from public.appointments a
   where a.lead_id = any(p_lead_ids)
     and a.status = 'scheduled'
     and a.scheduled_at >= now()
   order by a.lead_id, a.scheduled_at asc;
$$;
revoke all on function public.app_export_next_appointment(uuid[]) from public, anon, authenticated;

create or replace function public.app_export_next_callback(p_lead_ids uuid[])
returns table (lead_id uuid, due_at text)
language sql stable security definer set search_path = public as $$
  select distinct on (cb.lead_id) cb.lead_id, cb.due_at::text
    from public.callbacks cb
   where cb.lead_id = any(p_lead_ids)
     and cb.status not in ('completed', 'cancelled')
     and cb.due_at is not null
   order by cb.lead_id, cb.due_at asc;
$$;
revoke all on function public.app_export_next_callback(uuid[]) from public, anon, authenticated;

-- ── touches_v.connected was false for every row that has ever existed ───────
--
-- The column was `coalesce(human_connected, false)`, and NOTHING in the product
-- writes human_connected — 0 non-null of 34,079 rows, measured. So this read
-- false for the entire table, for the view's whole life. The three other SQL
-- consumers of that column coalesce to the outcome-based definition; this one
-- did not, and it is the view an analyst would reach for.
--
-- Mirrors isConnectedRecord (src/lib/metrics/definitions.ts) exactly, including
-- the rule that voicemail is never a connect and wins even over a stray
-- human_connected = true: AMD race conditions have set that flag on machine
-- pickups, and a voicemail must never inflate a connect rate. After this,
-- 2,242 of 34,083 rows read connected.
create or replace view public.touches_v as
 select id as touch_id,
    org_id,
    lead_id,
    'outbound'::text as direction,
    case when channel = 'ai'::text then 'ai_call'::text else 'manual_call'::text end as channel,
    call_sid as provider_id,
    conversation_id,
    client_attempt_id as idempotency_key,
    started_at as initiated_at,
    case
      when outcome = 'voicemail'::text then false
      when human_connected is not null then human_connected
      else outcome = any (array['appointment_booked','callback_scheduled','qualified','not_interested','do_not_call'])
    end as connected,
    duration_sec,
    talk_sec,
    outcome,
    disposition,
    case when channel = 'ai'::text then 'ai_agent'::text else 'rep'::text end as actor_kind,
    owner_id as actor_id,
    campaign_id
   from public.call_records cr;

-- ── Field averages, computed rather than sampled ────────────────────────────
--
-- The two dollar figures on Reports came from a `.limit(5000)` row fetch with
-- no `.range()`, so they averaged the newest ~1,000 leads — rendered in the
-- same panel, in the same typography, as EV / pool / battery shares that are
-- exact head counts. Zeroes and nulls are excluded, matching what the JS did: a
-- lead with no bill on file is missing data, not a $0 bill.
create or replace function public.app_lead_field_averages(
  p_column text, p_value uuid, p_org uuid
) returns table (avg_utility_bill numeric, avg_solar_payment numeric)
language plpgsql stable security definer set search_path = public as $$
begin
  if p_column not in ('org_id', 'owner_id') then
    raise exception 'app_lead_field_averages: p_column must be org_id or owner_id';
  end if;
  perform public.app_guard_self_scope(p_column, p_value);
  return query execute format($q$
    select avg(l.utility_bill) filter (where l.utility_bill > 0),
           avg(l.solar_payment) filter (where l.solar_payment > 0)
      from public.leads l
     where l.%I = $1
       and ($2 is null or l.org_id = $2)
  $q$, p_column) using p_value, p_org;
end;
$$;
revoke all on function public.app_lead_field_averages(text, uuid, uuid) from public, anon;
grant execute on function public.app_lead_field_averages(text, uuid, uuid) to authenticated, service_role;

-- ═════════════════════════════════════════════════════════════════════════════
-- ABANDONMENT-RATE TRACKING — added alongside raising parallel dialing to 10x
-- ═════════════════════════════════════════════════════════════════════════════
-- The FTC's Telemarketing Sales Rule (16 CFR §310.4(b)(4)) caps the ABANDONMENT
-- RATE — calls a live person answers that don't reach a live agent within 2
-- seconds — at 3%, measured per calling campaign over a rolling 30-day window.
-- This app's own /terms page already promises customers that rate stays within
-- legal limits. Raising how many lines ring at once directly raises how often
-- two lines answer close enough together that only one can be greeted — so the
-- ceiling change and this table are one change, not two.
--
-- One row per RESOLVED parallel round (every time /api/twilio/status's "release
-- the losing legs" logic determines a winner). answered_count is how many of
-- the round's lines were found genuinely answered — not still ringing — at that
-- moment; 1 is clean (no collision), 2+ means that many minus one went
-- ungreeted. See src/lib/dialer/abandonment.ts for the rate math this feeds,
-- and src/lib/db/abandonment.ts for the read/write.
create table if not exists public.dial_parallel_rounds (
  id             uuid primary key default gen_random_uuid(),
  org_id         uuid references public.organizations (id) on delete cascade,
  room           text not null,
  lines_dialed   int not null default 1,
  answered_count int not null default 1,
  created_at     timestamptz not null default now()
);
create index if not exists dial_parallel_rounds_org_time_idx
  on public.dial_parallel_rounds (org_id, created_at);
-- Service-role only (RLS on, no policies) — written by the Twilio status
-- webhook (no signed-in user in that request) and read by the admin API route,
-- both via the service-role client; never exposed to a browser directly.
alter table public.dial_parallel_rounds enable row level security;

-- Aggregated server-side rather than fetched row-by-row into JS: a high-volume
-- org running near 10x lines for 30 days is exactly the org this table most
-- needs to answer fast, and exactly the one a row-limited client fetch would
-- silently under-count for.
create or replace function public.app_abandonment_snapshot(p_org uuid, p_since timestamptz)
returns table (answered bigint, abandoned bigint)
language sql stable security definer set search_path = public as $$
  select
    coalesce(sum(answered_count), 0)::bigint,
    coalesce(sum(greatest(answered_count - 1, 0)), 0)::bigint
  from public.dial_parallel_rounds
  where org_id = p_org and created_at >= p_since;
$$;
revoke all on function public.app_abandonment_snapshot(uuid, timestamptz) from public, anon, authenticated;
grant execute on function public.app_abandonment_snapshot(uuid, timestamptz) to service_role;

notify pgrst, 'reload schema';
