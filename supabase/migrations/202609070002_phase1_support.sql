create table public.cases (
    id uuid primary key default gen_random_uuid(),
    ticket_key text not null,
    domain text not null check (
        domain in ('code', 'finance', 'marketing', 'support', 'unknown')
    ),
    status text not null default 'open',
    verdict jsonb,
    evidence jsonb,
    cost_usd_micro bigint not null default 0 check (cost_usd_micro >= 0),
    outcome text,
    created_at timestamptz not null default now(),
    updated_at timestamptz not null default now()
);

create index cases_ticket_key_idx on public.cases (ticket_key);
create index cases_domain_status_idx on public.cases (domain, status);

create table public.case_events (
    id bigint generated always as identity primary key,
    case_id uuid not null references public.cases (id) on delete cascade,
    actor text not null check (actor in ('agent', 'human', 'system')),
    kind text not null,
    payload jsonb not null,
    created_at timestamptz not null default now()
);

create index case_events_case_time_idx on public.case_events (case_id, created_at, id);

create table public.approvals (
    id uuid primary key default gen_random_uuid(),
    case_id uuid not null references public.cases (id) on delete cascade,
    payload jsonb not null,
    approver text not null,
    decision text check (decision in ('approved', 'rejected', 'expired')),
    comment text,
    decided_at timestamptz,
    expires_at timestamptz not null,
    created_at timestamptz not null default now(),
    constraint approvals_decision_time_consistent check (
        (decision is null and decided_at is null)
        or (decision is not null and decided_at is not null)
    )
);

create index approvals_pending_idx
    on public.approvals (expires_at)
    where decision is null;

create table public.kb_documents (
    id uuid primary key default gen_random_uuid(),
    domain text not null check (domain in ('code', 'finance', 'marketing', 'support')),
    source_uri text not null,
    source_version text not null,
    title text not null,
    content_sha256 text not null,
    metadata jsonb not null default '{}'::jsonb,
    created_at timestamptz not null default now(),
    unique (source_uri, source_version)
);

create table public.kb_chunks (
    id uuid primary key default gen_random_uuid(),
    document_id uuid not null references public.kb_documents (id) on delete cascade,
    ordinal integer not null check (ordinal >= 0),
    content text not null,
    source_span text not null,
    embedding_model text not null,
    embedding extensions.vector(1536) not null,
    metadata jsonb not null default '{}'::jsonb,
    created_at timestamptz not null default now(),
    unique (document_id, ordinal)
);

create index kb_chunks_embedding_hnsw_idx
    on public.kb_chunks
    using hnsw (embedding extensions.vector_cosine_ops);

alter table public.cases enable row level security;
alter table public.cases force row level security;
alter table public.case_events enable row level security;
alter table public.case_events force row level security;
alter table public.approvals enable row level security;
alter table public.approvals force row level security;
alter table public.kb_documents enable row level security;
alter table public.kb_documents force row level security;
alter table public.kb_chunks enable row level security;
alter table public.kb_chunks force row level security;

revoke all on public.cases from public, anon, authenticated;
revoke all on public.case_events from public, anon, authenticated;
revoke all on public.approvals from public, anon, authenticated;
revoke all on public.kb_documents from public, anon, authenticated;
revoke all on public.kb_chunks from public, anon, authenticated;
revoke all on sequence public.case_events_id_seq from public, anon, authenticated;

comment on table public.approvals is
    'Server-owned approval records; browser access requires a future explicit least-privilege policy.';
