-- N2 connector registry + vault.
--
-- `connectors` is the durable seed + audit copy of the connectable-provider
-- catalog. The API serves the catalog from policy/tools.yaml (`connectors:`)
-- and apps/api/tests/test_connectors.py pins this seed to it (provider, scope
-- and class must match, so adding a provider is a deliberate two-sided edit).
--
-- `connector_vault_refs` is the per-tenant connection state: one row per
-- (tenant, provider). secret_ref holds the tenant's stored credential
-- material, write-only from the browser -- list endpoints return a last-four
-- hint, never the secret -- and disconnecting deletes the row. Swap the
-- column for a real secrets-manager pointer when one lands.
--
-- Connecting a provider never grants a tool: execution permissions stay in
-- the tools.yaml matrix, and no run gains a new execution path from a row
-- landing here.

create table if not exists public.connectors (
  provider text primary key,
  scope text not null,
  class text not null,
  description text not null default '',
  created_at timestamptz not null default now()
);

insert into public.connectors (provider, scope, class, description) values
  ('github', 'repo-allowlist', 'read-only',
   'Repository reads and pull-request actions for the coding lanes.'),
  ('jira', 'jira-projects', 'auto',
   'Comment, transition and spawn tickets behind the desk seam.'),
  ('gmail', 'hr-help:send', 'approval',
   'Sends the HR help desk reply behind the hr-help:send receipt.'),
  ('calendar', 'screening:schedule', 'approval',
   'Schedules interview slots behind the screening:schedule receipt.'),
  ('slack', 'approver-notify', 'approval',
   'Approver notifications only - never a workflow action.')
on conflict (provider) do update
set scope = excluded.scope,
    class = excluded.class,
    description = excluded.description;

create table if not exists public.connector_vault_refs (
  tenant_id text not null,
  provider text not null references public.connectors (provider),
  secret_ref text not null,
  connected_at timestamptz not null default now(),
  primary key (tenant_id, provider)
);

alter table public.connectors enable row level security;
alter table public.connectors force row level security;
revoke all on public.connectors from public, anon, authenticated;

alter table public.connector_vault_refs enable row level security;
alter table public.connector_vault_refs force row level security;
revoke all on public.connector_vault_refs from public, anon, authenticated;

comment on table public.connectors is
  'Connectable provider catalog (N2); seed mirrors policy/tools.yaml connectors.';
comment on table public.connector_vault_refs is
  'Per-tenant connector connections (N2); secret_ref is write-only from the browser.';
