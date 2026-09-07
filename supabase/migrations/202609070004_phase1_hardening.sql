-- Extends the already-applied Phase 1 schema without rewriting its history.
alter table public.cases add column tenant_id text;
update public.cases set tenant_id = 'legacy' where tenant_id is null;
alter table public.cases alter column tenant_id set not null;
create index cases_tenant_ticket_idx on public.cases (tenant_id, ticket_key);

alter table public.case_events
    add column cost_usd_micro bigint not null default 0
    check (cost_usd_micro >= 0);

alter table public.approvals add column tenant_id text;
update public.approvals a
set tenant_id = c.tenant_id from public.cases c
where a.case_id = c.id and a.tenant_id is null;
alter table public.approvals alter column tenant_id set not null;
alter table public.approvals
    alter column payload set default '{}'::jsonb;
alter table public.approvals
    add column action jsonb not null default '{}'::jsonb,
    add column evidence jsonb not null default '[]'::jsonb,
    add column scope text not null default 'support:send';
create index approvals_tenant_pending_idx
    on public.approvals (tenant_id, expires_at) where decision is null;

alter table public.kb_documents add column tenant_id text;
update public.kb_documents set tenant_id = 'legacy' where tenant_id is null;
alter table public.kb_documents alter column tenant_id set not null;
alter table public.kb_documents add column source_id text;
update public.kb_documents set source_id = id::text where source_id is null;
alter table public.kb_documents alter column source_id set not null;
alter table public.kb_documents
    add column stale_after timestamptz not null default now();
alter table public.kb_documents
    drop constraint kb_documents_source_uri_source_version_key;
alter table public.kb_documents
    add constraint kb_documents_tenant_source_version_key
    unique (tenant_id, source_id, source_version);
create index kb_documents_scope_idx
    on public.kb_documents (tenant_id, domain, stale_after);

alter table public.kb_chunks
    add column span_start integer not null default 0 check (span_start >= 0),
    add column span_end integer not null default 0 check (span_end >= span_start),
    add column embedding_dimensions integer not null default 1536
    check (embedding_dimensions = 1536);

create table public.support_sends (
    id uuid primary key default gen_random_uuid(),
    idempotency_key text not null unique,
    case_id uuid not null references public.cases (id) on delete cascade,
    ticket_key text not null,
    body_redacted text not null,
    status text not null check (status in ('sent', 'failed')),
    sent_at timestamptz not null default now()
);

create table public.approval_receipt_uses (
    receipt_id text primary key,
    approval_id uuid not null references public.approvals (id) on delete cascade,
    case_id uuid not null references public.cases (id) on delete cascade,
    action_hash text not null,
    consumed_at timestamptz not null default now()
);

alter table public.support_sends enable row level security;
alter table public.support_sends force row level security;
alter table public.approval_receipt_uses enable row level security;
alter table public.approval_receipt_uses force row level security;
revoke all on public.support_sends from public, anon, authenticated;
revoke all on public.approval_receipt_uses from public, anon, authenticated;

comment on column public.kb_chunks.embedding_model is
    'Pinned provider-neutral embedding model identifier; retrieval must match exactly.';
comment on table public.approval_receipt_uses is
    'Server-only replay ledger. A receipt_id may be consumed exactly once.';
