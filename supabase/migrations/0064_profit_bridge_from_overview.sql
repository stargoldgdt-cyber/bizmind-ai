-- ============================================================================
-- 0064  Dashboard: stop computing the profit bridge twice
-- ============================================================================
-- The live year-to-date "whole business" view is hitting a hard Postgres
-- statement timeout (owner screenshot, 2026-10-02: "canceling statement due
-- to statement timeout"). 0063 added the missing index for that scope; this
-- migration removes the single biggest duplicate scan still on the page.
--
-- dashboard_overview() (0050) already calls pnl_summary() twice -- once for
-- the period, once for the period before it (v_cur / v_prev) -- to work out
-- its own *_change_pct columns. dashboard_profit_bridge() (0060) was written
-- to call pnl_summary() AGAIN, for the SAME two ranges ("copied verbatim" from
-- dashboard_overview, per its own comment), just to read a few more fields off
-- the same two rows. Every dashboard load was running the expensive
-- classification join four times over instead of two.
--
-- Fix: v_prev's raw fields were computed and then thrown away. Now they are
-- kept, as one new `prev_snapshot` column holding exactly the fields the
-- bridge needs -- same exact-decimal text values, nothing recomputed,
-- nothing rounded. dashboard_profit_bridge() changes from five scalar
-- arguments to the one jsonb row dashboard_overview() already produced --
-- exactly the pattern dashboard_waterfall_steps() (0049) already uses for the
-- same reason. It does no table access at all now: no pnl_summary() call,
-- no ledger read, just arithmetic on two numbers already in hand.
--
-- The bridge's own steps, labels, skip-if-zero list and bar-scaling are
-- unchanged byte for byte -- only where the inputs come from has changed.
-- Additive to dashboard_overview (one new column); dashboard_profit_bridge's
-- old signature is dropped since nothing will call it after this.
-- APPLY THIS IN THE SUPABASE SQL EDITOR.
-- Clear the editor first: click in it, press Ctrl+A, then Delete.
-- ============================================================================

begin;

drop function if exists public.dashboard_overview(uuid, text, timestamptz, timestamptz, uuid);

create function public.dashboard_overview(
  p_business_id uuid,
  p_currency    text,
  p_from        timestamptz,
  p_to          timestamptz,
  p_account_id  uuid default null
)
returns table (
  currency                       text,
  scope_label                    text,
  accounts                       bigint,
  has_marketplace_data           boolean,
  lines                          bigint,
  review_lines                   bigint,
  unknown_lines                  bigint,
  gross_sales                    text,
  sales_refunds                  text,
  seller_discounts               text,
  net_sales                      text,
  other_income                   text,
  marketplace_fees               text,
  fulfillment                    text,
  advertising                    text,
  other_marketplace_costs        text,
  non_recoverable_vat            text,
  marketplace_costs              text,
  figures_status                 text,
  contribution                   text,
  contribution_status            text,
  contribution_before_open_items text,
  contribution_reasons           text[],
  units_sold                     text,
  cogs                           text,
  units_without_product          text,
  units_without_cost             text,
  gross_profit                   text,
  gross_profit_status            text,
  gross_profit_before_open_items text,
  gross_profit_reasons           text[],
  net_available                  boolean,
  operating_expenses              text,
  external_advertising           text,
  net_profit                     text,
  net_profit_status              text,
  net_profit_before_open_items   text,
  net_profit_reasons             text[],
  input_vat_treatment            text,
  refunds_pct_of_gross           numeric,
  costs_pct_of_net_sales         numeric,
  fees_pct_of_net_sales          numeric,
  advertising_pct_of_net_sales   numeric,
  contribution_margin_pct        numeric,
  gross_margin_pct               numeric,
  net_margin_pct                 numeric,
  prev_has_marketplace_data      boolean,
  -- 0064: the previous period's own raw fields, already computed below as
  -- v_prev, kept instead of discarded. Exact decimal text in, exact decimal
  -- text out -- never touched as a JSON number.
  prev_snapshot                  jsonb,
  gross_sales_change_pct         numeric,
  net_sales_change_pct           numeric,
  marketplace_costs_change_pct   numeric,
  contribution_change_pct        numeric,
  gross_profit_change_pct        numeric,
  net_profit_change_pct          numeric,
  expected_payouts               bigint,
  expected_inflow                text,
  payouts_in_doubt               bigint,
  open_quality_items             bigint,
  unmatched_skus                 bigint,
  unplaced_expense_categories    bigint
)
language plpgsql
stable
security invoker
set search_path = ''
as $$
declare
  v_prev_from timestamptz := p_from - (p_to - p_from);
  v_cur       record;
  v_prev      record;
  v_net       record;
  v_prev_net  record;
  v_has       boolean;
  v_prev_has  boolean;
  v_sole      boolean;
  v_label     text;
  v_accounts  bigint;
  v_costs     numeric;
  v_prev_cost numeric;
  v_payouts   bigint;
  v_inflow    numeric;
  v_doubt     bigint;
  v_quality   bigint;
  v_skus      bigint;
  v_expense_q bigint;
  v_months    integer;
begin
  -- 0049: any whole-month range compares with the same number of months just
  -- before it (a month with the month before, a quarter with the quarter
  -- before, 12 months with the 12 before). Other ranges are not compared.
  if date_trunc('month', p_from at time zone 'UTC') = (p_from at time zone 'UTC')
     and date_trunc('month', p_to at time zone 'UTC') = (p_to at time zone 'UTC')
     and p_to > p_from then
    v_months := (extract(year from p_to at time zone 'UTC')::integer * 12 + extract(month from p_to at time zone 'UTC')::integer)
              - (extract(year from p_from at time zone 'UTC')::integer * 12 + extract(month from p_from at time zone 'UTC')::integer);
    v_prev_from := (((p_from at time zone 'UTC') - make_interval(months => v_months)) at time zone 'UTC');
  end if;

  select count(*) into v_accounts
  from public.marketplace_accounts a
  where a.business_id = p_business_id and a.currency = p_currency
    and (p_account_id is null or a.id = p_account_id);
  v_sole := (select count(*) from public.marketplace_accounts a
             where a.business_id = p_business_id and a.currency = p_currency) = 1;

  if p_account_id is null then
    v_label := 'All ' || p_currency || ' marketplace accounts';
  else
    select a.label into v_label from public.marketplace_accounts a
    where a.id = p_account_id and a.business_id = p_business_id and a.currency = p_currency;
  end if;

  select s.* into v_cur
  from public.pnl_summary(p_from, p_to, p_account_id, p_business_id, p_account_id is null) s
  where s.currency = p_currency
  limit 1;
  v_has := found;

  select s.* into v_prev
  from public.pnl_summary(v_prev_from, p_from, p_account_id, p_business_id, p_account_id is null) s
  where s.currency = p_currency
  limit 1;
  v_prev_has := found;

  -- Always read (a record must be assigned before the final query touches
  -- it); used below only when net profit belongs to this scope.
  -- 0050: net profit from the summary already read (v_cur / v_prev), with
  -- exactly pnl_net_profit()'s rule, instead of pnl_net_profit() running the
  -- whole pnl_summary() again. v_cur is the currency's combined summary for
  -- the whole business, and an account's own summary when it is alone in its
  -- currency -- the only two scopes that show net profit (A7).
  select
    case
      when not v_has or v_cur.gross_profit is null or coalesce(x.unclassified_lines, 0) > 0 then null
      else (v_cur.gross_profit::numeric + coalesce(x.operating_expenses, '0')::numeric
            + coalesce(x.external_advertising, '0')::numeric)::numeric(20,4)::text
    end                                                                            as net_profit,
    case
      when not v_has or v_cur.gross_profit is null or coalesce(x.unclassified_lines, 0) > 0 then 'INCOMPLETE'
      else 'FINAL'
    end                                                                            as net_profit_status,
    (coalesce(case when v_has then v_cur.gross_profit_before_open_items end, '0')::numeric
      + coalesce(x.operating_expenses, '0')::numeric
      + coalesce(x.external_advertising, '0')::numeric)::numeric(20,4)::text      as net_profit_before_open_items,
    coalesce(case when v_has then v_cur.gross_profit_reasons end, '{}'::text[])
      || array_remove(array[
           case when not v_has then 'NO_MARKETPLACE_DATA' end,
           case when coalesce(x.unclassified_lines, 0) > 0 then 'EXPENSES_UNCLASSIFIED' end
         ], null)                                                                  as net_profit_reasons,
    coalesce(x.operating_expenses, '0')::numeric(20,4)::text                       as operating_expenses,
    coalesce(x.external_advertising, '0')::numeric(20,4)::text                     as external_advertising
  into v_net
  from (select 1) one
  left join lateral (
    select e.* from public.expense_summary(p_from, p_to, p_business_id) e where e.currency = p_currency
  ) x on true;

  select
    case
      when not v_prev_has or v_prev.gross_profit is null or coalesce(x.unclassified_lines, 0) > 0 then null
      else (v_prev.gross_profit::numeric + coalesce(x.operating_expenses, '0')::numeric
            + coalesce(x.external_advertising, '0')::numeric)::numeric(20,4)::text
    end                                                                            as net_profit
  into v_prev_net
  from (select 1) one
  left join lateral (
    select e.* from public.expense_summary(v_prev_from, p_from, p_business_id) e where e.currency = p_currency
  ) x on true;

  if v_has then
    v_costs := v_cur.marketplace_fees::numeric + v_cur.fulfillment::numeric + v_cur.advertising::numeric
             + v_cur.other_marketplace_costs::numeric + v_cur.non_recoverable_vat::numeric;
  end if;
  if v_prev_has then
    v_prev_cost := v_prev.marketplace_fees::numeric + v_prev.fulfillment::numeric + v_prev.advertising::numeric
                 + v_prev.other_marketplace_costs::numeric + v_prev.non_recoverable_vat::numeric;
  end if;

  select count(*), sum(e.expected_amount::numeric), count(*) filter (where e.marketplace_status = 'DOES_NOT_ADD_UP')
    into v_payouts, v_inflow, v_doubt
  from public.expected_payouts(p_business_id, p_from, p_to, p_account_id) e
  where e.currency = p_currency;

  select count(*) into v_quality
  from public.ledger_data_quality(p_from, p_to, p_account_id, p_business_id) q
  where q.currency = p_currency and q.issue_kind <> 'UNDER_REVIEW';

  -- SKUs sold in THIS scope and month with no product (0046). The whole
  -- business's queue (sku_mapping_queue) was too slow to build per page view.
  select count(distinct (l.marketplace_code, l.raw_sku)) into v_skus
  from public.ledger_classified_lines l
  where l.business_id = p_business_id
    and l.currency = p_currency
    and (p_account_id is null or l.marketplace_account_id = p_account_id)
    and l.posted_at >= p_from and l.posted_at < p_to
    and l.raw_sku is not null
    and l.category = 'PRODUCT_SALES' and l.quantity is not null
    and not exists (
      select 1 from public.sku_aliases s
      where s.business_id = l.business_id and s.marketplace_code = l.marketplace_code
        and s.raw_sku = l.raw_sku and s.status = 'CONFIRMED'
    );

  select count(*) into v_expense_q
  from public.expense_category_queue(p_business_id) q
  where position(p_currency in q.currencies) > 0;

  return query select
    p_currency,
    coalesce(v_label, p_currency),
    v_accounts,
    v_has,
    case when v_has then v_cur.lines end,
    case when v_has then v_cur.review_lines end,
    case when v_has then v_cur.unknown_lines end,
    case when v_has then v_cur.gross_sales end,
    case when v_has then v_cur.sales_refunds end,
    case when v_has then v_cur.seller_discounts end,
    case when v_has then v_cur.net_sales end,
    case when v_has then v_cur.other_income end,
    case when v_has then v_cur.marketplace_fees end,
    case when v_has then v_cur.fulfillment end,
    case when v_has then v_cur.advertising end,
    case when v_has then v_cur.other_marketplace_costs end,
    case when v_has then v_cur.non_recoverable_vat end,
    v_costs::numeric(20,4)::text,
    case when v_has then v_cur.figures_status end,
    case when v_has then v_cur.contribution end,
    case when v_has then v_cur.contribution_status else 'INCOMPLETE' end,
    case when v_has then v_cur.contribution_before_open_items end,
    case when v_has then v_cur.incomplete_reasons else array['NO_MARKETPLACE_DATA'] end,
    case when v_has then v_cur.units_sold end,
    case when v_has then v_cur.cogs end,
    case when v_has then v_cur.units_without_product end,
    case when v_has then v_cur.units_without_cost end,
    case when v_has then v_cur.gross_profit end,
    case when v_has then v_cur.gross_profit_status else 'INCOMPLETE' end,
    case when v_has then v_cur.gross_profit_before_open_items end,
    case when v_has then v_cur.gross_profit_reasons else array['NO_MARKETPLACE_DATA'] end,
    (p_account_id is null or v_sole),
    case when p_account_id is null or v_sole then coalesce(v_net.operating_expenses, '0.0000') end,
    case when p_account_id is null or v_sole then coalesce(v_net.external_advertising, '0.0000') end,
    case when p_account_id is null or v_sole then v_net.net_profit end,
    case when p_account_id is null or v_sole then coalesce(v_net.net_profit_status, 'INCOMPLETE') else 'INCOMPLETE' end,
    case when p_account_id is null or v_sole then v_net.net_profit_before_open_items end,
    case
      when p_account_id is not null and not v_sole then array['EXPENSES_BUSINESS_WIDE']
      else coalesce(v_net.net_profit_reasons, array['NO_MARKETPLACE_DATA'])
    end,
    case when v_has then v_cur.input_vat_treatment end,
    case when v_has then public.dashboard_pct(-v_cur.sales_refunds::numeric, v_cur.gross_sales::numeric) end,
    case when v_has then public.dashboard_pct(-v_costs, v_cur.net_sales::numeric) end,
    case when v_has then public.dashboard_pct(-v_cur.marketplace_fees::numeric, v_cur.net_sales::numeric) end,
    case when v_has then public.dashboard_pct(-v_cur.advertising::numeric, v_cur.net_sales::numeric) end,
    case when v_has then public.dashboard_pct(v_cur.contribution::numeric, v_cur.net_sales::numeric) end,
    case when v_has then public.dashboard_pct(v_cur.gross_profit::numeric, v_cur.net_sales::numeric) end,
    case when v_has and (p_account_id is null or v_sole) then public.dashboard_pct(v_net.net_profit::numeric, v_cur.net_sales::numeric) end,
    v_prev_has,
    case when v_prev_has then jsonb_build_object(
      'figures_status', v_prev.figures_status,
      'net_sales', v_prev.net_sales,
      'other_income', v_prev.other_income,
      'marketplace_fees', v_prev.marketplace_fees,
      'fulfillment', v_prev.fulfillment,
      'advertising', v_prev.advertising,
      'other_marketplace_costs', v_prev.other_marketplace_costs,
      'non_recoverable_vat', v_prev.non_recoverable_vat,
      'contribution_before_open_items', v_prev.contribution_before_open_items,
      'contribution_status', v_prev.contribution_status
    ) end,
    case when v_has and v_prev_has then public.dashboard_change(v_cur.gross_sales::numeric, v_prev.gross_sales::numeric) end,
    case when v_has and v_prev_has then public.dashboard_change(v_cur.net_sales::numeric, v_prev.net_sales::numeric) end,
    -- Costs are negative; a rise in costs is a positive change in their size.
    case when v_has and v_prev_has then public.dashboard_change(-v_costs, -v_prev_cost) end,
    case when v_has and v_prev_has then public.dashboard_change(v_cur.contribution::numeric, v_prev.contribution::numeric) end,
    case when v_has and v_prev_has then public.dashboard_change(v_cur.gross_profit::numeric, v_prev.gross_profit::numeric) end,
    case when p_account_id is null or v_sole then public.dashboard_change(v_net.net_profit::numeric, v_prev_net.net_profit::numeric) end,
    coalesce(v_payouts, 0),
    v_inflow::numeric(20,4)::text,
    coalesce(v_doubt, 0),
    coalesce(v_quality, 0),
    coalesce(v_skus, 0),
    coalesce(v_expense_q, 0);
end;
$$;

do $$
begin
  revoke all on function public.dashboard_overview(uuid, text, timestamptz, timestamptz, uuid) from anon, public;
  grant execute on function public.dashboard_overview(uuid, text, timestamptz, timestamptz, uuid) to authenticated;
end;
$$;

-- ----------------------------------------------------------------------------
-- dashboard_profit_bridge: now reads the overview row it is handed, instead
-- of recomputing it. Same 9 steps, same labels, same skip-if-zero list, same
-- bar-scaling -- only the source of v_cur/v_prev has changed.
-- ----------------------------------------------------------------------------

drop function if exists public.dashboard_profit_bridge(uuid, text, timestamptz, timestamptz, uuid);

create function public.dashboard_profit_bridge(p_overview jsonb)
returns table (
  step     integer,
  label    text,
  kind     text,
  amount   text,
  status   text,
  bar_from integer,
  bar_to   integer,
  zero_at  integer
)
language sql
immutable
security invoker
set search_path = ''
as $$
with o as (
  select * from jsonb_to_record(p_overview) as x(
    has_marketplace_data      boolean,
    figures_status            text,
    net_sales                 text,
    other_income               text,
    marketplace_fees          text,
    fulfillment               text,
    advertising               text,
    other_marketplace_costs   text,
    non_recoverable_vat       text,
    contribution_before_open_items text,
    contribution_status       text,
    prev_has_marketplace_data boolean,
    prev_snapshot             jsonb
  )
),
prev as (
  select
    y.net_sales                      as net_sales,
    y.other_income                   as other_income,
    y.marketplace_fees                as marketplace_fees,
    y.fulfillment                    as fulfillment,
    y.advertising                    as advertising,
    y.other_marketplace_costs        as other_marketplace_costs,
    y.non_recoverable_vat            as non_recoverable_vat,
    y.contribution_before_open_items as contribution_before_open_items,
    y.contribution_status            as contribution_status,
    y.figures_status                 as figures_status
  from o, lateral jsonb_to_record(coalesce(o.prev_snapshot, '{}'::jsonb)) as y(
    net_sales text, other_income text, marketplace_fees text, fulfillment text,
    advertising text, other_marketplace_costs text, non_recoverable_vat text,
    contribution_before_open_items text, contribution_status text, figures_status text
  )
),
steps as (
  select v.step, v.label, v.kind, v.amount::numeric as amount, v.status
  from o, prev, lateral (values
    (1, 'Previous contribution',     'START',
        prev.contribution_before_open_items,
        prev.contribution_status),
    (2, 'Net sales',                 'DELTA',
        (o.net_sales::numeric - prev.net_sales::numeric)::text,
        case when o.figures_status = 'FINAL' and prev.figures_status = 'FINAL' then 'FINAL' else 'INCOMPLETE' end),
    (3, 'Other income',              'DELTA',
        (o.other_income::numeric - prev.other_income::numeric)::text,
        case when o.figures_status = 'FINAL' and prev.figures_status = 'FINAL' then 'FINAL' else 'INCOMPLETE' end),
    (4, 'Marketplace fees',          'DELTA',
        (o.marketplace_fees::numeric - prev.marketplace_fees::numeric)::text,
        case when o.figures_status = 'FINAL' and prev.figures_status = 'FINAL' then 'FINAL' else 'INCOMPLETE' end),
    (5, 'Fulfilment',                'DELTA',
        (o.fulfillment::numeric - prev.fulfillment::numeric)::text,
        case when o.figures_status = 'FINAL' and prev.figures_status = 'FINAL' then 'FINAL' else 'INCOMPLETE' end),
    (6, 'Advertising',               'DELTA',
        (o.advertising::numeric - prev.advertising::numeric)::text,
        case when o.figures_status = 'FINAL' and prev.figures_status = 'FINAL' then 'FINAL' else 'INCOMPLETE' end),
    (7, 'Other marketplace costs',   'DELTA',
        (o.other_marketplace_costs::numeric - prev.other_marketplace_costs::numeric)::text,
        case when o.figures_status = 'FINAL' and prev.figures_status = 'FINAL' then 'FINAL' else 'INCOMPLETE' end),
    (8, 'Non-recoverable VAT',       'DELTA',
        (o.non_recoverable_vat::numeric - prev.non_recoverable_vat::numeric)::text,
        case when o.figures_status = 'FINAL' and prev.figures_status = 'FINAL' then 'FINAL' else 'INCOMPLETE' end),
    (9, 'Current contribution',      'END',
        o.contribution_before_open_items,
        o.contribution_status)
  ) as v(step, label, kind, amount, status)
  where coalesce(o.has_marketplace_data, false)
    and coalesce(o.prev_has_marketplace_data, false)
    and v.amount is not null
    -- Optional steps appear only when they carry something (mirrors
    -- dashboard_waterfall_steps' own skip-if-zero list).
    and not (v.step in (3, 7, 8) and v.amount::numeric = 0)
),
running as (
  select
    s.*,
    case when s.kind in ('START', 'END') then 0::numeric
         else coalesce(max(s.amount) filter (where s.kind = 'START') over (), 0)
              + coalesce(sum(s.amount) filter (where s.kind = 'DELTA') over (order by s.step rows between unbounded preceding and 1 preceding), 0)
    end as start_value,
    case when s.kind in ('START', 'END') then s.amount
         else coalesce(max(s.amount) filter (where s.kind = 'START') over (), 0)
              + sum(s.amount) filter (where s.kind = 'DELTA') over (order by s.step rows between unbounded preceding and current row)
    end as end_value
  from steps s
),
domain as (
  select least(0, min(least(r.start_value, r.end_value))) as lo,
         greatest(0, max(greatest(r.start_value, r.end_value))) as hi
  from running r
)
select
  r.step,
  r.label,
  r.kind,
  r.amount::numeric(20,4)::text,
  r.status,
  case when d.hi = d.lo then 0 else round((least(r.start_value, r.end_value) - d.lo) / (d.hi - d.lo) * 1000)::integer end,
  case when d.hi = d.lo then 0 else round((greatest(r.start_value, r.end_value) - d.lo) / (d.hi - d.lo) * 1000)::integer end,
  case when d.hi = d.lo then 0 else round((0 - d.lo) / (d.hi - d.lo) * 1000)::integer end
from running r cross join domain d
order by r.step;
$$;

do $$
begin
  revoke all on function public.dashboard_profit_bridge(jsonb) from anon, public;
  grant execute on function public.dashboard_profit_bridge(jsonb) to authenticated;
end;
$$;

do $$
begin
  if exists (
    select 1 from pg_proc p join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'public' and p.proname in ('dashboard_overview', 'dashboard_profit_bridge')
      and (p.prosecdef or has_function_privilege('anon', p.oid, 'EXECUTE'))
  ) then
    raise exception 'SECURITY: dashboard_overview/dashboard_profit_bridge must be SECURITY INVOKER and closed to anon.';
  end if;
  if exists (
    select 1 from pg_proc p join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'public' and p.proname = 'dashboard_profit_bridge'
      and pg_get_function_identity_arguments(p.oid) <> 'p_overview jsonb'
  ) then
    raise exception 'MIGRATION 0064: an old dashboard_profit_bridge signature is still present.';
  end if;
  raise notice 'Migration 0064 verified: dashboard_profit_bridge() reads the overview row instead of recomputing it.';
end;
$$;

commit;
