-- Hybrid retrieval: adds the lexical arm for RRF fusion with the dense arm.
-- retrieval = pgvector cosine (kb_chunks_embedding_hnsw_idx)
--           + ts_rank_cd over content_tsv, fused with reciprocal rank fusion.
alter table public.kb_chunks
    add column content_tsv tsvector
    generated always as (to_tsvector('simple', content)) stored;

create index kb_chunks_content_tsv_idx
    on public.kb_chunks using gin (content_tsv);

comment on column public.kb_chunks.content_tsv is
    'Generated lexical index for the hybrid (dense + ts_rank_cd) RRF retrieval arm; the simple config keeps identifiers, emails, and SKUs intact (no stemming).';
