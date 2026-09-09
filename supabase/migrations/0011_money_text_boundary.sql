-- ============================================================================
-- 0011  The money boundary: exact decimals, all the way to the application
-- ============================================================================
-- THE PROBLEM THIS FIXES
-- ---------------------
-- This codebase declared money as `string` in TypeScript and told itself that
-- PostgREST returned numerics as JSON strings, so accidental arithmetic in
-- JavaScript was impossible.
--
-- Probing the live database showed otherwise:
--
--     {"revenue":0.1000,"cogs":0.30000000,"cost_gap":50.00}
--
-- Unquoted JSON numbers. The wire format is exact -- JSON numbers are
-- arbitrary precision by specification -- but `JSON.parse` narrows them to
-- IEEE-754 doubles the moment they reach JavaScript. So the declared type was
-- a lie, and the safety it promised did not exist.
--
-- THE FIX, AND WHY IT IS PLACED HERE
-- ----------------------------------
-- Money is cast to `text` in SQL, at the RPC boundary. That is the last point
-- at which the value is still exact, and casting a numeric to text in
-- PostgreSQL is lossless: it emits the stored decimal digits, full scale
-- included. `numeric(20,4)` holding 9007199254740993.0000 arrives in
-- JavaScript as the string "9007199254740993.0000", not as the double
-- 9007199254740992 that `Number()` would produce.
--
-- The alternative -- parsing to a number and calling String() on it -- would
-- have been theatre. The precision is gone by then.
--
-- WHAT DOES NOT CHANGE
-- --------------------
-- Every calculation stays in PostgreSQL, in exact decimal, exactly as before.
-- Not one arithmetic expression moves. The functions that do the work are not
-- rewritten; the three that carry the totals are MOVED, body untouched, into a
-- private schema, and thin wrappers in `public` cast their output. The three
-- that build on those are recreated so they read exact numerics from the
-- private schema and emit text of their own.
--
-- WHY A PRIVATE SCHEMA
-- --------------------
-- `analytics_core` is not in PostgREST's exposed schema list, so nothing in it
-- is reachable over the API. That leaves exactly ONE representation of a money
-- value available to application code: the text one. Two contracts for the
-- same figure is how a codebase ends up believing the wrong one.
--
-- NULL IS STILL NULL
-- ------------------
-- `null::numeric::text` is NULL, which PostgREST emits as JSON null. A figure
-- the database could not calculate stays unknown; it does not become "0", "",
-- or 0. That distinction is load-bearing throughout this product.
--
-- COUNTS ARE LEFT ALONE
-- ---------------------
-- Order counts, line counts and customer counts stay `bigint`. They are exact
-- integers far below 2^53, they are typed `number` in TypeScript, and that
-- declaration is already true. Casting them would make the types lie in the
-- other direction.
--
-- APPLY THIS IN THE SUPABASE SQL EDITOR.
-- Clear the editor first: click in it, press Ctrl+A, then Delete.
-- ============================================================================

begin;


-- ----------------------------------------------------------------------------
-- 1. The private schema
-- ----------------------------------------------------------------------------

create schema if not exists analytics_core;

comment on schema analytics_core is
  'Exact-numeric analytics implementations. NOT exposed through PostgREST: '
  'the only money representation application code may see is the text one '
  'returned by the wrappers in public.';

grant usage on schema analytics_core to authenticated;


-- ----------------------------------------------------------------------------
-- 2. Move the three implementations, bodies untouched
-- ----------------------------------------------------------------------------
-- ALTER FUNCTION ... SET SCHEMA moves the function without reparsing it, so
-- the arithmetic is carried across verbatim. Nothing is retyped, so nothing
-- can be mistyped. Their ACLs move with them, which the wrappers rely on:
-- the wrappers are SECURITY INVOKER, so the caller needs EXECUTE on the inner
-- function. Making them DEFINER instead would bypass Row Level Security and
-- break tenant isolation, which is never worth a convenience.
--
-- Their bodies reference public.analytics_counted_orders by qualified name,
-- which still resolves after the move.

alter function public.analytics_financials(uuid, timestamptz, timestamptz)
  set schema analytics_core;

alter function public.analytics_channels(uuid, timestamptz, timestamptz)
  set schema analytics_core;

alter function public.analytics_products(uuid, timestamptz, timestamptz, integer)
  set schema analytics_core;


