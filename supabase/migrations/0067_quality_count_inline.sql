-- ============================================================================
-- 0067  dashboard_overview / dashboard_accounts: count quality issues inline
-- ============================================================================
-- Measured directly (owner's real data, Supabase SQL Editor, RLS simulated
-- as the real signed-in owner, 2026-10-02):
--
--   ledger_data_quality()'s own SQL, run as a plain query ........ ~2.1s
--   the SAME SQL, called as a function (select * from ledger_data_quality(..))
--                                                                  .. 8.6-15.6s
--
-- Identical work, identical RLS, identical data -- the only difference is
-- calling it AS A FUNCTION. PostgreSQL cannot inline a SQL-language function
-- whose body has a top-level WITH clause (documented planner limitation);
-- ledger_data_quality() has one (needed so the classified, date-scoped lines
-- are computed once and shared across its 4-6 issue-kind branches, not
-- recomputed per branch -- 0066). Called as an opaque function, it loses the
-- joint optimisation a plain query gets, and that cost compounds under RLS.
--
-- dashboard_overview() and dashboard_accounts() each call
-- ledger_data_quality() once per load, purely to COUNT open issues (not read
-- their detail) -- that single nested call was the dominant cost in both,
-- and both are on the page that was timing out.
--
-- Fix: inline the SAME scoped/scoped_files/issues logic directly into each
-- function's own body, copied verbatim from 0066 (only the branch that
-- these two callers already discarded -- UNDER_REVIEW, filtered out by both
-- via issue_kind <> 'UNDER_REVIEW' -- is dropped, since computing it just to
-- throw it away is wasted work). This is the exact SQL 0066 already proved
-- correct, run as a plain query instead of a function call, which is the
-- form measured fast above.
--
-- This does create two copies of the same issue-detection rules (plus
-- ledger_data_quality() itself, used elsewhere unchanged -- the dedicated
-- Data Quality page, reports, Ask BizMind). That duplication is a real
-- maintenance cost, accepted deliberately for the measured ~4-7x speedup on
-- the page that was actually failing; a cleaner single-source fix is still
-- open (see the owner conversation, 2026-10-02) and does not block this.
--
-- Nothing about WHICH lines count as an issue, or how, changes anywhere.
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

  -- 0067: was `select count(*) into v_quality from public.ledger_data_quality(...)
  -- where issue_kind <> 'UNDER_REVIEW'` -- a nested function call that, measured
  -- directly, cost ~6-13s more than running its own SQL as a plain query (see
  -- header). Same rules, same five issue kinds (UNDER_REVIEW excluded exactly as
  -- the old call excluded it), copied verbatim from 0066, just not wrapped in a
  -- function call.
  with scoped as materialized (
    select l.*
    from public.ledger_classified_lines l
    where l.posted_at >= p_from and l.posted_at < p_to
      and (p_account_id is null or l.marketplace_account_id = p_account_id)
      and l.business_id = p_business_id
  ),
  scoped_files as materialized (
    select distinct s.marketplace_account_id, s.account_label, s.marketplace_code, s.currency, s.source_file_id
    from scoped s
  ),
  issues as (
    select s.marketplace_account_id, s.currency::char(3) as currency
    from scoped s
    where s.classification_status = 'UNKNOWN'
    group by s.marketplace_account_id, s.account_label, s.marketplace_code, s.currency, s.format_id, s.match_key

    union all

    select s.marketplace_account_id, s.currency::char(3)
    from scoped s
    where s.pnl_treatment = 'CONDITIONAL'
    group by s.marketplace_account_id, s.account_label, s.marketplace_code, s.currency

    union all

    select s.marketplace_account_id, s.currency::char(3)
    from scoped s
    left join public.tax_profiles tp on tp.marketplace_account_id = s.marketplace_account_id
    group by s.marketplace_account_id, s.account_label, s.marketplace_code, s.currency,
             date_trunc('month', s.posted_at at time zone 'UTC'), tp.input_vat_treatment
    having bool_or(s.rule_includes_vat)
       and not bool_or(s.rule_separates_vat)
       and coalesce(tp.input_vat_treatment, 'UNKNOWN') <> 'NON_RECOVERABLE'

    union all

    select f.marketplace_account_id, f.currency::char(3)
    from scoped_files f
    join public.import_issues i on i.batch_id = f.source_file_id and i.severity = 'ERROR'
    group by f.marketplace_account_id, f.account_label, f.marketplace_code, f.currency

    union all

    select st.marketplace_account_id, st.currency::char(3)
    from public.settlements st
    join (select distinct sf.source_file_id from scoped_files sf) sf on sf.source_file_id = st.source_file_id
    join public.marketplace_accounts a on a.id = st.marketplace_account_id
    left join public.financial_transactions ft on ft.settlement_id = st.id
    group by st.id, st.marketplace_account_id, a.label, a.marketplace_code, st.currency,
             st.external_settlement_id, st.reported_total
    having st.reported_total is not null and st.reported_total <> coalesce(sum(ft.amount), 0)
  )
  select count(*) into v_quality from issues q where q.currency = p_currency;

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

