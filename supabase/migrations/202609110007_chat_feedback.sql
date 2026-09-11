-- Additive chat feedback capture. Server-only; stores client-computed hashes and
-- ratings, never the message text; no browser grants.
create table public.chat_feedback (
    id bigint generated always as identity primary key,
    tenant_id text not null,
    message_sha256 text not null check (message_sha256 ~ '^[a-f0-9]{64}$'),
    rating text not null check (rating in ('up', 'down', 'report')),
    reason text check (reason is null or char_length(reason) <= 200),
    created_at timestamptz not null default now()
);

create index chat_feedback_tenant_created_idx
    on public.chat_feedback (tenant_id, created_at desc);

alter table public.chat_feedback enable row level security;
alter table public.chat_feedback force row level security;

revoke all on public.chat_feedback from public, anon, authenticated;
revoke all on sequence public.chat_feedback_id_seq from public, anon, authenticated;

comment on table public.chat_feedback is
    'Server-only chat feedback keyed by client-computed message hashes; message text is never stored.';
