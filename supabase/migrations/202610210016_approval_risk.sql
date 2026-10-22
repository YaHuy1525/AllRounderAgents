-- Approval queue: declared risk band.
-- The approval queue must surface the riskiest gate first, so a receipt now
-- carries the integer band its producer declared. The scale reuses the
-- dispatcher's own anchors from policy/risk.yaml (preflight.scores): benign
-- 10, single_risk 55, irreversible_high_blast 90, so queue and dispatcher
-- speak one number. The 0-100 check keeps arbitrary scores out of the band
-- column; the run plane additionally validates declared bands against the
-- three anchors at import time (StepDefinition.__post_init__).
--
-- Nullable with no default and no backfill UPDATE on purpose: a null means
-- "no declared band", the read sorts it last, and existing rows keep their
-- insertion order instead of being silently re-ranked by a synthetic value.
-- The table's RLS stays exactly as the enable/force + blanket-revoke state
-- it is in (no tenant policy exists on public.approvals to match); a new
-- column inherits it, so no policy, index or grant is added here.

alter table public.approvals
    add column risk integer;

alter table public.approvals
    add constraint approvals_risk_band check (risk is null or (risk >= 0 and risk <= 100));

comment on column public.approvals.risk is
    'Declared risk band 0-100 (policy/risk.yaml anchors: benign 10, '
    'single_risk 55, irreversible_high_blast 90); null means no declared '
    'band and the queue sorts the row last.';
