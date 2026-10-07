-- ============================================================================
-- UNDO for 0076: put the 0052 pnl_summary() body back, exactly.
-- Run in the Supabase SQL editor (clear it first: Ctrl+A, Delete). Read-only function; no data is touched.
-- ============================================================================

begin;

create or replace function public.pnl_summary(
  p_from                 timestamptz,
  p_to                   timestamptz,
  p_account_id           uuid default null,
  p_business_id          uuid default null,
  p_combine_by_currency  boolean default false
)
returns table (
  marketplace_account_id          uuid,
  account_label                   text,
  marketplace_code                text,
  currency                        char(3),
  period_from                     timestamptz,
  period_to                       timestamptz,
  gross_sales                     text,
  sales_refunds                   text,
  seller_discounts                text,
  net_sales                       text,
  other_income                    text,
  marketplace_fees                text,
  fulfillment                     text,
  advertising                     text,
  other_marketplace_costs         text,
  non_recoverable_vat             text,
  contribution                    text,
  contribution_status             text,
  contribution_before_open_items  text,
  figures_status                  text,
  input_vat_recoverable           text,
  input_vat_unresolved            text,
  output_vat                      text,
  input_vat_treatment             text,
  lines                           bigint,
  unknown_lines                   bigint,
  unknown_amount                  text,
  review_lines                    bigint,
  review_amount                   text,
  conditional_lines               bigint,
  row_errors                      bigint,
  incomplete_reasons              text[],
  accounts                        bigint,
  units_sold                      text,
  cogs                            text,
  units_without_product           text,
  units_without_cost              text,
  sales_without_cost              text,
  gross_profit                    text,
  gross_profit_status             text,
  gross_profit_before_open_items  text,
  gross_profit_reasons            text[],
  -- 0052: additive KPIs, every marketplace, same reporting model.
  orders                          bigint,
  average_order_value             text,
  profit_per_order                text,
  gross_margin_pct                numeric
)
language sql
stable
security invoker
set search_path = ''
as $$
with scoped as (
  select l.*, l.amount::numeric(20,4) as amt
  from public.ledger_product_lines l
  where l.posted_at >= p_from
    and l.posted_at < p_to
    and (p_account_id is null or l.marketplace_account_id = p_account_id)
    and (p_business_id is null or l.business_id = p_business_id)
),
files as (
  select distinct s.marketplace_account_id, s.source_file_id from scoped s
),
errors as (
  select f.marketplace_account_id, count(*) as n
  from files f
  join public.import_issues i on i.batch_id = f.source_file_id and i.severity = 'ERROR'
  group by f.marketplace_account_id
),
per_account as (
  select
    s.marketplace_account_id,
    s.account_label,
    s.marketplace_code,
    s.currency,
    coalesce(sum(s.amt) filter (where s.metric_group = 'GROSS_SALES'), 0)             as gross_sales,
    coalesce(sum(s.amt) filter (where s.metric_group = 'SALES_REFUNDS'), 0)           as sales_refunds,
    coalesce(sum(s.amt) filter (where s.metric_group = 'SELLER_DISCOUNTS'), 0)        as seller_discounts,
    coalesce(sum(s.amt) filter (where s.metric_group = 'OTHER_INCOME'), 0)            as other_income,
    coalesce(sum(s.amt) filter (where s.metric_group = 'MARKETPLACE_FEES'), 0)        as marketplace_fees,
    coalesce(sum(s.amt) filter (where s.metric_group = 'FULFILLMENT'), 0)             as fulfillment,
    coalesce(sum(s.amt) filter (where s.metric_group = 'ADVERTISING'), 0)             as advertising,
    coalesce(sum(s.amt) filter (where s.metric_group = 'OTHER_MARKETPLACE_COSTS'), 0) as other_costs,
    coalesce(sum(s.amt) filter (where s.metric_group = 'INPUT_VAT'
                                  and s.pnl_treatment = 'INCREASE_EXPENSE'), 0)        as nonrec_vat,
    coalesce(sum(s.amt) filter (where s.metric_group = 'INPUT_VAT'
                                  and s.pnl_treatment = 'NO_PNL_IMPACT'), 0)           as rec_vat,
    coalesce(sum(s.amt) filter (where s.pnl_treatment = 'CONDITIONAL'), 0)            as unresolved_vat,
    coalesce(sum(s.amt) filter (where s.metric_group = 'OUTPUT_VAT'), 0)              as output_vat,
    coalesce(sum(s.amt) filter (where s.pnl_treatment in
      ('INCREASE_REVENUE', 'DECREASE_REVENUE', 'INCREASE_EXPENSE')), 0)                as pnl_known,
    count(*)                                                                         as lines,
    count(*) filter (where s.classification_status = 'UNKNOWN')                      as unknown_lines,
    coalesce(sum(s.amt) filter (where s.classification_status = 'UNKNOWN'), 0)        as unknown_amount,
    count(*) filter (where s.classification_status = 'UNDER_REVIEW')                 as review_lines,
    coalesce(sum(s.amt) filter (where s.classification_status = 'UNDER_REVIEW'), 0)   as review_amount,
    count(*) filter (where s.pnl_treatment = 'CONDITIONAL')                          as conditional_lines,
    (bool_or(s.rule_includes_vat) and not bool_or(s.rule_separates_vat))             as vat_inside_fees,
    coalesce(sum(s.quantity::numeric) filter (where s.is_cost_line), 0)               as units_sold,
    coalesce(sum(s.cogs::numeric) filter (where s.cogs_status = 'COSTED'), 0)          as cogs,
    coalesce(sum(s.quantity::numeric) filter (where s.cogs_status = 'NO_PRODUCT'), 0) as units_no_product,
    coalesce(sum(s.quantity::numeric) filter (where s.cogs_status = 'NO_COST'), 0)    as units_no_cost,
    coalesce(sum(s.amt) filter (where s.cogs_status in ('NO_PRODUCT', 'NO_COST')), 0) as sales_uncosted,
    -- 0052: an order counts once even when it has several lines (principal,
    -- shipping, several SKUs). Lines with no order reference are not orders.
    count(distinct s.order_ref) filter (where s.metric_group = 'GROSS_SALES' and s.order_ref is not null) as orders
  from scoped s
  group by s.marketplace_account_id, s.account_label, s.marketplace_code, s.currency
),
judged_account as (
  select
    pa.*,
    coalesce(e.n, 0)                                          as row_error_count,
    coalesce(tp.input_vat_treatment, 'UNKNOWN')               as vat_setting,
    (pa.vat_inside_fees
      and coalesce(tp.input_vat_treatment, 'UNKNOWN') <> 'NON_RECOVERABLE') as vat_not_separated
  from per_account pa
  left join errors e on e.marketplace_account_id = pa.marketplace_account_id
  left join public.tax_profiles tp on tp.marketplace_account_id = pa.marketplace_account_id
),
grouped as (
  select
    case when p_combine_by_currency then null else j.marketplace_account_id end as account_id,
    j.currency,
    case when p_combine_by_currency then 'All ' || j.currency || ' accounts' else min(j.account_label) end as label,
    case when count(distinct j.marketplace_code) = 1 then min(j.marketplace_code) else 'MIXED' end as code,
    case when count(distinct j.vat_setting) = 1 then min(j.vat_setting) else 'MIXED' end as vat_setting,
    sum(j.gross_sales) as gross_sales, sum(j.sales_refunds) as sales_refunds,
    sum(j.seller_discounts) as seller_discounts, sum(j.other_income) as other_income,
    sum(j.marketplace_fees) as marketplace_fees, sum(j.fulfillment) as fulfillment,
    sum(j.advertising) as advertising, sum(j.other_costs) as other_costs,
    sum(j.nonrec_vat) as nonrec_vat, sum(j.rec_vat) as rec_vat,
    sum(j.unresolved_vat) as unresolved_vat, sum(j.output_vat) as output_vat,
    sum(j.pnl_known) as pnl_known,
    sum(j.lines)::bigint as lines, sum(j.unknown_lines)::bigint as unknown_lines,
    sum(j.unknown_amount) as unknown_amount, sum(j.review_lines)::bigint as review_lines,
    sum(j.review_amount) as review_amount, sum(j.conditional_lines)::bigint as conditional_lines,
    sum(j.row_error_count)::bigint as row_error_count,
    bool_or(j.vat_not_separated) as vat_not_separated,
    count(*)::bigint as accounts,
    sum(j.units_sold) as units_sold,
    sum(j.cogs) as cogs,
    sum(j.units_no_product) as units_no_product,
    sum(j.units_no_cost) as units_no_cost,
    sum(j.sales_uncosted) as sales_uncosted,
    sum(j.orders)::bigint as orders
  from judged_account j
  group by case when p_combine_by_currency then null else j.marketplace_account_id end, j.currency
),
judged as (
  select
    g.*,
    (g.unknown_lines > 0 or g.row_error_count > 0 or g.vat_not_separated) as figures_incomplete,
    (g.unknown_lines > 0 or g.row_error_count > 0 or g.vat_not_separated
      or g.conditional_lines > 0)                                        as contribution_incomplete,
    array_remove(array[
      case when g.unknown_lines > 0 then 'UNKNOWN_LINES' end,
      case when g.conditional_lines > 0 then 'VAT_TREATMENT_UNKNOWN' end,
      case when g.vat_not_separated then 'FEE_VAT_NOT_SEPARATED' end,
      case when g.row_error_count > 0 then 'ROW_ERRORS' end
    ], null)                                                             as reasons,
    (g.gross_sales + g.sales_refunds + g.seller_discounts)                as net_sales
  from grouped g
)
select
  j.account_id,
  j.label,
  j.code,
  j.currency::char(3),
  p_from,
  p_to,
  j.gross_sales::numeric(20,4)::text,
  j.sales_refunds::numeric(20,4)::text,
  j.seller_discounts::numeric(20,4)::text,
  j.net_sales::numeric(20,4)::text,
  j.other_income::numeric(20,4)::text,
  j.marketplace_fees::numeric(20,4)::text,
  j.fulfillment::numeric(20,4)::text,
  j.advertising::numeric(20,4)::text,
  j.other_costs::numeric(20,4)::text,
  j.nonrec_vat::numeric(20,4)::text,
  case when j.contribution_incomplete then null else j.pnl_known::numeric(20,4)::text end,
  case when j.contribution_incomplete then 'INCOMPLETE' else 'FINAL' end,
  j.pnl_known::numeric(20,4)::text,
  case when j.figures_incomplete then 'INCOMPLETE' else 'FINAL' end,
  j.rec_vat::numeric(20,4)::text,
  j.unresolved_vat::numeric(20,4)::text,
  j.output_vat::numeric(20,4)::text,
  j.vat_setting,
  j.lines,
  j.unknown_lines,
  j.unknown_amount::numeric(20,4)::text,
  j.review_lines,
  j.review_amount::numeric(20,4)::text,
  j.conditional_lines,
  j.row_error_count,
  j.reasons,
  j.accounts,
  j.units_sold::numeric(20,4)::text,
  j.cogs::numeric(20,4)::text,
  j.units_no_product::numeric(20,4)::text,
  j.units_no_cost::numeric(20,4)::text,
  j.sales_uncosted::numeric(20,4)::text,
  case
    when j.contribution_incomplete or j.units_no_product > 0 or j.units_no_cost > 0 then null
    else (j.pnl_known + j.cogs)::numeric(20,4)::text
  end,
  case
    when j.contribution_incomplete or j.units_no_product > 0 or j.units_no_cost > 0 then 'INCOMPLETE'
    else 'FINAL'
  end,
  (j.pnl_known + j.cogs)::numeric(20,4)::text,
  j.reasons || array_remove(array[
    case when j.units_no_product > 0 then 'SKU_NOT_MAPPED' end,
    case when j.units_no_cost > 0 then 'COST_MISSING' end
  ], null),
  -- 0052
  j.orders,
  case when j.orders > 0 then (j.net_sales / j.orders)::numeric(20,4)::text end,
  case
    when j.contribution_incomplete or j.units_no_product > 0 or j.units_no_cost > 0 or j.orders = 0 then null
    else ((j.pnl_known + j.cogs) / j.orders)::numeric(20,4)::text
  end,
  public.dashboard_pct(
    case when j.contribution_incomplete or j.units_no_product > 0 or j.units_no_cost > 0 then null
         else (j.pnl_known + j.cogs) end,
    j.net_sales
  )
from judged j
order by j.currency, j.label;
$$;

-- Same grant as before: authenticated only, never anon.
revoke all on function public.pnl_summary(timestamptz, timestamptz, uuid, uuid, boolean) from anon, public;
grant execute on function public.pnl_summary(timestamptz, timestamptz, uuid, uuid, boolean) to authenticated;

comment on function public.pnl_summary(timestamptz, timestamptz, uuid, uuid, boolean) is
  'Figures per marketplace account (or per currency when combined) for [p_from, p_to). '
  'contribution and gross_profit are NULL unless FINAL; the *_before_open_items figures are informational only. '
  'Gross Profit = Contribution - COGS (B16). orders/average_order_value/profit_per_order/gross_margin_pct added 0052.';

do $$
begin
  if exists (
    select 1 from pg_proc p join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'public' and p.proname = 'pnl_summary'
      and (p.prosecdef or has_function_privilege('anon', p.oid, 'EXECUTE'))
  ) then
    raise exception 'SECURITY: pnl_summary must be SECURITY INVOKER and closed to anon.';
  end if;
  raise notice 'Undo 0076 verified: pnl_summary is back to the 0052 body.';
end;
$$;

commit;
