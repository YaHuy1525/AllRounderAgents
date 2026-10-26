-- The simulated company (TheAgentCompany, vendored under
-- fixtures/agentcompany) needs its own knowledge partitions so answers cite
-- `gitlab/wikis` pages and `owncloud/files` documents without diluting the
-- support, MSP, or HR corpora. The kb_documents domain check allowed the
-- phase-1 domains plus the `msp:<clientRef>` and `hr:<lane>` prefix families;
-- allow the `tac:<stream>` family as well. Each stream (wiki, docs) stays in
-- its own partition, so a retrieval can scope to documentation alone.

alter table public.kb_documents drop constraint kb_documents_domain_check;
alter table public.kb_documents
add constraint kb_documents_domain_check
check (
    domain in ('code', 'finance', 'marketing', 'support')
    or domain like 'msp:%'
    or domain like 'hr:%'
    or domain like 'tac:%'
);