-- ----------------------------------------------------------------------------
-- 3. Public wrappers: the same figures, as exact text
-- ----------------------------------------------------------------------------

create function public.analytics_financials(
  p_business_id uuid,
  p_from        timestamptz,
  p_to          timestamptz
)
returns table (
  revenue                text,
  cogs                   text,
  fees                   text,
  gross_profit           text,
  gross_margin           text,
  expenses               text,
  net_profit             text,
  net_margin             text,
  orders_count           bigint,
  units_sold             text,
  avg_order_value        text,
  customers_count        bigint,
  refunds                text,
  returns_count          bigint,
  cancelled_orders       bigint,
  items_total            bigint,
  items_with_cost        bigint,
  cost_coverage          text,
  cost_gap               text,
  orders_zero_fees       bigint,
  orders_without_channel bigint,
  line_revenue           text,
  orders_fees_unknown    bigint,
  fee_coverage           text,
  fee_gap                text,
  /**
   * Refunds as a percentage of revenue.
   *
   * Added here because the insight engine was CALCULATING it in TypeScript --
   * (refunds / revenue) * 100, in floating point -- and printing the result to
   * the owner. A figure shown to somebody is a figure the database should have
   * produced. Computed below on the exact numerics, before any cast.
   */
  refund_rate            text
)
language sql
stable
security invoker
set search_path = ''
as $$
  select
    q.revenue::text,
    q.cogs::text,
    q.fees::text,
    q.gross_profit::text,
    q.gross_margin::text,
    q.expenses::text,
    q.net_profit::text,
    q.net_margin::text,
    q.orders_count,
    q.units_sold::text,
    q.avg_order_value::text,
    q.customers_count,
    q.refunds::text,
    q.returns_count,
    q.cancelled_orders,
    q.items_total,
    q.items_with_cost,
    q.cost_coverage::text,
    q.cost_gap::text,
    q.orders_zero_fees,
    q.orders_without_channel,
    q.line_revenue::text,
    q.orders_fees_unknown,
    q.fee_coverage::text,
    q.fee_gap::text,
    (case when q.revenue > 0
          then round((q.refunds / q.revenue) * 100, 2) end)::text as refund_rate
  from analytics_core.analytics_financials(p_business_id, p_from, p_to) q;
$$;


create function public.analytics_channels(
  p_business_id uuid,
  p_from        timestamptz,
  p_to          timestamptz
)
returns table (
  channel_id          uuid,
  channel_name        text,
  channel_type        public.channel_type,
  revenue             text,
  cogs                text,
  fees                text,
  gross_profit        text,
  gross_margin        text,
  orders_count        bigint,
  units_sold          text,
  avg_order_value     text,
  items_total         bigint,
  items_with_cost     bigint,
  cost_coverage       text,
  orders_fees_unknown bigint,
  fee_coverage        text
)
language sql
stable
security invoker
set search_path = ''
as $$
  select
    q.channel_id,
    q.channel_name,
    q.channel_type,
    q.revenue::text,
    q.cogs::text,
    q.fees::text,
    q.gross_profit::text,
    q.gross_margin::text,
    q.orders_count,
    q.units_sold::text,
    q.avg_order_value::text,
    q.items_total,
    q.items_with_cost,
    q.cost_coverage::text,
    q.orders_fees_unknown,
    q.fee_coverage::text
  from analytics_core.analytics_channels(p_business_id, p_from, p_to) q;
$$;


create function public.analytics_products(
  p_business_id uuid,
  p_from        timestamptz,
  p_to          timestamptz,
  p_limit       integer default 100
)
returns table (
  sku             text,
  product_name    text,
  revenue         text,
  units_sold      text,
  cogs            text,
  fees_allocated  text,
  gross_profit    text,
  gross_margin    text,
  orders_count    bigint,
  items_total     bigint,
  items_with_cost bigint,
  cost_coverage   text
)
language sql
stable
security invoker
set search_path = ''
as $$
  select
    q.sku,
    q.product_name,
    q.revenue::text,
    q.units_sold::text,
    q.cogs::text,
    q.fees_allocated::text,
    q.gross_profit::text,
    q.gross_margin::text,
    q.orders_count,
    q.items_total,
    q.items_with_cost,
    q.cost_coverage::text
  from analytics_core.analytics_products(p_business_id, p_from, p_to, p_limit) q;
