create table public.risk_scores (
    id uuid primary key default gen_random_uuid(),
    case_id uuid references public.cases (id) on delete cascade,
    ticket_key text not null,
    action text not null,
    blast_radius text not null check (blast_radius in ('low', 'med', 'high')),
    reversibility text not null check (
        reversibility in ('reversible', 'compensable', 'irreversible')
    ),
    score integer not null check (score between 0 and 100),
    gate text not null check (gate in ('auto', 'approval', 'refuse')),
    reasons jsonb not null default '[]'::jsonb,
    policy_version text not null,
    created_at timestamptz not null default now()
);

create index risk_scores_ticket_idx on public.risk_scores (ticket_key, created_at);

create table public.coding_runs (
    id uuid primary key default gen_random_uuid(),
    case_id uuid not null references public.cases (id) on delete cascade,
    repository text not null,
    base_ref text not null,
    head_ref text,
    root_cause jsonb not null,
    validation jsonb not null default '{}'::jsonb,
    draft_pull_request_url text,
    status text not null default 'investigating',
    created_at timestamptz not null default now(),
    updated_at timestamptz not null default now()
);

create index coding_runs_case_idx on public.coding_runs (case_id, created_at);

create table public.code_artifacts (
    id uuid primary key default gen_random_uuid(),
    coding_run_id uuid not null references public.coding_runs (id) on delete cascade,
    artifact_type text not null check (
        artifact_type in ('source', 'patch', 'validation', 'pull_request', 'evidence')
    ),
    uri text not null,
    content_sha256 text,
    metadata jsonb not null default '{}'::jsonb,
    created_at timestamptz not null default now()
);

create index code_artifacts_run_idx on public.code_artifacts (coding_run_id, created_at);

alter table public.risk_scores enable row level security;
alter table public.risk_scores force row level security;
alter table public.coding_runs enable row level security;
alter table public.coding_runs force row level security;
alter table public.code_artifacts enable row level security;
alter table public.code_artifacts force row level security;

revoke all on public.risk_scores from public, anon, authenticated;
revoke all on public.coding_runs from public, anon, authenticated;
revoke all on public.code_artifacts from public, anon, authenticated;

comment on table public.coding_runs is
    'Phase 2 persistence only; Foundation/Phase 0 performs no GitHub side effects.';
