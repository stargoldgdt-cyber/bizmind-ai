-- ============================================================================
-- 0010  Coverage gaps
-- ============================================================================
-- Adds two figures: the share of order lines with NO recorded cost, and the
-- share of orders with NO recorded fee. Both are computed here, in SQL, from
-- the same counts as their existing coverage counterparts.
--
-- WHY THIS EXISTS, WHICH IS A BETTER STORY THAN THE FEATURE
-- ---------------------------------------------------------
-- Phase 8 added a written explanation of each period. The rule is that a
-- language model may only repeat figures BizMind computed, and a guard throws
-- away any reply containing a number that was not supplied.
--
-- Measured against a real model, that guard rejected five replies out of
-- eight. Every rejection was the same move: given "cost coverage 75%", the
-- model wrote "25% of order lines have no cost". Correct arithmetic -- and
-- exactly what must never happen, because a model that computes a right answer
-- today computes a wrong one tomorrow, and the sentence looks identical.
--
-- Adding an instruction not to do it moved the pass rate from 3/8 to 3/8. The
-- prompt was not the problem. The problem was that BizMind had not computed a
-- figure the explanation genuinely needed, so the only way to say a true and
-- useful sentence was to derive it.
--
-- So: compute it. Not "tell the model harder". The same rule the rest of the
-- product runs on -- COMPUTE FIRST, THEN NARRATE -- applied to the gap as well
-- as the coverage.
--
-- These figures are useful on the dashboard in their own right. "25% of your
-- order lines have no cost recorded" is the sentence an owner acts on; "cost
-- coverage is 75%" is the same fact phrased for an analyst.
--
-- NOTE ON DROP: a function's return type cannot be changed in place
-- (PostgreSQL raises 42P13), so it is dropped and recreated. DROPPING ALSO
-- DISCARDS ITS GRANTS -- the grant is reissued in section 2 and asserted in
-- section 3. Migration 0008 learned this the hard way: the code installs
-- cleanly and then nobody can call it.
--
-- APPLY THIS IN THE SUPABASE SQL EDITOR.
-- Clear the editor first: click in it, press Ctrl+A, then Delete.
-- ============================================================================

begin;


-- ----------------------------------------------------------------------------
-- 1. analytics_financials, with the gaps stated
-- ----------------------------------------------------------------------------
-- Each gap is computed from its own counts rather than as 100 minus the
-- coverage, so the two round consistently and neither is derived from the
-- other's rounded result.

drop function if exists public.analytics_financials(uuid, timestamptz, timestamptz);

