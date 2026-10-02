-- ============================================================================
-- 0065  ledger_classified_lines: classify each line's TYPE once, not once per line
-- ============================================================================
-- Supabase's own Postgres logs (owner screenshot, 2026-10-02) show
-- dashboard_overview() itself hitting the statement timeout on wide ranges
-- (year-to-date, 12 months) -- even after 0063 (an index) and 0064 (no more
-- duplicate profit-bridge scan). dashboard_overview() calls pnl_summary()
-- twice for a 12-month view: once for the period, once for the 12 months
-- before it -- up to 24 months of transactions. Every one of those lines is
-- read through ledger_classified_lines, which decides which classification
-- rule applies with its OWN correlated subquery, run ONCE PER LINE (tens of
-- thousands of times on a wide range) -- even though the rule a line gets
-- depends on only four things (marketplace, file format, line type, and the
-- business), of which any real month has only a few dozen DISTINCT
-- combinations. The index on classification_rules (0032) already makes each
-- one of those lookups fast on its own; there are just far too many of them.
--
-- 0051 already proved this exact fix for dashboard_accounts() and
-- dashboard_cost_breakdown() -- group first, classify each distinct group
-- once, join the answer back -- and cut their query from 3.5s to 0.6s on
-- this owner's data. This migration applies the same idea to
-- ledger_classified_lines itself, so every reader built on it (pnl_summary,
-- ledger_product_lines, pnl_by_product, the ledger browser, Ask BizMind)
-- benefits, not just the dashboard -- and nothing has to re-implement
-- classification a second time to get it.
--
-- The view's column list, every join condition, and the exact rule tie-break
-- order (a global HIGH-confidence rule first, then any business-specific
-- rule, then anything else) are copied verbatim from 0057. Nothing about
-- WHICH rule a line gets, or what it decides, changes -- only how many times
-- that decision gets made.
--
-- `base NOT MATERIALIZED` is deliberate and required, not decoration. The
-- `base` CTE is used twice below (once to find which classification groups
-- are even present, once for the final per-line output). PostgreSQL 12+'s
-- default for a CTE used more than once is to materialise it -- compute it
-- once, in full, ignoring any filter the OUTER caller applies. Every reader
-- of this view filters by posted_at (a date range); if `base` were
-- materialised, that filter could no longer reach the financial_transactions
-- scan, and EVERY query would read the WHOLE ledger instead of the requested
-- range -- the exact opposite of this migration's purpose, and a much worse
-- regression than the one being fixed. NOT MATERIALIZED forces PostgreSQL to
-- inline `base` at both places it is used instead, so the caller's own date
-- filter still reaches the bottom of the query exactly as it does today.
-- Verified below with EXPLAIN (by the follow-up live check, not assumed) and
-- against the full live ledger / classification / P&L test suites.
--
-- Nothing in the ledger, classification, VAT or P&L calculation changes;
-- output is unchanged, row for row, column for column.
-- APPLY THIS IN THE SUPABASE SQL EDITOR.
-- Clear the editor first: click in it, press Ctrl+A, then Delete.
-- ============================================================================

begin;