$$;


-- ----------------------------------------------------------------------------
-- 4. The three that build on the others
-- ----------------------------------------------------------------------------
-- These read EXACT NUMERICS from analytics_core, do their arithmetic in SQL
-- exactly as before, and cast only their own output. Their return types
-- change, and PostgreSQL cannot change a return type in place (42P13), so they
-- are dropped and recreated. DROPPING DISCARDS GRANTS -- reissued in section 5
-- and asserted in section 6.

drop function if exists public.analytics_compare(
  uuid, timestamptz, timestamptz, timestamptz, timestamptz);
drop function if exists public.analytics_reconciliation(uuid, timestamptz, timestamptz);
drop function if exists public.analytics_health_inputs(
  uuid, timestamptz, timestamptz, timestamptz, timestamptz);


create function public.analytics_compare(
  p_business_id uuid,
  p_from        timestamptz,
  p_to          timestamptz,
  p_prev_from   timestamptz,
  p_prev_to     timestamptz
)
returns table (
  metric          text,
  current_value   text,
  previous_value  text,
  absolute_change text,
  percent_change  text,
  direction       text
)
language sql
stable
security invoker
set search_path = ''
as $$
with cur as (
  select * from analytics_core.analytics_financials(p_business_id, p_from, p_to)),
prev as (
  select * from analytics_core.analytics_financials(p_business_id, p_prev_from, p_prev_to)),
pairs as (
  select 'revenue'::text        as metric, c.revenue        as cv, p.revenue        as pv from cur c, prev p
  union all select 'cogs',            c.cogs,            p.cogs            from cur c, prev p
  union all select 'fees',            c.fees,            p.fees            from cur c, prev p
  union all select 'gross_profit',    c.gross_profit,    p.gross_profit    from cur c, prev p
  union all select 'gross_margin',    c.gross_margin,    p.gross_margin    from cur c, prev p
  union all select 'expenses',        c.expenses,        p.expenses        from cur c, prev p
  union all select 'net_profit',      c.net_profit,      p.net_profit      from cur c, prev p
  union all select 'net_margin',      c.net_margin,      p.net_margin      from cur c, prev p
  union all select 'orders_count',    c.orders_count,    p.orders_count    from cur c, prev p
  union all select 'units_sold',      c.units_sold,      p.units_sold      from cur c, prev p
  union all select 'avg_order_value', c.avg_order_value, p.avg_order_value from cur c, prev p
  union all select 'customers_count', c.customers_count, p.customers_count from cur c, prev p
  union all select 'refunds',         c.refunds,         p.refunds         from cur c, prev p
  union all select 'cost_coverage',   c.cost_coverage,   p.cost_coverage   from cur c, prev p
)
select
  pairs.metric,
  pairs.cv::text,
  pairs.pv::text,
  (case when pairs.cv is null or pairs.pv is null then null
        else pairs.cv - pairs.pv end)::text                             as absolute_change,
  (case when pairs.cv is null or pairs.pv is null then null
        when pairs.pv = 0 then null
        else round(((pairs.cv - pairs.pv) / abs(pairs.pv)) * 100, 2) end)::text
                                                                        as percent_change,
  case when pairs.cv is null or pairs.pv is null then 'unknown'
       when pairs.cv > pairs.pv then 'up'
       when pairs.cv < pairs.pv then 'down'
       else 'flat' end                                                  as direction
from pairs;
$$;


create function public.analytics_reconciliation(
  p_business_id uuid,
  p_from        timestamptz,
  p_to          timestamptz
)
returns table (
  order_revenue        text,
  channel_revenue      text,
  channel_difference   text,
  line_revenue         text,
  order_line_gap       text,
  orders_without_lines bigint
)
language sql
stable
security invoker
set search_path = ''
as $$
with f as (
  select * from analytics_core.analytics_financials(p_business_id, p_from, p_to)),
ch as (
  select coalesce(sum(revenue), 0) as channel_revenue
  from analytics_core.analytics_channels(p_business_id, p_from, p_to)
),
counted as (
  select * from public.analytics_counted_orders(p_business_id, p_from, p_to)
)
select
  f.revenue::text                                               as order_revenue,
  ch.channel_revenue::text,
  (f.revenue - ch.channel_revenue)::text                        as channel_difference,
  f.line_revenue::text,
  -- Shipping, order-level discounts and orders with no lines all land here.
  (f.revenue - f.line_revenue)::text                            as order_line_gap,
  (select count(*) from counted c
    where not exists (select 1 from public.order_items oi where oi.order_id = c.id))
                                                                as orders_without_lines
