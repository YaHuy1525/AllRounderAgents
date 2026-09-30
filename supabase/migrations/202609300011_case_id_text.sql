-- MSP case ids are readable slugs (msp-<client-ref>-<digits>), so public.cases.id
-- moves from uuid to text. The uuid default is preserved as text so every other
-- lane keeps generating uuid-shaped ids. The six referencing columns follow the
-- same uuid -> text change, then the same cascade foreign keys are re-added.
-- run_archive already stores case_id as text; it gains the pack-read index.

alter table public.case_events drop constraint case_events_case_id_fkey;
alter table public.approvals drop constraint approvals_case_id_fkey;
alter table public.risk_scores drop constraint risk_scores_case_id_fkey;
alter table public.coding_runs drop constraint coding_runs_case_id_fkey;
alter table public.support_sends drop constraint support_sends_case_id_fkey;
alter table public.approval_receipt_uses drop constraint approval_receipt_uses_case_id_fkey;

alter table public.cases alter column id drop default;
alter table public.cases alter column id type text using id::text;
alter table public.cases alter column id set default gen_random_uuid()::text;

alter table public.case_events alter column case_id type text using case_id::text;
alter table public.approvals alter column case_id type text using case_id::text;
alter table public.risk_scores alter column case_id type text using case_id::text;
alter table public.coding_runs alter column case_id type text using case_id::text;
alter table public.support_sends alter column case_id type text using case_id::text;
alter table public.approval_receipt_uses alter column case_id type text using case_id::text;

alter table public.case_events
    add constraint case_events_case_id_fkey
    foreign key (case_id) references public.cases (id) on delete cascade;
alter table public.approvals
    add constraint approvals_case_id_fkey
    foreign key (case_id) references public.cases (id) on delete cascade;
alter table public.risk_scores
    add constraint risk_scores_case_id_fkey
    foreign key (case_id) references public.cases (id) on delete cascade;
alter table public.coding_runs
    add constraint coding_runs_case_id_fkey
    foreign key (case_id) references public.cases (id) on delete cascade;
alter table public.support_sends
    add constraint support_sends_case_id_fkey
    foreign key (case_id) references public.cases (id) on delete cascade;
alter table public.approval_receipt_uses
    add constraint approval_receipt_uses_case_id_fkey
    foreign key (case_id) references public.cases (id) on delete cascade;

alter table public.cases drop constraint cases_domain_check;
alter table public.cases
    add constraint cases_domain_check
    check (domain in ('code', 'finance', 'marketing', 'support', 'unknown', 'msp'));

create index run_archive_tenant_case_started_idx
    on public.run_archive (tenant_id, case_id, started_at desc);

comment on column public.cases.id is
    'Text since the MSP lane: uuid-shaped for other lanes, msp-<client>-<digits> for MSP.';