create or replace function public.analytics_financials(
  p_business_id uuid,
  p_from        timestamptz,
  p_to          timestamptz
)
returns table (
  revenue                numeric,
  cogs                   numeric,
  fees                   numeric,
  gross_profit           numeric,
  gross_margin           numeric,
  expenses               numeric,
  net_profit             numeric,
  net_margin             numeric,
  orders_count           bigint,
  units_sold             numeric,
  avg_order_value        numeric,
  customers_count        bigint,
  refunds                numeric,
  returns_count          bigint,
  cancelled_orders       bigint,
  items_total            bigint,
  items_with_cost        bigint,
  cost_coverage          numeric,
  /** Share of order lines with NO recorded cost. The gap, stated directly. */
  cost_gap               numeric,
  orders_zero_fees       bigint,
  orders_without_channel bigint,
  line_revenue           numeric,
  orders_fees_unknown    bigint,
  fee_coverage           numeric,
  /** Share of orders with NO recorded fee. Unknown, not zero. */
  fee_gap                numeric
)
language sql
stable
security invoker
set search_path = ''
as $$
with counted as (
  select * from public.analytics_counted_orders(p_business_id, p_from, p_to)
),
lines as (
  select
    oi.quantity,
    oi.unit_cost,
    oi.line_total,
    coalesce(oi.quantity * oi.unit_cost, 0) as line_cost,
    (oi.unit_cost is not null)              as has_cost
  from public.order_items oi
  join counted c on c.id = oi.order_id
),
base as (
  select
    coalesce((select sum(total) from counted), 0)                       as revenue,
    coalesce((select sum(coalesce(fee_total, 0)) from counted), 0)      as fees,
    coalesce((select count(*) from counted), 0)                         as orders_count,
    coalesce((select count(distinct customer_id) from counted
               where customer_id is not null), 0)                       as customers_count,
    coalesce((select count(*) from counted where fee_total = 0), 0)     as orders_zero_fees,
    coalesce((select count(*) from counted where fee_total is null), 0) as orders_fees_unknown,
    coalesce((select count(*) from counted where channel_id is null), 0) as orders_without_channel,
    coalesce((select sum(quantity) from lines), 0)                      as units_sold,
    coalesce((select sum(line_cost) from lines), 0)                     as cogs,
    coalesce((select sum(coalesce(line_total, 0)) from lines), 0)       as line_revenue,
    coalesce((select count(*) from lines), 0)                           as items_total,
    coalesce((select count(*) filter (where has_cost) from lines), 0)   as items_with_cost,
    coalesce((select sum(e.amount) from public.expenses e
               where e.business_id = p_business_id
                 and e.incurred_at >= p_from and e.incurred_at < p_to), 0) as expenses,
    coalesce((select sum(r.refund_amount) from public.returns r
               where r.business_id = p_business_id
                 and r.occurred_at >= p_from and r.occurred_at < p_to
                 and r.status in ('REFUNDED','RECEIVED','APPROVED')), 0)   as refunds,
    coalesce((select count(*) from public.returns r
               where r.business_id = p_business_id
                 and r.occurred_at >= p_from and r.occurred_at < p_to), 0) as returns_count,
    coalesce((select count(*) from public.orders o
               where o.business_id = p_business_id
                 and o.placed_at >= p_from and o.placed_at < p_to
                 and o.status = 'CANCELLED'), 0)                        as cancelled_orders
)
select
  b.revenue,
  b.cogs,
  b.fees,
  (b.revenue - b.cogs - b.fees)                                as gross_profit,
  case when b.revenue > 0
       then round(((b.revenue - b.cogs - b.fees) / b.revenue) * 100, 2) end
                                                               as gross_margin,
  b.expenses,
  (b.revenue - b.cogs - b.fees - b.expenses)                   as net_profit,
  case when b.revenue > 0
       then round(((b.revenue - b.cogs - b.fees - b.expenses) / b.revenue) * 100, 2) end
                                                               as net_margin,
  b.orders_count,
  b.units_sold,
  case when b.orders_count > 0 then round(b.revenue / b.orders_count, 2) end
                                                               as avg_order_value,
  b.customers_count,
  b.refunds,
  b.returns_count,
  b.cancelled_orders,
  b.items_total,
  b.items_with_cost,
  case when b.items_total > 0
       then round((b.items_with_cost::numeric / b.items_total) * 100, 2) end
                                                               as cost_coverage,
  -- Counted straight from the lines that lack a cost, not as 100 minus the
  -- figure above. Deriving one rounded number from another compounds error,
  -- and these two are shown side by side.
  case when b.items_total > 0
       then round(((b.items_total - b.items_with_cost)::numeric
                   / b.items_total) * 100, 2) end              as cost_gap,
  b.orders_zero_fees,
  b.orders_without_channel,
  b.line_revenue,
  b.orders_fees_unknown,
  -- The share of orders whose fees are actually known. Below 100 means profit
  -- is overstated by an unknown amount, for the same reason a missing cost does.
  case when b.orders_count > 0
       then round(((b.orders_count - b.orders_fees_unknown)::numeric
                   / b.orders_count) * 100, 2) end             as fee_coverage,
  case when b.orders_count > 0
       then round((b.orders_fees_unknown::numeric
                   / b.orders_count) * 100, 2) end             as fee_gap
from base b;
$$;


-- ----------------------------------------------------------------------------
-- 2. Reissue the grant the drop discarded
-- ----------------------------------------------------------------------------

revoke all on function public.analytics_financials(uuid, timestamptz, timestamptz)
  from anon, public;
grant execute on function public.analytics_financials(uuid, timestamptz, timestamptz)
  to authenticated;


-- ----------------------------------------------------------------------------
-- 3. Self-verification
-- ----------------------------------------------------------------------------

do $$
declare
  v_business uuid;
  v_cov      numeric;
  v_gap      numeric;
  v_total    bigint;
begin
  -- An analytics engine nobody may execute is a silent, total outage.
  if not exists (
    select 1 from pg_proc p join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'public' and p.proname = 'analytics_financials'
      and has_function_privilege('authenticated', p.oid, 'EXECUTE')
  ) then
    raise exception
      'SECURITY: authenticated cannot execute analytics_financials(). '
      'The drop removed its grant and it was not reissued.';
  end if;

  -- The new columns must exist and, where both are calculable, coverage and
  -- gap must account for every line between them.
  select id into v_business from public.businesses limit 1;

  if v_business is null then
    raise notice
      'No businesses exist yet, so the gap figures could not be exercised. '
      'The function is installed; re-run this assertion once a business exists.';
  else
    select cost_coverage, cost_gap, items_total
      into v_cov, v_gap, v_total
    from public.analytics_financials(
      v_business, now() - interval '3650 days', now() + interval '1 day');

    if v_total > 0 then
      if v_cov is null or v_gap is null then
        raise exception
          'Coverage and gap must both be calculable when there are order lines.';
      end if;

      -- Allow a cent of rounding: each is rounded independently, on purpose.
      if abs((v_cov + v_gap) - 100) > 0.01 then
        raise exception
          'cost_coverage (%) and cost_gap (%) do not account for every line.',
          v_cov, v_gap;
      end if;
    end if;
  end if;

  raise notice
    'Migration 0010 verified: coverage gaps computed in SQL, grants intact.';
end;
$$;


commit;
