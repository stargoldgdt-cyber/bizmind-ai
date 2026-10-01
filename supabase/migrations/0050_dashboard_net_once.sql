-- ============================================================================
-- 0050  Dashboard: net profit from the summary already read
-- ============================================================================
-- On the owner's data (about 33,000 lines) the 12-month executive dashboard
-- hit the 8-second statement timeout when all its readers ran together.
-- dashboard_overview() read the P&L summary, then called pnl_net_profit(),
-- which reads the same summary again -- for the period and for the period
-- before it.
--
-- Now net profit is worked out from the summary already in hand plus
-- expense_summary(), with exactly pnl_net_profit()'s rule:
--   net profit = gross profit + operating expenses + advertising elsewhere,
--   FINAL only when gross profit is final and every expense category is
--   placed; reasons are the gross-profit reasons plus NO_MARKETPLACE_DATA /
--   EXPENSES_UNCLASSIFIED.
-- Same signature and result. Nothing is stored; the ledger, classification,
-- VAT and P&L are unchanged (pnl_net_profit() itself is untouched).
-- APPLY THIS IN THE SUPABASE SQL EDITOR.
-- Clear the editor first: click in it, press Ctrl+A, then Delete.
-- ============================================================================

begin;

create or replace function public.dashboard_overview(
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
  operating_expenses             text,
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
  if exists (
    select 1 from pg_proc p join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'public' and p.proname = 'dashboard_overview'
      and (p.prosecdef or has_function_privilege('anon', p.oid, 'EXECUTE'))
  ) then
    raise exception 'SECURITY: dashboard_overview must be SECURITY INVOKER and closed to anon.';
  end if;
  raise notice 'Migration 0050 verified: dashboard net profit from the summary already read.';
end;
$$;

commit;
