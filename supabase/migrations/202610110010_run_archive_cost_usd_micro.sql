-- Run archive: per-run actual cost.
-- The engine now reports each run's token-derived spend in micro-USD, and the
-- run service stores it on the WorkflowRun before mirroring the terminal row.
-- The benchmark reads cost straight off the run instead of joining the case
-- store, so a case with several runs no longer blurs their individual spend.
-- Server-only, best-effort like every other archive write.

alter table public.run_archive
    add column cost_usd_micro bigint not null default 0
        check (cost_usd_micro >= 0);

comment on column public.run_archive.cost_usd_micro is
    'Actual token-derived run cost in micro-USD; 0 for lanes that do not instrument usage.';
