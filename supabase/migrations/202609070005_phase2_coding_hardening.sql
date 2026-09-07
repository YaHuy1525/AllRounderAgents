-- Additive Phase 2 hardening. The earlier Phase 2 schema stub remains immutable.
alter table public.coding_runs add column tenant_id text;
update public.coding_runs r
set tenant_id = c.tenant_id from public.cases c
where r.case_id = c.id and r.tenant_id is null;
alter table public.coding_runs alter column tenant_id set not null;
alter table public.coding_runs
    add column ticket_key text not null default 'LEGACY-0',
    add column source_sha text not null default repeat('0', 40)
        check (source_sha ~ '^[a-f0-9]{40,64}$'),
    add column problem_redacted text not null default '',
    add column idempotency_key text not null default '';
update public.coding_runs set head_ref = 'legacy/' || id::text where head_ref is null;
alter table public.coding_runs alter column head_ref set not null;
alter table public.coding_runs
    add constraint coding_runs_tenant_id_unique unique (id, tenant_id),
    add constraint coding_runs_start_idempotency_unique
        unique (tenant_id, repository, head_ref, idempotency_key);
create index coding_runs_tenant_created_idx
    on public.coding_runs (tenant_id, created_at desc);
alter table public.coding_runs enable row level security;
alter table public.coding_runs force row level security;
revoke all on public.coding_runs from public, anon, authenticated;

create table public.coding_rca_evidence (
    coding_run_id uuid not null,
    tenant_id text not null,
    evidence jsonb not null check (jsonb_typeof(evidence) = 'array'),
    confidence double precision not null default 0 check (confidence between 0 and 1),
    created_at timestamptz not null default now(),
    primary key (coding_run_id, tenant_id),
    foreign key (coding_run_id, tenant_id)
        references public.coding_runs (id, tenant_id) on delete cascade
);

create table public.coding_patch_manifests (
    coding_run_id uuid not null,
    tenant_id text not null,
    patch_hash text not null check (patch_hash ~ '^[a-f0-9]{64}$'),
    manifest jsonb not null,
    created_at timestamptz not null default now(),
    primary key (coding_run_id, tenant_id),
    foreign key (coding_run_id, tenant_id)
        references public.coding_runs (id, tenant_id) on delete cascade
);

create table public.coding_validation_results (
    id bigint generated always as identity primary key,
    coding_run_id uuid not null,
    tenant_id text not null,
    attempt smallint not null check (attempt between 1 and 2),
    passed boolean not null,
    report jsonb not null,
    created_at timestamptz not null default now(),
    unique (coding_run_id, tenant_id, attempt),
    foreign key (coding_run_id, tenant_id)
        references public.coding_runs (id, tenant_id) on delete cascade
);

create table public.coding_pr_receipts (
    coding_run_id uuid not null,
    tenant_id text not null,
    repository text not null,
    branch text not null,
    patch_hash text not null check (patch_hash ~ '^[a-f0-9]{64}$'),
    receipt jsonb not null,
    created_at timestamptz not null default now(),
    primary key (coding_run_id, tenant_id),
    unique (tenant_id, repository, branch, patch_hash),
    foreign key (coding_run_id, tenant_id)
        references public.coding_runs (id, tenant_id) on delete cascade
);

alter table public.coding_rca_evidence enable row level security;
alter table public.coding_rca_evidence force row level security;
alter table public.coding_patch_manifests enable row level security;
alter table public.coding_patch_manifests force row level security;
alter table public.coding_validation_results enable row level security;
alter table public.coding_validation_results force row level security;
alter table public.coding_pr_receipts enable row level security;
alter table public.coding_pr_receipts force row level security;

revoke all on public.coding_rca_evidence from public, anon, authenticated;
revoke all on public.coding_patch_manifests from public, anon, authenticated;
revoke all on public.coding_validation_results from public, anon, authenticated;
revoke all on public.coding_pr_receipts from public, anon, authenticated;
revoke all on sequence public.coding_validation_results_id_seq
    from public, anon, authenticated;

comment on table public.coding_pr_receipts is
    'Server-only Draft PR receipts and branch+patch idempotency ledger; no browser grants.';