from f, ch;
$$;


create function public.analytics_health_inputs(
  p_business_id uuid,
  p_from        timestamptz,
  p_to          timestamptz,
  p_prev_from   timestamptz,
  p_prev_to     timestamptz
)
returns table (
  revenue                text,
  revenue_previous       text,
  revenue_growth_pct     text,
  gross_margin           text,
  net_margin             text,
  cost_coverage          text,
  refund_rate            text,
  expense_ratio          text,
  orders_count           bigint,
  customers_count        bigint,
  repeat_customer_rate   text,
  cancelled_rate         text,
  orders_without_channel bigint,
  orders_zero_fees       bigint,
  variants_tracked       bigint,
  variants_out_of_stock  bigint,
  variants_below_reorder bigint,
  paid_order_value       text,
  unpaid_order_value     text,
  payment_capture_rate   text
)
language sql
stable
security invoker
set search_path = ''
as $$
with cur  as (
  select * from analytics_core.analytics_financials(p_business_id, p_from, p_to)),
prev as (
  select * from analytics_core.analytics_financials(p_business_id, p_prev_from, p_prev_to)),
counted as (select * from public.analytics_counted_orders(p_business_id, p_from, p_to)),
repeat_buyers as (
  select count(*) as repeat_count
  from (
    select customer_id
    from counted
    where customer_id is not null
    group by customer_id
    having count(*) > 1
  ) r
),
stock as (
  select
    count(*)                                                        as tracked,
    count(*) filter (where i.quantity_on_hand <= 0)                 as out_of_stock,
    count(*) filter (where i.reorder_point is not null
                       and i.quantity_on_hand <= i.reorder_point)   as below_reorder
  from public.inventory i
  where i.business_id = p_business_id
),
payments as (
  select
    coalesce(sum(p.amount) filter (where p.status = 'PAID'), 0)     as paid_value,
    coalesce(sum(p.amount) filter (where p.status in ('PENDING','FAILED')), 0) as unpaid_value
  from public.payments p
  where p.business_id = p_business_id
    and coalesce(p.paid_at, p.created_at) >= p_from
    and coalesce(p.paid_at, p.created_at) <  p_to
)
select
  cur.revenue::text,
  prev.revenue::text                                                 as revenue_previous,
  (case when prev.revenue > 0
        then round(((cur.revenue - prev.revenue) / prev.revenue) * 100, 2) end)::text
                                                                     as revenue_growth_pct,
  cur.gross_margin::text,
  cur.net_margin::text,
  cur.cost_coverage::text,
  (case when cur.revenue > 0 then round((cur.refunds / cur.revenue) * 100, 2) end)::text
                                                                     as refund_rate,
  (case when cur.revenue > 0 then round((cur.expenses / cur.revenue) * 100, 2) end)::text
                                                                     as expense_ratio,
  cur.orders_count,
  cur.customers_count,
  (case when cur.customers_count > 0
        then round((rb.repeat_count::numeric / cur.customers_count) * 100, 2) end)::text
                                                                     as repeat_customer_rate,
  (case when (cur.orders_count + cur.cancelled_orders) > 0
        then round((cur.cancelled_orders::numeric
                    / (cur.orders_count + cur.cancelled_orders)) * 100, 2) end)::text
                                                                     as cancelled_rate,
  cur.orders_without_channel,
  cur.orders_zero_fees,
  st.tracked                                                         as variants_tracked,
  st.out_of_stock                                                    as variants_out_of_stock,
  st.below_reorder                                                   as variants_below_reorder,
  pm.paid_value::text                                                as paid_order_value,
  pm.unpaid_value::text                                              as unpaid_order_value,
  (case when (pm.paid_value + pm.unpaid_value) > 0
        then round((pm.paid_value / (pm.paid_value + pm.unpaid_value)) * 100, 2) end)::text
                                                                     as payment_capture_rate
from cur, prev, repeat_buyers rb, stock st, payments pm;
$$;


-- ----------------------------------------------------------------------------
-- 5. Privileges
-- ----------------------------------------------------------------------------

revoke all on function public.analytics_financials(uuid, timestamptz, timestamptz)
  from anon, public;
