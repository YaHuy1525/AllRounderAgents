-- MSP vendor registry (M4): one row per vendor a tenant pays, keyed by the
-- vendor ref the bills lane derives from the sender domain. The extract step
-- looks the sender address up here and compares the bill's remittance bank
-- details against the registered ones; an unregistered sender or a changed
-- account escalates to a human. Server-only: the console and the onboarding
-- script read and write them through the API.

create table public.msp_vendors (
    tenant_id text not null
        references public.msp_connections (tenant_id) on delete cascade,
    vendor_ref text not null check (
        vendor_ref ~ '^[a-z0-9][a-z0-9-]*$' and char_length(vendor_ref) <= 40
    ),
    name text not null default '',
    emails text[] not null check (cardinality(emails) >= 1),
    account_name text not null default '',
    bsb text not null default '',
    account_number text not null default '',
    created_at timestamptz not null default now(),
    updated_at timestamptz not null default now(),
    primary key (tenant_id, vendor_ref)
);

alter table public.msp_vendors enable row level security;
alter table public.msp_vendors force row level security;

revoke all on public.msp_vendors from public, anon, authenticated;

comment on table public.msp_vendors is
    'Server-only MSP vendor registry; the bills lane matches sender addresses and remittance details against it.';
comment on column public.msp_vendors.emails is
    'Every address the vendor bills from; matched case-insensitively by the vendor lookup.';

-- The bills lane files its cases under the bills domain; the cases check still
-- listed the pre-M4 domains, so `bill-...` case ids failed with a violation.
alter table public.cases drop constraint cases_domain_check;
alter table public.cases
add constraint cases_domain_check
    check (domain in ('code', 'finance', 'marketing', 'support', 'unknown', 'msp', 'bills'));
