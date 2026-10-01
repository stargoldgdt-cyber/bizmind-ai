-- ============================================================================
-- 0061  Marketplace P&L: percentage change vs the period before
-- ============================================================================
-- The executive dashboard's KPI cards already compare against the period
-- before (dashboard_overview, migration 0049/0050); the Marketplace P&L
-- page's own headline figures never did -- pnl_summary() only ever returned
-- one period's absolute figures. Owner request, 2026-09-29: bring the same
-- comparison to this page's cards.
--
-- pnl_summary_change() takes the EXACT SAME arguments as pnl_summary() (so
-- the page calls it the same way, single account or combined-by-currency)
-- and mirrors dashboard_overview()'s own previous-period alignment rule
-- verbatim -- a whole month compares with the month before, a quarter with
-- the quarter before -- so the two pages never disagree about what "the
-- period before" means. It calls pnl_summary() twice (current, previous)
-- and reduces each pair to a percentage via dashboard_change(), the same
-- helper the executive dashboard already uses (migration 0043). Nothing new
-- is computed here: every number it reduces already exists.
--
-- Additive only. pnl_summary() itself is untouched.
-- APPLY THIS IN THE SUPABASE SQL EDITOR.
-- Clear the editor first: click in it, press Ctrl+A, then Delete.
-- ============================================================================

begin;

create function public.pnl_summary_change(
  p_from                 timestamptz,
  p_to                   timestamptz,
  p_account_id           uuid default null,
  p_business_id          uuid default null,
  p_combine_by_currency  boolean default false
)
returns table (
  marketplace_account_id      uuid,
  currency                    text,
  prev_has_data                boolean,
  gross_sales_change_pct      numeric,
  net_sales_change_pct        numeric,
  orders_change_pct           numeric,
  average_order_value_change_pct numeric,
  marketplace_fees_change_pct numeric,
  fulfillment_change_pct      numeric,
  advertising_change_pct      numeric,
  contribution_change_pct     numeric,
  cogs_change_pct             numeric,
  gross_profit_change_pct     numeric,
  gross_margin_pct_change_pct numeric,
  profit_per_order_change_pct numeric
)
language plpgsql
stable
security invoker
set search_path = ''
as $$
declare
  v_prev_from timestamptz := p_from - (p_to - p_from);
  v_months    integer;
begin
  -- Copied verbatim from dashboard_overview() (0050) so the executive
  -- dashboard and the Marketplace P&L page never disagree about what "the
  -- period before" means.
  if date_trunc('month', p_from at time zone 'UTC') = (p_from at time zone 'UTC')
     and date_trunc('month', p_to at time zone 'UTC') = (p_to at time zone 'UTC')
     and p_to > p_from then
    v_months := (extract(year from p_to at time zone 'UTC')::integer * 12 + extract(month from p_to at time zone 'UTC')::integer)
              - (extract(year from p_from at time zone 'UTC')::integer * 12 + extract(month from p_from at time zone 'UTC')::integer);
    v_prev_from := (((p_from at time zone 'UTC') - make_interval(months => v_months)) at time zone 'UTC');
  end if;

  return query
  select
    cur.marketplace_account_id,
    cur.currency,
    prev.currency is not null,
    public.dashboard_change(cur.gross_sales::numeric, prev.gross_sales::numeric),
    public.dashboard_change(cur.net_sales::numeric, prev.net_sales::numeric),
    public.dashboard_change(cur.orders::numeric, prev.orders::numeric),
    public.dashboard_change(cur.average_order_value::numeric, prev.average_order_value::numeric),
    -- Fees are negative; a rise in a fee's size is a positive change in it.
    public.dashboard_change(-cur.marketplace_fees::numeric, -prev.marketplace_fees::numeric),
    public.dashboard_change(-cur.fulfillment::numeric, -prev.fulfillment::numeric),
    public.dashboard_change(-cur.advertising::numeric, -prev.advertising::numeric),
    public.dashboard_change(cur.contribution_before_open_items::numeric, prev.contribution_before_open_items::numeric),
    public.dashboard_change(-cur.cogs::numeric, -prev.cogs::numeric),
    public.dashboard_change(cur.gross_profit_before_open_items::numeric, prev.gross_profit_before_open_items::numeric),
    public.dashboard_change(cur.gross_margin_pct, prev.gross_margin_pct),
    public.dashboard_change(cur.profit_per_order::numeric, prev.profit_per_order::numeric)
  from public.pnl_summary(p_from, p_to, p_account_id, p_business_id, p_combine_by_currency) cur
  left join public.pnl_summary(v_prev_from, p_from, p_account_id, p_business_id, p_combine_by_currency) prev
    on prev.currency = cur.currency
    and prev.marketplace_account_id is not distinct from cur.marketplace_account_id;
end;
$$;

do $$
begin
  revoke all on function public.pnl_summary_change(timestamptz, timestamptz, uuid, uuid, boolean) from anon, public;
  grant execute on function public.pnl_summary_change(timestamptz, timestamptz, uuid, uuid, boolean) to authenticated;
end;
$$;

do $$
begin
  if exists (
    select 1 from pg_proc p join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'public' and p.proname = 'pnl_summary_change'
      and (p.prosecdef or has_function_privilege('anon', p.oid, 'EXECUTE'))
  ) then
    raise exception 'SECURITY: pnl_summary_change must be SECURITY INVOKER and closed to anon.';
  end if;
  raise notice 'Migration 0061 verified: pnl_summary_change() exists, SECURITY INVOKER, closed to anon.';
end;
$$;

commit;