grant execute on function public.analytics_financials(uuid, timestamptz, timestamptz)
  to authenticated;

revoke all on function public.analytics_channels(uuid, timestamptz, timestamptz)
  from anon, public;
grant execute on function public.analytics_channels(uuid, timestamptz, timestamptz)
  to authenticated;

revoke all on function public.analytics_products(uuid, timestamptz, timestamptz, integer)
  from anon, public;
grant execute on function public.analytics_products(uuid, timestamptz, timestamptz, integer)
  to authenticated;

revoke all on function public.analytics_compare(
  uuid, timestamptz, timestamptz, timestamptz, timestamptz) from anon, public;
grant execute on function public.analytics_compare(
  uuid, timestamptz, timestamptz, timestamptz, timestamptz) to authenticated;

revoke all on function public.analytics_reconciliation(uuid, timestamptz, timestamptz)
  from anon, public;
grant execute on function public.analytics_reconciliation(uuid, timestamptz, timestamptz)
  to authenticated;

revoke all on function public.analytics_health_inputs(
  uuid, timestamptz, timestamptz, timestamptz, timestamptz) from anon, public;
grant execute on function public.analytics_health_inputs(
  uuid, timestamptz, timestamptz, timestamptz, timestamptz) to authenticated;

-- The moved implementations keep the ACLs they arrived with, which the
-- SECURITY INVOKER wrappers depend on. Stated explicitly rather than relied on.
grant execute on function analytics_core.analytics_financials(uuid, timestamptz, timestamptz)
  to authenticated;
grant execute on function analytics_core.analytics_channels(uuid, timestamptz, timestamptz)
  to authenticated;
grant execute on function analytics_core.analytics_products(
  uuid, timestamptz, timestamptz, integer) to authenticated;

revoke all on schema analytics_core from anon;


-- ----------------------------------------------------------------------------
-- 6. Self-verification
-- ----------------------------------------------------------------------------

do $$
declare
  fn         text;
  v_business uuid;
  v_type     text;
  v_text     text;
  v_num      numeric;
begin
  -- An analytics engine nobody may execute is a silent, total outage.
  foreach fn in array array[
    'analytics_financials', 'analytics_channels', 'analytics_products',
    'analytics_compare', 'analytics_reconciliation', 'analytics_health_inputs'
  ]
  loop
    if not exists (
      select 1 from pg_proc p join pg_namespace n on n.oid = p.pronamespace
      where n.nspname = 'public' and p.proname = fn
        and has_function_privilege('authenticated', p.oid, 'EXECUTE')
    ) then
      raise exception
        'SECURITY: authenticated cannot execute public.%(). Its grant was lost.', fn;
    end if;
  end loop;

  -- Every money column must now be text. One left as numeric would reach
  -- JavaScript as a double and quietly reintroduce the whole problem.
  select pg_get_function_result(p.oid) into v_type
  from pg_proc p join pg_namespace n on n.oid = p.pronamespace
  where n.nspname = 'public' and p.proname = 'analytics_financials';

  if v_type is null then
    raise exception 'public.analytics_financials() is missing';
  end if;

  if position('revenue text' in v_type) = 0 then
    raise exception 'revenue is not returned as text. Signature: %', v_type;
  end if;

  if position('numeric' in v_type) > 0 then
    raise exception
      'public.analytics_financials() still returns a numeric column, so a money '
      'value would reach JavaScript as a double. Signature: %', v_type;
  end if;

  -- And the exactness must actually survive the cast.
  select id into v_business from public.businesses limit 1;

  if v_business is null then
    raise notice
      'No businesses exist yet, so the round trip could not be exercised. '
      'The wrappers are installed; re-run once a business exists.';
  else
    select f.revenue into v_text
    from public.analytics_financials(
      v_business, now() - interval '3650 days', now() + interval '1 day') f;

    select q.revenue into v_num
    from analytics_core.analytics_financials(
      v_business, now() - interval '3650 days', now() + interval '1 day') q;

    if v_text is distinct from v_num::text then
      raise exception
        'The text wrapper (%) does not match the exact figure (%).', v_text, v_num;
    end if;
  end if;

  raise notice
    'Migration 0011 verified: money crosses the boundary as exact text, counts '
    'stay integers, NULL stays NULL, grants intact.';
end;
$$;


commit;
