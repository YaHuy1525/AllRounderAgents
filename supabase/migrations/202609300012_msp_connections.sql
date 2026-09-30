-- MSP connections and client registry (Console -> Settings -> MSP connections).
-- One row per tenant names the inbound mail domain the desk watches. Client
-- rows map a mailbox client ref to a display name and desk project, which is
-- what the onboarding script and the runbook step through. Server-only: the
-- console reads and writes them exclusively through the API.

create table public.msp_connections (
    tenant_id text primary key,
    inbound_domain text not null check (inbound_domain <> ''),
    display_name text not null default '',
    created_at timestamptz not null default now(),
    updated_at timestamptz not null default now()
);

create table public.msp_clients (
    tenant_id text not null
        references public.msp_connections (tenant_id) on delete cascade,
    client_ref text not null check (
        client_ref ~ '^[a-z0-9][a-z0-9.-]*$' and char_length(client_ref) <= 64
    ),
    display_name text not null default '',
    contact_email text not null default '',
    desk_project text not null default '',
    created_at timestamptz not null default now(),
    updated_at timestamptz not null default now(),
    primary key (tenant_id, client_ref)
);

alter table public.msp_connections enable row level security;
alter table public.msp_connections force row level security;
alter table public.msp_clients enable row level security;
alter table public.msp_clients force row level security;

revoke all on public.msp_connections from public, anon, authenticated;
revoke all on public.msp_clients from public, anon, authenticated;

comment on table public.msp_connections is
    'Server-only MSP tenant connection settings; the console edits them through the API.';
comment on table public.msp_clients is
    'Server-only MSP client registry keyed by the mailbox client ref embedded in case ids.';