revoke all on function public.dashboard_overview(uuid, text, timestamptz, timestamptz, uuid) from anon, public;
grant execute on function public.dashboard_overview(uuid, text, timestamptz, timestamptz, uuid) to authenticated;

-- ----------------------------------------------------------------------------
-- dashboard_accounts: same change, its own `quality` CTE inline instead of a
-- nested ledger_data_quality() call.
-- ----------------------------------------------------------------------------

create or replace function public.dashboard_accounts(
  p_business_id uuid,
  p_currency    text,
  p_from        timestamptz,
  p_to          timestamptz
)
returns table (
  marketplace_account_id  uuid,
  account_label           text,
  marketplace_code        text,
  has_lines               boolean,
  gross_sales             text,
  sales_refunds           text,
  net_sales               text,
  marketplace_costs       text,
  advertising             text,
  contribution            text,
  contribution_status     text,
  contribution_before_open_items text,
  contribution_margin_pct numeric,
  expected_inflow         text,
  expected_payouts        bigint,
  open_quality_items      bigint,
  share_of_net_sales_pct  numeric,
  costs_pct_of_net_sales  numeric
)
language sql
stable
security invoker
set search_path = ''
as $$
with accounts as (
  select a.id, a.label, a.marketplace_code
  from public.marketplace_accounts a
  where a.business_id = p_business_id and a.currency = p_currency
),
types as (
  select * from public.dashboard_line_types(p_business_id, p_currency, p_from, p_to, null)
),
errors as (
  select distinct f.marketplace_account_id
  from (select t.marketplace_account_id, unnest(t.files) as file_id from types t) f
  where exists (select 1 from public.import_issues i where i.batch_id = f.file_id and i.severity = 'ERROR')
),
figures as (
  select
    t.marketplace_account_id,
    coalesce(sum(t.amount) filter (where t.metric_group = 'GROSS_SALES'), 0)                       as gross,
    coalesce(sum(t.amount) filter (where t.metric_group = 'SALES_REFUNDS'), 0)                     as refunds,
    coalesce(sum(t.amount) filter (where t.metric_group in ('GROSS_SALES', 'SALES_REFUNDS', 'SELLER_DISCOUNTS')), 0) as net,
    coalesce(sum(t.amount) filter (where t.metric_group in ('MARKETPLACE_FEES', 'FULFILLMENT', 'ADVERTISING', 'OTHER_MARKETPLACE_COSTS')
                                     or (t.metric_group = 'INPUT_VAT' and t.pnl_treatment = 'INCREASE_EXPENSE')), 0) as costs,
    coalesce(sum(t.amount) filter (where t.metric_group = 'ADVERTISING'), 0)                       as ads,
    coalesce(sum(t.amount) filter (where t.pnl_treatment in ('INCREASE_REVENUE', 'DECREASE_REVENUE', 'INCREASE_EXPENSE')), 0) as known,
    (bool_or(t.rule_id is null)
      or bool_or(t.pnl_treatment = 'CONDITIONAL')
      or (bool_or(t.rule_includes_vat) and not bool_or(t.rule_separates_vat) and min(t.vat_setting) <> 'NON_RECOVERABLE')
      or bool_or(e.marketplace_account_id is not null))                                            as incomplete
  from types t
  left join errors e on e.marketplace_account_id = t.marketplace_account_id
  group by t.marketplace_account_id
),
payouts as (
  select e.marketplace_account_id, count(*) as n, sum(e.expected_amount::numeric) as inflow
  from public.expected_payouts(p_business_id, p_from, p_to, null) e
  where e.currency = p_currency
  group by 1
),
-- 0067: inline instead of a nested ledger_data_quality() call -- see 0067's
-- header for the measured cost of calling it as a function. Same rules
-- (UNDER_REVIEW excluded, exactly as the old call's own filter excluded it),
-- copied verbatim from 0066.
quality_scoped as materialized (
  select l.*
  from public.ledger_classified_lines l
  where l.posted_at >= p_from and l.posted_at < p_to
    and l.business_id = p_business_id
),
quality_scoped_files as materialized (
  select distinct s.marketplace_account_id, s.account_label, s.marketplace_code, s.currency, s.source_file_id
  from quality_scoped s
),
quality_issues as (
  select s.marketplace_account_id, s.currency::char(3) as currency
  from quality_scoped s
  where s.classification_status = 'UNKNOWN'
  group by s.marketplace_account_id, s.account_label, s.marketplace_code, s.currency, s.format_id, s.match_key

  union all

  select s.marketplace_account_id, s.currency::char(3)
  from quality_scoped s
  where s.pnl_treatment = 'CONDITIONAL'
  group by s.marketplace_account_id, s.account_label, s.marketplace_code, s.currency

  union all

  select s.marketplace_account_id, s.currency::char(3)
  from quality_scoped s
  left join public.tax_profiles tp on tp.marketplace_account_id = s.marketplace_account_id
  group by s.marketplace_account_id, s.account_label, s.marketplace_code, s.currency,
           date_trunc('month', s.posted_at at time zone 'UTC'), tp.input_vat_treatment
  having bool_or(s.rule_includes_vat)
     and not bool_or(s.rule_separates_vat)
     and coalesce(tp.input_vat_treatment, 'UNKNOWN') <> 'NON_RECOVERABLE'

  union all

  select f.marketplace_account_id, f.currency::char(3)
  from quality_scoped_files f
  join public.import_issues i on i.batch_id = f.source_file_id and i.severity = 'ERROR'
  group by f.marketplace_account_id, f.account_label, f.marketplace_code, f.currency

  union all

  select st.marketplace_account_id, st.currency::char(3)
  from public.settlements st
  join (select distinct sf.source_file_id from quality_scoped_files sf) sf on sf.source_file_id = st.source_file_id
  join public.marketplace_accounts a on a.id = st.marketplace_account_id
  left join public.financial_transactions ft on ft.settlement_id = st.id
  group by st.id, st.marketplace_account_id, a.label, a.marketplace_code, st.currency,
           st.external_settlement_id, st.reported_total
  having st.reported_total is not null and st.reported_total <> coalesce(sum(ft.amount), 0)
),
quality as (
  select q.marketplace_account_id, count(*) as n
  from quality_issues q
  where q.currency = p_currency
  group by 1
),
total as (
  select sum(f.net) as net from figures f
)
select
  a.id,
  a.label,
  a.marketplace_code,
  f.marketplace_account_id is not null,
  f.gross::numeric(20,4)::text,
  f.refunds::numeric(20,4)::text,
  f.net::numeric(20,4)::text,
  f.costs::numeric(20,4)::text,
  f.ads::numeric(20,4)::text,
  case when f.incomplete then null else f.known::numeric(20,4)::text end,
  case when f.marketplace_account_id is null or f.incomplete then 'INCOMPLETE' else 'FINAL' end,
  f.known::numeric(20,4)::text,
  case when f.incomplete then null else public.dashboard_pct(f.known, f.net) end,
  p.inflow::numeric(20,4)::text,
  coalesce(p.n, 0),
  coalesce(q.n, 0),
  public.dashboard_pct(f.net, t.net),
  public.dashboard_pct(-f.costs, f.net)
from accounts a
left join figures f on f.marketplace_account_id = a.id
left join payouts p on p.marketplace_account_id = a.id
left join quality q on q.marketplace_account_id = a.id
cross join total t
order by f.net desc nulls last, a.label;
$$;

revoke all on function public.dashboard_accounts(uuid, text, timestamptz, timestamptz) from anon, public;
grant execute on function public.dashboard_accounts(uuid, text, timestamptz, timestamptz) to authenticated;

do $$
begin
  if exists (
    select 1 from pg_proc p join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'public' and p.proname in ('dashboard_overview', 'dashboard_accounts')
      and (p.prosecdef or has_function_privilege('anon', p.oid, 'EXECUTE'))
  ) then
    raise exception 'SECURITY: dashboard_overview/dashboard_accounts must be SECURITY INVOKER and closed to anon.';
  end if;
  raise notice 'Migration 0067 verified: dashboard_overview and dashboard_accounts count quality issues inline.';
end;
$$;

commit;