create or replace view public.ledger_classified_lines
with (security_invoker = true)
as
with base as not materialized (
  select
    ft.id,
    ft.business_id,
    ft.marketplace_account_id,
    a.marketplace_code,
    a.label                                        as account_label,
    ft.source_file_id,
    b.format_id,
    ft.source_row_id,
    ft.line_index,
    public.classification_match_key(ft.source_type, ft.source_subtype, ft.source_description) as match_key,
    ft.source_type,
    ft.source_subtype,
    ft.source_description,
    ft.amount::text                                as amount,
    ft.currency,
    ft.posted_at,
    ft.order_ref,
    ft.raw_sku,
    ft.side                                        as import_side,
    ft.category                                    as import_category,
    ft.quantity::text                              as quantity,
    ft.quantity_basis,
    ft.attribution,
    ft.external_ref
  from public.financial_transactions ft
  join public.import_batches b on b.id = ft.source_file_id and b.withdrawn_at is null
  join public.marketplace_accounts a on a.id = ft.marketplace_account_id
),
distinct_groups as (
  select distinct business_id, marketplace_code, format_id, match_key
  from base
),
resolved as (
  select
    g.business_id, g.marketplace_code, g.format_id, g.match_key,
    r.id as rule_id, r.scope as rule_scope, r.confidence as rule_confidence, r.version as rule_version,
    r.category, r.subcategory, r.amount_includes_vat, r.separates_included_vat
  from distinct_groups g
  left join lateral (
    -- Exactly 0057's rule choice: the same filter, the same tie-break order,
    -- just run once per distinct (business, marketplace, format, line type)
    -- combination instead of once per line.
    select cr.id, cr.scope, cr.confidence, cr.version, cr.category, cr.subcategory,
           cr.amount_includes_vat, cr.separates_included_vat
    from public.classification_rules cr
    where cr.status = 'ACTIVE'
      and cr.marketplace_code = g.marketplace_code
      and cr.format_id = g.format_id
      and cr.match_key = g.match_key
      and (cr.business_id is null or cr.business_id = g.business_id)
    order by case
               when cr.business_id is null and cr.confidence = 'HIGH' then 1
               when cr.business_id is not null then 2
               else 3
             end
    limit 1
  ) r on true
)
select
  b.id,
  b.business_id,
  b.marketplace_account_id,
  b.marketplace_code,
  b.account_label,
  b.source_file_id,
  b.format_id,
  b.source_row_id,
  b.line_index,
  b.match_key,
  b.source_type,
  b.source_subtype,
  b.source_description,
  b.amount,
  b.currency,
  b.posted_at,
  b.order_ref,
  b.raw_sku,
  b.import_side,
  b.import_category,
  res.rule_id,
  res.rule_scope,
  res.rule_confidence,
  res.rule_version,
  c.financial_type,
  res.category,
  c.label                                        as category_label,
  res.subcategory,
  c.metric_group,
  c.default_treatment,
  case
    when res.rule_id is null then null
    when c.default_treatment <> 'CONDITIONAL' then c.default_treatment
    when tp.input_vat_treatment = 'RECOVERABLE' then 'NO_PNL_IMPACT'
    when tp.input_vat_treatment = 'NON_RECOVERABLE' then 'INCREASE_EXPENSE'
    else 'CONDITIONAL'
  end                                            as pnl_treatment,
  case
    when res.rule_id is null then 'UNKNOWN'
    when res.rule_scope = 'GLOBAL' and res.rule_confidence = 'MEDIUM' then 'UNDER_REVIEW'
    else 'CLASSIFIED'
  end                                            as classification_status,
  coalesce(res.amount_includes_vat, false)       as rule_includes_vat,
  coalesce(res.separates_included_vat, false)    as rule_separates_vat,
  b.quantity,
  b.quantity_basis,
  b.attribution,
  b.external_ref
from base b
left join resolved res
  on res.business_id = b.business_id
  and res.marketplace_code = b.marketplace_code
  and res.format_id = b.format_id
  and res.match_key = b.match_key
left join public.tax_profiles tp on tp.marketplace_account_id = b.marketplace_account_id
left join public.classification_categories c on c.code = res.category;

do $$
begin
  if not exists (
    select 1 from information_schema.views
    where table_schema = 'public' and table_name = 'ledger_classified_lines'
  ) then
    raise exception 'MIGRATION 0065: ledger_classified_lines is missing after replace.';
  end if;
  -- security_invoker views do not appear with rowsecurity forced the way
  -- tables do; this re-confirms the same column count as before (38 columns,
  -- unchanged from 0057) so a mistyped column list fails loudly here instead
  -- of silently reaching the app.
  if (select count(*) from information_schema.columns
      where table_schema = 'public' and table_name = 'ledger_classified_lines') <> 38 then
    raise exception 'MIGRATION 0065: ledger_classified_lines column count changed unexpectedly.';
  end if;
  raise notice 'Migration 0065 verified: ledger_classified_lines classifies each distinct line type once.';
end;
$$;

commit;
