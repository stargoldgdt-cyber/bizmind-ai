-- ============================================================================
-- 0055  Marketplace data quality: unmatched SKUs and missing costs, listed
-- ============================================================================
-- Owner request (2026-09-26): "Marketplace data quality" is meant to be the
-- one list of everything keeping a figure from being final, but it never
-- covered two of the reasons Marketplace P&L already warns about -- a SKU not
-- yet matched to a product, and a product with no cost on the sale date.
-- Those items live nowhere except that one banner and Products and costs.
--
-- This is ADDITIVE ONLY: one brand new, read-only function. Nothing existing
-- is touched, on purpose --
--
--   * "Unmatched SKUs" already has its own reader (sku_mapping_queue,
--     migration 0035), already used on Products and costs, so the quality
--     page reuses it directly. No new SQL for that half.
--   * "Missing product costs" has no reader shaped for a list yet -- only the
--     aggregate figures pnl_summary() already returns (units_without_cost,
--     sales_without_cost). This adds product_cost_gap_queue(), one row per
--     product and currency with a currently uncosted sale, business-wide (no
--     period filter, matching sku_mapping_queue's own shape) -- so it can
--     never disagree with what Marketplace P&L already shows, because it
--     reads the exact same cogs_status = 'NO_COST' signal.
--
-- Deliberately NOT added to ledger_data_quality(): that function also feeds
-- the executive dashboard's open_quality_items count (migration 0043), which
-- already has its OWN separate unmatched_skus and gross_profit_reasons
-- findings for exactly these two things. Folding them into
-- ledger_data_quality() too would count the same issue twice on that already-
-- verified page. This stays its own function, read only by the pages that
-- need it.
-- APPLY THIS IN THE SUPABASE SQL EDITOR.
-- Clear the editor first: click in it, press Ctrl+A, then Delete.
-- ============================================================================

begin;

create function public.product_cost_gap_queue(p_business_id uuid)
returns table (
  product_id    uuid,
  product_name  text,
  product_sku   text,
  currency      char(3),
  accounts      text,
  lines         bigint,
  units_sold    text,
  sales_amount  text,
  first_seen    timestamptz,
  last_seen     timestamptz
)
language sql
stable
security invoker
set search_path = ''
as $$
with gaps as (
  select
    l.product_id,
    min(l.product_name)                                                     as product_name,
    l.currency,
    string_agg(distinct l.account_label, ', ')                              as accounts,
    count(*)                                                                as lines,
    coalesce(sum(l.quantity::numeric) filter (where l.is_cost_line), 0)     as units,
    coalesce(sum(l.amount::numeric) filter (where l.metric_group = 'GROSS_SALES'), 0) as sales,
    min(l.posted_at)                                                        as first_seen,
    max(l.posted_at)                                                        as last_seen
  from public.ledger_product_lines l
  where l.business_id = p_business_id
    and l.cogs_status = 'NO_COST'
  group by l.product_id, l.currency
)
select
  g.product_id,
  g.product_name,
  p.sku_code,
  g.currency::char(3),
  g.accounts,
  g.lines,
  g.units::numeric(20,4)::text,
  g.sales::numeric(20,4)::text,
  g.first_seen,
  g.last_seen
from gaps g
left join public.catalog_products p on p.id = g.product_id
order by g.sales desc, g.product_name;
$$;

comment on function public.product_cost_gap_queue(uuid) is
  'Products (and their currency) with a currently uncosted sale, business-wide, largest sales first. '
  'The same cogs_status = NO_COST signal Marketplace P&L already reads -- never a second opinion on the gap. '
  'Read by Marketplace data quality (0055); Products and costs already surfaces the same gaps per product.';

revoke all on function public.product_cost_gap_queue(uuid) from anon, public;
grant execute on function public.product_cost_gap_queue(uuid) to authenticated;

do $$
begin
  if exists (
    select 1 from pg_proc p join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'public' and p.proname = 'product_cost_gap_queue'
      and (p.prosecdef or has_function_privilege('anon', p.oid, 'EXECUTE'))
  ) then
    raise exception 'SECURITY: product_cost_gap_queue must be SECURITY INVOKER and closed to anon.';
  end if;
  raise notice 'Migration 0055 verified: product_cost_gap_queue lists every currently uncosted product and currency.';
end;
$$;

commit;
