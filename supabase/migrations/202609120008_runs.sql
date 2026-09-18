-- Parallel-safe workflow runs (PR Review + shared run infrastructure).
-- Every run is namespaced by its runId; every step pauses for an explicit,
-- receipt-backed human decision. Server-only; no browser grants.

create table public.runs (
    id uuid primary key,
    tenant_id text not null,
    workflow text not null,
    ticket_key text not null,
    case_id text not null,
    status text not null default 'queued' check (
        status in (
            'queued', 'running', 'awaiting_human', 'blocked',
            'completed', 'failed', 'cancelled'
        )
    ),
    attempt integer not null default 0 check (attempt >= 0),
    queue_position integer check (queue_position is null or queue_position >= 1),
    lock_target text,
    lock_owner text,
    outcome text,
    cancel_reason text,
    input jsonb not null default '{}'::jsonb,
    side_effects jsonb not null default '{}'::jsonb,
    started_at timestamptz not null default now(),
    heartbeat_at timestamptz not null default now(),
    finished_at timestamptz,
    created_at timestamptz not null default now()
);

create index runs_tenant_ticket_idx
    on public.runs (tenant_id, ticket_key, started_at desc);

create index runs_open_idx
    on public.runs (status, heartbeat_at)
    where status in ('queued', 'running', 'blocked');

create index runs_lock_target_idx
    on public.runs (lock_target)
    where lock_target is not null;

create table public.run_steps (
    id bigint generated always as identity primary key,
    run_id uuid not null references public.runs (id) on delete cascade,
    step_id text not null,
    step_index integer not null check (step_index >= 0),
    title text not null,
    state text not null default 'pending' check (
        state in ('pending', 'running', 'awaiting_human', 'blocked', 'done', 'failed')
    ),
    artifact jsonb,
    decision jsonb,
    receipt text,
    action_hash text,
    regenerations integer not null default 0 check (regenerations >= 0),
    updated_at timestamptz not null default now(),
    unique (run_id, step_id)
);

create index run_steps_run_idx on public.run_steps (run_id, step_index);

alter table public.runs enable row level security;
alter table public.runs force row level security;
alter table public.run_steps enable row level security;
alter table public.run_steps force row level security;

revoke all on public.runs from public, anon, authenticated;
revoke all on public.run_steps from public, anon, authenticated;
revoke all on sequence public.run_steps_id_seq from public, anon, authenticated;

comment on table public.runs is
    'Server-only workflow runs keyed by runId; every step pauses for a receipt-backed human decision.';
comment on table public.run_steps is
    'Per-step state of a run: reviewed artifacts, decisions, and signed receipt references.';
