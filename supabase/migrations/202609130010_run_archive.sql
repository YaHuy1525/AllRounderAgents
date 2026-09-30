-- Run archive: the durable history mirror for terminal runs.
-- Redis keeps runs hot for a bounded TTL; this table is the long-lived copy
-- the console's history scope reads (archive ∪ Redis). Best-effort by
-- design: a failing archive write never fails a run. Server-only.

create table public.run_archive (
    run_id uuid primary key,
    tenant_id text not null,
    workflow text not null,
    ticket_key text not null,
    case_id text not null,
    status text not null check (
        status in (
            'queued', 'running', 'awaiting_human', 'blocked',
            'completed', 'failed', 'cancelled'
        )
    ),
    outcome text,
    cancel_reason text,
    attempt integer not null default 0 check (attempt >= 0),
    steps jsonb not null default '[]'::jsonb check (jsonb_typeof(steps) = 'array'),
    side_effects jsonb not null default '{}'::jsonb,
    started_at timestamptz not null,
    heartbeat_at timestamptz not null,
    finished_at timestamptz,
    archived_at timestamptz not null default now()
);

create index run_archive_tenant_started_idx
    on public.run_archive (tenant_id, started_at desc);

create index run_archive_tenant_status_idx
    on public.run_archive (tenant_id, status, started_at desc);

alter table public.run_archive enable row level security;
alter table public.run_archive force row level security;

revoke all on public.run_archive from public, anon, authenticated;

comment on table public.run_archive is
    'Durable mirror of terminal workflow runs; the history scope reads archive ∪ Redis.';
