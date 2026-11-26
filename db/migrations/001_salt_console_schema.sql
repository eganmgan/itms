create extension if not exists pgcrypto;

create table if not exists users (
  id uuid primary key default gen_random_uuid(),
  name text not null,
  email text not null unique,
  role text not null check (role in ('admin', 'operator', 'viewer')),
  status text not null check (status in ('active', 'suspended')),
  last_active_at timestamptz
);

create table if not exists scripts (
  id bigserial primary key,
  name text not null,
  type text not null check (type in ('sls', 'sh')),
  created_by uuid not null references users(id),
  updated_at timestamptz not null default now()
);

create table if not exists script_variants (
  id bigserial primary key,
  script_id bigint not null references scripts(id) on delete cascade,
  os text not null check (os in ('default', 'Ubuntu', 'Debian', 'Rocky Linux')),
  body text not null,
  unique (script_id, os)
);

create table if not exists schedules (
  id bigserial primary key,
  name text not null,
  scope_key text not null,
  fn text not null,
  arg text,
  script_id bigint references scripts(id) on delete set null,
  cron text not null,
  enabled boolean not null default true,
  next_run_at timestamptz,
  created_by uuid not null references users(id)
);

create table if not exists jobs (
  jid text primary key,
  fn text not null,
  scope_key text not null,
  target_expr text not null,
  minions text[] not null,
  succeeded int not null default 0,
  failed int not null default 0,
  changed int not null default 0,
  status text not null,
  started_at timestamptz not null,
  finished_at timestamptz,
  created_by uuid not null references users(id)
);

create table if not exists audit (
  id bigserial primary key,
  actor_id uuid references users(id),
  action text not null,
  detail jsonb not null default '{}'::jsonb,
  kind text not null check (kind in ('auth', 'config', 'run', 'run-fail')),
  created_at timestamptz not null default now()
);

create index if not exists idx_jobs_started_at on jobs(started_at desc);
create index if not exists idx_audit_created_at on audit(created_at desc);
create index if not exists idx_schedules_enabled_next_run on schedules(enabled, next_run_at);
