-- Console-registered GitHub accounts (Settings → GitHub accounts).
-- Tokens live server-side only: list endpoints return a hint, never the
-- secret, and the browser never stores a token. Tenants own their rows and
-- one account per tenant is the default used to preselect the console picker.

create table public.github_accounts (
    id uuid primary key,
    tenant_id text not null,
    label text not null,
    username text not null default '',
    token text not null,
    is_default boolean not null default false,
    created_at timestamptz not null default now()
);

create unique index github_accounts_tenant_label_idx
    on public.github_accounts (tenant_id, lower(label));

create index github_accounts_tenant_created_idx
    on public.github_accounts (tenant_id, created_at);

alter table public.github_accounts enable row level security;
alter table public.github_accounts force row level security;

revoke all on public.github_accounts from public, anon, authenticated;

comment on table public.github_accounts is
    'Server-only GitHub identities set up in the console settings; tokens are write-only from the browser.';
