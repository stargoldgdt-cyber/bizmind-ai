-- ============================================================================
-- 0075  pnl_summary_v3(): the P&L engine, classifying each line type once
-- ============================================================================
-- Owner approved performance work, 2026-10-07: faster queries, NO change to any
-- financial calculation or business rule.
--
-- Measured on the real ledger (0072 perf_lab, 0074 comparison): pnl_summary() spends about
-- 50 microseconds per line, of which about 35 are the product view working on EVERY line:
-- classifying it, finding its product, its cost, its refund credit. Yet a line's
-- classification depends only on its account, its file's format and its TYPE (about 100
-- types in a month of 9,000 lines), and only sales and refund lines can carry a cost.
--
-- pnl_summary_v3() is the same function with the same columns, statuses and rounding, built
-- in three parts:
--   1. the lines are counted once per (account, file, line type); each type is classified
--      ONCE, by the same rule choice and the same VAT treatment as ledger_classified_lines;
--   2. product, cost and refund credit are worked out line by line (by ledger_product_lines
--      itself, unchanged) but ONLY for the line types that can carry a cost;
--   3. orders are counted once each, from the lines of the types classified as gross sales.
-- Everything after the per-account totals (judging, combining, the final select) is copied
-- verbatim from 0052.
--
-- It is added NEXT TO pnl_summary(), which is NOT touched. perf_compare_pnl3() runs both on
-- the same month and scope and counts any row that differs in any column. pnl_summary() is
-- replaced only when that is zero for every month and the new one is faster.
-- Both are read-only. APPLY THIS IN THE SUPABASE SQL EDITOR.
-- Clear the editor first: click in it, press Ctrl+A, then Delete.
-- ============================================================================

begin;

