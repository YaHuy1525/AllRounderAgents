-- Graduating the HR policy corpus needs its own knowledge partition so HR
-- answers cite `hr_policy/*.md` spans without mixing into the support
-- corpus. The kb_documents domain check allowed the phase-1 domains plus
-- `msp:<clientRef>`; allow the `hr:<lane>` prefix family as well. The other
-- partitions keep their exact names and each HR lane can graduate into its
-- own partition.

alter table public.kb_documents drop constraint kb_documents_domain_check;
alter table public.kb_documents
add constraint kb_documents_domain_check
check (
    domain in ('code', 'finance', 'marketing', 'support')
    or domain like 'msp:%'
    or domain like 'hr:%'
);
