-- The dispatcher routes a ticket to Domain.SECURITY (contracts.py, and
-- PROJECT_DOMAINS maps the SEC project to it), and records the verdict on
-- public.tickets.domain plus public.dispatcher_jobs.domain. Those two checks
-- were written in Phase 0, before the security lane existed, and still list
-- only the original five domains, so a security delivery fails its insert and
-- the webhook answers 503 with the ticket copied into dead_letters.
--
-- Measured against the live board: 3 of the 48 open SCRUM tickets route to
-- security, so the SOC intake path is unreachable through the spine today.
-- public.cases carries the same stale enum half-patched for msp and bills;
-- widen all three to the domains the dispatcher can actually emit.

alter table public.tickets drop constraint tickets_domain_check;
alter table public.tickets
    add constraint tickets_domain_check
    check (domain in ('code', 'finance', 'marketing', 'support', 'security', 'unknown'));

alter table public.dispatcher_jobs drop constraint dispatcher_jobs_domain_check;
alter table public.dispatcher_jobs
    add constraint dispatcher_jobs_domain_check
    check (domain in ('code', 'finance', 'marketing', 'support', 'security', 'unknown'));

alter table public.cases drop constraint cases_domain_check;
alter table public.cases
    add constraint cases_domain_check
    check (
        domain in (
            'code', 'finance', 'marketing', 'support', 'unknown',
            'msp', 'bills', 'security'
        )
    );