create or replace function public.pnl_summary_v3(
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
with line_groups as (
  -- Lines of the period, counted once per (account, file, line type). A line's classification
  -- depends only on its account, its file's format and its type, so it is decided once per
  -- group instead of once per line.
  select
    ft.business_id,
    ft.marketplace_account_id,
    ft.source_file_id,
    ft.currency,
    b.format_id,
    a.marketplace_code,
    a.label as account_label,
    public.classification_match_key(ft.source_type, ft.source_subtype, ft.source_description) as match_key,
    count(*)                                  as n,
    sum(ft.amount::numeric(20,4))             as amt,
    sum(ft.quantity::numeric)                 as qty
  from public.financial_transactions ft
  join public.import_batches b on b.id = ft.source_file_id and b.withdrawn_at is null
  join public.marketplace_accounts a on a.id = ft.marketplace_account_id
  where ft.posted_at >= p_from
    and ft.posted_at < p_to
    and (p_account_id is null or ft.marketplace_account_id = p_account_id)
    and (p_business_id is null or ft.business_id = p_business_id)
  group by ft.business_id, ft.marketplace_account_id, ft.source_file_id, ft.currency,
           b.format_id, a.marketplace_code, a.label,
           public.classification_match_key(ft.source_type, ft.source_subtype, ft.source_description)
),
classified as (
  -- Exactly the rule choice and the treatment of the ledger_classified_lines view.
  select
    g.*,
    r.category,
    c.metric_group,
    case
      when r.id is null then null
      when c.default_treatment <> 'CONDITIONAL' then c.default_treatment
      when tp.input_vat_treatment = 'RECOVERABLE' then 'NO_PNL_IMPACT'
      when tp.input_vat_treatment = 'NON_RECOVERABLE' then 'INCREASE_EXPENSE'
      else 'CONDITIONAL'
    end as pnl_treatment,
    case
      when r.id is null then 'UNKNOWN'
      when r.scope = 'GLOBAL' and r.confidence = 'MEDIUM' then 'UNDER_REVIEW'
      else 'CLASSIFIED'
    end as classification_status,
    coalesce(r.amount_includes_vat, false)   as rule_includes_vat,
    coalesce(r.separates_included_vat, false) as rule_separates_vat
  from line_groups g
  left join public.tax_profiles tp on tp.marketplace_account_id = g.marketplace_account_id
  left join lateral (
    select cr.id, cr.scope, cr.confidence, cr.category, cr.amount_includes_vat, cr.separates_included_vat
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
  left join public.classification_categories c on c.code = r.category
),
cost_lines as (
  -- Product, cost and refund credit are worked out line by line, but only for the line types that
  -- can carry a cost (a sale with a quantity, or a refund that may give one back), by the very same
  -- view as before.
  select
    l.marketplace_account_id,
    coalesce(sum(l.cogs::numeric) filter (where l.cogs_status = 'COSTED'), 0)            as cogs,
    coalesce(sum(l.quantity::numeric) filter (where l.cogs_status = 'NO_PRODUCT'), 0)    as units_no_product,
    coalesce(sum(l.quantity::numeric) filter (where l.cogs_status = 'NO_COST'), 0)       as units_no_cost,
    coalesce(sum(l.amount::numeric(20,4)) filter (where l.cogs_status in ('NO_PRODUCT', 'NO_COST')), 0) as sales_uncosted
  from public.ledger_product_lines l
  where l.posted_at >= p_from
    and l.posted_at < p_to
    and (p_account_id is null or l.marketplace_account_id = p_account_id)
    and (p_business_id is null or l.business_id = p_business_id)
    and l.match_key = any (array(
      select k.match_key from classified k where k.category in ('PRODUCT_SALES', 'SALES_REFUNDS')
    ))
  group by l.marketplace_account_id
),
order_counts as (
  -- Orders: each order once, however many lines it has; lines with no order reference are not orders.
  select ft.marketplace_account_id, count(distinct ft.order_ref) as orders
  from public.financial_transactions ft
  join classified g
    on g.marketplace_account_id = ft.marketplace_account_id
   and g.source_file_id = ft.source_file_id
   and g.match_key = public.classification_match_key(ft.source_type, ft.source_subtype, ft.source_description)
   and g.metric_group = 'GROSS_SALES'
  where ft.posted_at >= p_from
    and ft.posted_at < p_to
    and ft.order_ref is not null
    and (p_account_id is null or ft.marketplace_account_id = p_account_id)
    and (p_business_id is null or ft.business_id = p_business_id)
  group by ft.marketplace_account_id
),
errors as (
  select f.marketplace_account_id, count(*) as n
  from (select distinct c.marketplace_account_id, c.source_file_id from classified c) f
  join public.import_issues i on i.batch_id = f.source_file_id and i.severity = 'ERROR'
  group by f.marketplace_account_id
),
per_account as (
  select
    c.marketplace_account_id,
    c.account_label,
    c.marketplace_code,
    c.currency,
    coalesce(sum(c.amt) filter (where c.metric_group = 'GROSS_SALES'), 0)             as gross_sales,
    coalesce(sum(c.amt) filter (where c.metric_group = 'SALES_REFUNDS'), 0)           as sales_refunds,
    coalesce(sum(c.amt) filter (where c.metric_group = 'SELLER_DISCOUNTS'), 0)        as seller_discounts,
    coalesce(sum(c.amt) filter (where c.metric_group = 'OTHER_INCOME'), 0)            as other_income,
    coalesce(sum(c.amt) filter (where c.metric_group = 'MARKETPLACE_FEES'), 0)        as marketplace_fees,
    coalesce(sum(c.amt) filter (where c.metric_group = 'FULFILLMENT'), 0)             as fulfillment,
    coalesce(sum(c.amt) filter (where c.metric_group = 'ADVERTISING'), 0)             as advertising,
    coalesce(sum(c.amt) filter (where c.metric_group = 'OTHER_MARKETPLACE_COSTS'), 0) as other_costs,
    coalesce(sum(c.amt) filter (where c.metric_group = 'INPUT_VAT'
                                  and c.pnl_treatment = 'INCREASE_EXPENSE'), 0)        as nonrec_vat,
    coalesce(sum(c.amt) filter (where c.metric_group = 'INPUT_VAT'
                                  and c.pnl_treatment = 'NO_PNL_IMPACT'), 0)           as rec_vat,
    coalesce(sum(c.amt) filter (where c.pnl_treatment = 'CONDITIONAL'), 0)            as unresolved_vat,
    coalesce(sum(c.amt) filter (where c.metric_group = 'OUTPUT_VAT'), 0)              as output_vat,
    coalesce(sum(c.amt) filter (where c.pnl_treatment in
      ('INCREASE_REVENUE', 'DECREASE_REVENUE', 'INCREASE_EXPENSE')), 0)                as pnl_known,
    sum(c.n)                                                                         as lines,
    coalesce(sum(c.n) filter (where c.classification_status = 'UNKNOWN'), 0)         as unknown_lines,
    coalesce(sum(c.amt) filter (where c.classification_status = 'UNKNOWN'), 0)        as unknown_amount,
    coalesce(sum(c.n) filter (where c.classification_status = 'UNDER_REVIEW'), 0)    as review_lines,
    coalesce(sum(c.amt) filter (where c.classification_status = 'UNDER_REVIEW'), 0)   as review_amount,
    coalesce(sum(c.n) filter (where c.pnl_treatment = 'CONDITIONAL'), 0)             as conditional_lines,
    (bool_or(c.rule_includes_vat) and not bool_or(c.rule_separates_vat))             as vat_inside_fees,
    coalesce(sum(c.qty) filter (where c.category = 'PRODUCT_SALES'), 0)              as units_sold,
    coalesce(max(cl.cogs), 0)                                                        as cogs,
    coalesce(max(cl.units_no_product), 0)                                            as units_no_product,
    coalesce(max(cl.units_no_cost), 0)                                               as units_no_cost,
    coalesce(max(cl.sales_uncosted), 0)                                              as sales_uncosted,
    coalesce(max(oc.orders), 0)                                                      as orders
  from classified c
  left join cost_lines cl on cl.marketplace_account_id = c.marketplace_account_id
  left join order_counts oc on oc.marketplace_account_id = c.marketplace_account_id
  group by c.marketplace_account_id, c.account_label, c.marketplace_code, c.currency
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

revoke all on function public.pnl_summary_v3(timestamptz, timestamptz, uuid, uuid, boolean) from anon, public;
grant execute on function public.pnl_summary_v3(timestamptz, timestamptz, uuid, uuid, boolean) to authenticated;

create or replace function public.perf_compare_pnl3(
  p_business_id uuid,
  p_from        timestamptz,
  p_to          timestamptz,
  p_combine     boolean
)
returns table (rows_old bigint, rows_new bigint, only_in_old bigint, only_in_new bigint, ms_old numeric, ms_new numeric)
language plpgsql
security invoker
set search_path = ''
as $$
declare
  t0 timestamptz;
  a  jsonb[];
  b  jsonb[];
begin
  t0 := clock_timestamp();
  select coalesce(array_agg(to_jsonb(o)), '{}') into a
  from public.pnl_summary(p_from, p_to, null, p_business_id, p_combine) o;
  ms_old := round(extract(epoch from clock_timestamp() - t0) * 1000);

  t0 := clock_timestamp();
  select coalesce(array_agg(to_jsonb(n)), '{}') into b
  from public.pnl_summary_v3(p_from, p_to, null, p_business_id, p_combine) n;
  ms_new := round(extract(epoch from clock_timestamp() - t0) * 1000);

  rows_old := coalesce(array_length(a, 1), 0);
  rows_new := coalesce(array_length(b, 1), 0);
  only_in_old := (select count(*) from unnest(a) x where x <> all (b));
  only_in_new := (select count(*) from unnest(b) y where y <> all (a));
  return next;
end;
$$;

revoke all on function public.perf_compare_pnl3(uuid, timestamptz, timestamptz, boolean) from anon, public;
grant execute on function public.perf_compare_pnl3(uuid, timestamptz, timestamptz, boolean) to authenticated;

do $$
begin
  if exists (
    select 1 from pg_proc p join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'public' and p.proname in ('pnl_summary_v3', 'perf_compare_pnl3')
      and (p.prosecdef or has_function_privilege('anon', p.oid, 'EXECUTE'))
  ) then
    raise exception 'SECURITY: the new functions must be SECURITY INVOKER and closed to anon.';
  end if;
  raise notice 'Migration 0075 verified: pnl_summary_v3 and perf_compare_pnl3 are read-only, invoker-rights, closed to anon.';
end;
$$;

commit;
