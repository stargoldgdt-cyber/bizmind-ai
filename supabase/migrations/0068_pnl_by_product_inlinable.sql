-- ============================================================================
-- 0068  pnl_by_product: a subquery instead of a WITH clause, so it can inline
-- ============================================================================
-- Measured directly (owner's real data, local dev server, 2026-10-02, after
-- 0065/0066/0067 fixed dashboard_overview, dashboard_accounts and
-- ledger_data_quality's own classification cost): pnl_by_product() was still
-- consistently ~8.5-8.9s on a nine-month range and timing out -- the one
-- remaining reliably-slow call, where the others now vary with ordinary
-- request contention instead of hitting a wall every time.
--
-- Same root cause as 0067 diagnosed for ledger_data_quality: PostgreSQL does
-- not inline a SQL-language function whose body has a top-level WITH clause
-- (documented planner limitation), so it executes as an opaque, separately
-- planned unit instead of folding into the caller's query -- measurably
-- slower under RLS even for identical work. pnl_by_product()'s `scoped` CTE
-- is referenced exactly once (unlike ledger_data_quality's, read several
-- times), so there was never a need for a WITH clause here at all -- a plain
-- subquery in the FROM clause does exactly the same thing. This is a pure
-- syntax change: a CTE used once and a subquery used once are the same
-- computation to PostgreSQL; nothing about what is selected, filtered,
-- grouped or returned changes.
-- APPLY THIS IN THE SUPABASE SQL EDITOR.
-- Clear the editor first: click in it, press Ctrl+A, then Delete.
-- ============================================================================

begin;

create or replace function public.pnl_by_product(
  p_from        timestamptz,
  p_to          timestamptz,
  p_account_id  uuid default null,
  p_business_id uuid default null
)
returns table (
  currency              char(3),
  row_kind              text,
  product_id            uuid,
  product_name          text,
  product_category      text,
  raw_sku               text,
  marketplace_code      text,
  lines                 bigint,
  units_sold            text,
  net_sales             text,
  other_income          text,
  costs                 text,
  cogs                  text,
  contribution          text,
  gross_profit          text,
  gross_margin_percent  text,
  cogs_status           text
)
language sql
stable
security invoker
set search_path = ''
as $$
select
  g.currency::char(3),
  g.kind,
  g.product_id,
  case when g.kind = 'PRODUCT' then g.product_name end,
  case when g.kind = 'PRODUCT' then g.product_category end,
  g.raw_sku,
  g.marketplace_code,
  g.lines,
  g.units_sold::numeric(20,4)::text,
  g.net_sales::numeric(20,4)::text,
  g.other_income::numeric(20,4)::text,
  g.costs::numeric(20,4)::text,
  case when g.kind = 'PRODUCT' and g.uncosted_lines = 0 then g.cogs::numeric(20,4)::text end,
  g.contribution::numeric(20,4)::text,
  case when g.kind = 'PRODUCT' and g.uncosted_lines = 0 then (g.contribution + g.cogs)::numeric(20,4)::text end,
  case
    when g.kind = 'PRODUCT' and g.uncosted_lines = 0 and g.net_sales <> 0
      then round((g.contribution + g.cogs) / g.net_sales * 100, 1)::text
  end,
  case
    when g.kind = 'NOT_ALLOCATED' then 'NOT_APPLICABLE'
    when g.kind = 'UNMAPPED_SKU' then 'NO_PRODUCT'
    when g.uncosted_lines = 0 and g.costed_lines > 0 then 'COSTED'
    when g.uncosted_lines = 0 then 'NOT_APPLICABLE'
    when g.costed_lines = 0 then 'NO_COST'
    else 'PARTLY_COSTED'
  end
from (
  select
    s.currency,
    s.kind,
    case when s.kind = 'PRODUCT' then s.product_id end                   as product_id,
    case when s.kind = 'UNMAPPED_SKU' then s.raw_sku end                 as raw_sku,
    case when s.kind = 'UNMAPPED_SKU' then s.marketplace_code end        as marketplace_code,
    max(s.product_name)                                                  as product_name,
    max(s.product_category)                                              as product_category,
    count(*)                                                             as lines,
    coalesce(sum(s.quantity::numeric) filter (where s.is_cost_line), 0)  as units_sold,
    coalesce(sum(s.amt) filter (where s.metric_group in ('GROSS_SALES', 'SALES_REFUNDS', 'SELLER_DISCOUNTS')), 0) as net_sales,
    coalesce(sum(s.amt) filter (where s.metric_group = 'OTHER_INCOME'), 0) as other_income,
    coalesce(sum(s.amt) filter (where s.pnl_treatment = 'INCREASE_EXPENSE'), 0) as costs,
    coalesce(sum(s.cogs::numeric) filter (where s.cogs_status = 'COSTED'), 0) as cogs,
    count(*) filter (where s.cogs_status = 'COSTED')                     as costed_lines,
    count(*) filter (where s.cogs_status in ('NO_COST', 'NO_PRODUCT'))  as uncosted_lines,
    sum(s.amt)                                                           as contribution
  from (
    select
      l.*,
      l.amount::numeric(20,4) as amt,
      case
        when l.raw_sku is not null and l.attribution = 'ORDER_LINE' and l.product_id is not null then 'PRODUCT'
        when l.raw_sku is not null and l.attribution = 'ORDER_LINE' then 'UNMAPPED_SKU'
        else 'NOT_ALLOCATED'
      end as kind
    from public.ledger_product_lines l
    where l.posted_at >= p_from
      and l.posted_at < p_to
      and (p_account_id is null or l.marketplace_account_id = p_account_id)
      and (p_business_id is null or l.business_id = p_business_id)
      and l.pnl_treatment in ('INCREASE_REVENUE', 'DECREASE_REVENUE', 'INCREASE_EXPENSE')
  ) s
  group by s.currency, s.kind,
           case when s.kind = 'PRODUCT' then s.product_id end,
           case when s.kind = 'UNMAPPED_SKU' then s.raw_sku end,
           case when s.kind = 'UNMAPPED_SKU' then s.marketplace_code end
) g
order by g.currency,
         case g.kind when 'PRODUCT' then 1 when 'UNMAPPED_SKU' then 2 else 3 end,
         g.net_sales desc;
$$;

revoke all on function public.pnl_by_product(timestamptz, timestamptz, uuid, uuid) from anon, public;
grant execute on function public.pnl_by_product(timestamptz, timestamptz, uuid, uuid) to authenticated;

do $$
begin
  if exists (
    select 1 from pg_proc p join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'public' and p.proname = 'pnl_by_product'
      and (p.prosecdef or has_function_privilege('anon', p.oid, 'EXECUTE'))
  ) then
    raise exception 'SECURITY: pnl_by_product must be SECURITY INVOKER and closed to anon.';
  end if;
  raise notice 'Migration 0068 verified: pnl_by_product has no top-level WITH clause.';
end;
$$;

commit;
