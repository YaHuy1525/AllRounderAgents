-- The MSP lane grounds reply drafts on per-client runbooks held in
-- `msp:<clientRef>` knowledge partitions. The kb_documents domain check still
-- listed only the phase-1 domains, so seeding a client runbook failed with a
-- check violation. Allow the msp: prefix; the other partitions keep their
-- exact names and one client's runbook stays in its own partition.

alter table public.kb_documents drop constraint kb_documents_domain_check;
alter table public.kb_documents
add constraint kb_documents_domain_check
check (domain in ('code', 'finance', 'marketing', 'support') or domain like 'msp:%');
