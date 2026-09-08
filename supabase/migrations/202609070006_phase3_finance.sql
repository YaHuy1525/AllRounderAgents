-- Additive Phase 3 finance recon and sandbox posting. Server-only; no browser grants.
create table public.finance_runs (
    id uuid primary key,
    case_id text not null,
    tenant_id text not null,
    ticket_key text not null,
    period text not null check (period ~ '^\d{4}-\d{2}$'),
    ledger jsonb not null check (jsonb_typeof(ledger) = 'array'),
    bank jsonb not null check (jsonb_typeof(bank) = 'array'),
    exceptions jsonb not null check (jsonb_typeof(exceptions) = 'array'),
    audit_pack jsonb not null,
    posting jsonb,
    status text not null check (status in ('awaiting_approval', 'posted', 'escalated')),
    idempotency_key text not null,
    created_at timestamptz not null default now(),
    unique (id, tenant_id),
    unique (tenant_id, ticket_key, period, idempotency_key)
);

create index finance_runs_tenant_created_idx
    on public.finance_runs (tenant_id, created_at desc);

create table public.finance_postings (
    id bigint generated always as identity primary key,
    finance_run_id uuid not null,
    tenant_id text not null,
    ledger text not null check (ledger = 'sandbox'),
    period text not null,
    action_hash text not null check (action_hash ~ '^[a-f0-9]{64}$'),
    receipt_id text not null,
    lines jsonb not null check (jsonb_typeof(lines) = 'array'),
    artifact text not null,
    created_at timestamptz not null default now(),
    unique (tenant_id, action_hash),
    unique (tenant_id, receipt_id),
    foreign key (finance_run_id, tenant_id)
        references public.finance_runs (id, tenant_id) on delete cascade
);

alter table public.finance_runs enable row level security;
alter table public.finance_runs force row level security;
alter table public.finance_postings enable row level security;
alter table public.finance_postings force row level security;

revoke all on public.finance_runs from public, anon, authenticated;
revoke all on public.finance_postings from public, anon, authenticated;
revoke all on sequence public.finance_postings_id_seq from public, anon, authenticated;

comment on table public.finance_postings is
    'Server-only sandbox journal posts bound to consumed approval receipts; no browser grants.';
