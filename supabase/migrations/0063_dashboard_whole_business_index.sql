-- ----------------------------------------------------------------------------
-- 0063: an index for the "whole business" dashboard view
-- ----------------------------------------------------------------------------
--
-- WHY
-- ---
-- Every dashboard RPC filters `financial_transactions` (via
-- `ledger_classified_lines` / `ledger_product_lines`, both plain views) with:
--
--   posted_at >= p_from and posted_at < p_to
--   and (p_account_id is null or marketplace_account_id = p_account_id)
--   and (p_business_id is null or business_id = p_business_id)
--
-- `financial_transactions_account_posted_idx` is
-- `(business_id, marketplace_account_id, posted_at)`. That index is exactly
-- right when `p_account_id` is given -- but the default dashboard view is
-- the WHOLE business (p_account_id is null), the single most common case.
-- With marketplace_account_id unconstrained, Postgres cannot use the
-- trailing posted_at column for an efficient range scan (it sits after an
-- unconstrained column in the index), so the whole-business view -- every
-- seller's default screen -- is the one case that can't use the date range
-- to prune rows before the expensive classification join runs.
--
-- This index is additive only: it changes nothing about what any query
-- returns, only how fast Postgres can find the rows. The existing
-- single-account index is untouched and still serves single-account views.
create index if not exists financial_transactions_business_posted_idx
  on public.financial_transactions (business_id, posted_at);

comment on index public.financial_transactions_business_posted_idx is
  'Supports the whole-business dashboard view (no marketplace_account_id '
  'filter), where the existing (business_id, marketplace_account_id, '
  'posted_at) index cannot use posted_at for range pruning. Added 2026-10-02 '
  'after a real "statement timeout" on the live year-to-date view.';
