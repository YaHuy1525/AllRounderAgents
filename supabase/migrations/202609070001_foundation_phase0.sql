create extension if not exists vector with schema extensions;

create table public.tickets (
    id uuid primary key default gen_random_uuid(),
    ticket_key text not null unique,
    first_event_id text not null unique,
    latest_event_id text not null,
    project text not null,
    issue_type text not null,
    domain text not null check (domain in ('code', 'finance', 'marketing', 'support', 'unknown')),
    status text not null default 'received',
    normalized_payload jsonb not null,
    received_at timestamptz not null,
    created_at timestamptz not null default now(),
    updated_at timestamptz not null default now()
);

create index tickets_project_domain_idx on public.tickets (project, domain);

create table public.dispatcher_jobs (
    id bigint generated always as identity primary key,
    event_id text not null unique,
    ticket_key text not null,
    domain text not null check (domain in ('code', 'finance', 'marketing', 'support', 'unknown')),
    gate text not null check (gate in ('auto', 'approval', 'refuse')),
    workflow text not null,
    payload jsonb not null,
    status text not null default 'pending',
    attempts integer not null default 0 check (attempts >= 0),
    available_at timestamptz not null default now(),
    created_at timestamptz not null default now(),
    updated_at timestamptz not null default now()
);

create index dispatcher_jobs_ready_idx
    on public.dispatcher_jobs (status, available_at, id);

create table public.dead_letters (
    id bigint generated always as identity primary key,
    event_id text not null unique,
    ticket_key text not null,
    reason text not null,
    error text not null,
    payload jsonb not null,
    created_at timestamptz not null default now(),
    updated_at timestamptz not null default now()
);

create table public.tool_receipts (
    id uuid primary key default gen_random_uuid(),
    idempotency_key text not null unique,
    ticket_key text not null,
    action text not null,
    status text not null,
    artifacts jsonb not null default '[]'::jsonb,
    created_at timestamptz not null default now()
);

alter table public.tickets enable row level security;
alter table public.tickets force row level security;
alter table public.dispatcher_jobs enable row level security;
alter table public.dispatcher_jobs force row level security;
alter table public.dead_letters enable row level security;
alter table public.dead_letters force row level security;
alter table public.tool_receipts enable row level security;
alter table public.tool_receipts force row level security;

revoke all on public.tickets from public, anon, authenticated;
revoke all on public.dispatcher_jobs from public, anon, authenticated;
revoke all on public.dead_letters from public, anon, authenticated;
revoke all on public.tool_receipts from public, anon, authenticated;
revoke all on sequence public.dispatcher_jobs_id_seq from public, anon, authenticated;
revoke all on sequence public.dead_letters_id_seq from public, anon, authenticated;

comment on table public.dispatcher_jobs is
    'Server-only Phase 0 queue. No browser RLS policy is intentionally defined.';
