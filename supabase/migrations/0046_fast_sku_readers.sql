-- ============================================================================
-- 0046  Faster SKU readers, and a dashboard that stays under the time limit
-- ============================================================================
-- Found on the owner's real data after the first noon uploads (about 33,000
-- ledger lines): the dashboard failed with "canceling statement due to
-- statement timeout". dashboard_overview() built the business's whole SKU
-- queue (sku_mapping_queue, 7.7 s) only to count it.
--
-- WHAT CHANGES (same signatures and result shapes; nothing is stored)
--   1. dashboard_overview(): unmatched_skus counts the SKUs SOLD in the scope
--      and month shown that have no product -- what that month's gross profit
--      waits for -- straight from the classified lines. Otherwise 0043's.
--   2. sku_mapping_queue(): finds the unmatched lines first, on the classified
--      lines, instead of looking up a product and cost for every line.
--      Otherwise 0035's.
--   3. sku_setup_rows(): the same, joining the product once per SKU.
--      Otherwise 0045's.
--   4. sku_setup_summary(business): the counts for Products and costs, so a
--      business with more than 1,000 SKUs is counted whole.
--
-- Nothing in the ledger, classification, VAT or P&L changes.
-- APPLY THIS IN THE SUPABASE SQL EDITOR.
-- Clear the editor first: click in it, press Ctrl+A, then Delete.
-- ============================================================================

begin;

-- 1. dashboard_overview ------------------------------------------------------

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
begin
  -- Months are calendar months; "the month before" is the same length back.
  if date_trunc('month', p_from at time zone 'UTC') = (p_from at time zone 'UTC')
     and (p_to at time zone 'UTC') = (date_trunc('month', p_from at time zone 'UTC') + interval '1 month') then
    v_prev_from := ((date_trunc('month', p_from at time zone 'UTC') - interval '1 month') at time zone 'UTC');
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
  select n.* into v_net from public.pnl_net_profit(p_from, p_to, p_business_id) n where n.currency = p_currency;
  select n.* into v_prev_net from public.pnl_net_profit(v_prev_from, p_from, p_business_id) n where n.currency = p_currency;

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


-- 2. sku_mapping_queue -------------------------------------------------------

create or replace function public.sku_mapping_queue(p_business_id uuid)
returns table (
  marketplace_code text,
  raw_sku          text,
  accounts         text,
  currencies       text,
  lines            bigint,
  units_sold       text,
  net_sales        text,
  first_seen       timestamptz,
  last_seen        timestamptz,
  sample_title     text,
  suggestions      jsonb
)
language sql
stable
security invoker
set search_path = ''
as $$
with unmapped as (
  select
    l.marketplace_code,
    l.raw_sku,
    string_agg(distinct l.account_label, ', ')                                   as accounts,
    string_agg(distinct l.currency::text, ', ')                                  as currencies,
    count(*)                                                                     as lines,
    coalesce(sum(l.quantity::numeric) filter (
      where l.category = 'PRODUCT_SALES' and l.quantity is not null), 0)         as units,
    coalesce(sum(l.amount::numeric) filter (where l.metric_group in
      ('GROSS_SALES', 'SALES_REFUNDS', 'SELLER_DISCOUNTS')), 0)                  as net_sales,
    min(l.posted_at)                                                             as first_seen,
    max(l.posted_at)                                                             as last_seen,
    (array_agg(l.source_row_id order by l.posted_at, l.line_index))[1]           as sample_row
  -- 0046: unmatched lines are found first, on the plain classified lines, so
  -- no product or cost is looked up for the lines that do not need one.
  from public.ledger_classified_lines l
  where l.business_id = p_business_id
    and l.raw_sku is not null
    and not exists (
      select 1 from public.sku_aliases s
      where s.business_id = l.business_id and s.marketplace_code = l.marketplace_code
        and s.raw_sku = l.raw_sku and s.status = 'CONFIRMED'
    )
  group by l.marketplace_code, l.raw_sku
)
select
  u.marketplace_code,
  u.raw_sku,
  u.accounts,
  u.currencies,
  u.lines,
  u.units::numeric(20,4)::text,
  u.net_sales::numeric(20,4)::text,
  u.first_seen,
  u.last_seen,
  (select nullif(trim(sr.raw ->> 'Title'), '') from public.source_rows sr where sr.id = u.sample_row),
  coalesce((
    select jsonb_agg(distinct jsonb_build_object('product_id', c.id, 'name', c.name, 'reason', c.reason))
    from (
      select p.id, p.name, 'SAME_SKU_CODE' as reason
      from public.catalog_products p
      where p.business_id = p_business_id
        and p.status = 'ACTIVE'
        and p.sku_code is not null
        and public.sku_normalize(p.sku_code) = public.sku_normalize(u.raw_sku)
      union
      select p.id, p.name, 'MAPPED_ON_OTHER_MARKETPLACE'
      from public.sku_aliases a
      join public.catalog_products p on p.id = a.product_id
      where a.business_id = p_business_id
        and a.status = 'CONFIRMED'
        and a.marketplace_code <> u.marketplace_code
        and p.status = 'ACTIVE'
        and public.sku_normalize(a.raw_sku) = public.sku_normalize(u.raw_sku)
    ) c
    where not exists (
      select 1 from public.sku_aliases r
      where r.business_id = p_business_id
        and r.marketplace_code = u.marketplace_code
        and r.raw_sku = u.raw_sku
        and r.product_id = c.id
        and r.status = 'REJECTED'
    )
  ), '[]'::jsonb)
from unmapped u
order by u.net_sales desc, u.raw_sku;
$$;


-- 3. sku_setup_rows ----------------------------------------------------------

create or replace function public.sku_setup_rows(p_business_id uuid, p_include_matched boolean default false)
returns table (
  marketplace_code  text,
  account_label     text,
  currency          text,
  raw_sku           text,
  title             text,
  product_id        uuid,
  product_sku       text,
  product_name      text,
  method            text,
  unit_cost         text,
  units_sold        text,
  net_sales         text,
  first_sold        date
)
language sql
stable
security invoker
set search_path = ''
as $$
with lines as (
  select
    l.marketplace_code, l.account_label, l.currency::text as currency, l.raw_sku,
    coalesce(sum(l.quantity::numeric) filter (
      where l.category = 'PRODUCT_SALES' and l.quantity is not null), 0)         as units,
    coalesce(sum(l.amount::numeric) filter (where l.metric_group in
      ('GROSS_SALES', 'SALES_REFUNDS', 'SELLER_DISCOUNTS')), 0)                  as net_sales,
    min((l.posted_at at time zone 'UTC')::date) filter (
      where l.category = 'PRODUCT_SALES' and l.quantity is not null)             as first_sold,
    (array_agg(l.source_row_id order by l.posted_at, l.line_index))[1]           as sample_row
  -- 0046: plain classified lines; the product and cost are joined once per SKU below.
  from public.ledger_classified_lines l
  where l.business_id = p_business_id
    and l.raw_sku is not null
    and (p_include_matched or not exists (
      select 1 from public.sku_aliases s0
      where s0.business_id = l.business_id and s0.marketplace_code = l.marketplace_code
        and s0.raw_sku = l.raw_sku and s0.status = 'CONFIRMED'
    ))
  group by l.marketplace_code, l.account_label, l.currency, l.raw_sku
)
select
  x.marketplace_code,
  x.account_label,
  x.currency,
  x.raw_sku,
  (select nullif(trim(sr.raw ->> 'Title'), '') from public.source_rows sr where sr.id = x.sample_row),
  s.product_id,
  p.sku_code,
  p.name,
  s.method,
  (select pc.unit_cost::text
   from public.product_costs pc
   where pc.product_id = s.product_id and pc.currency = x.currency and pc.retired_at is null
     and pc.effective_from <= (now() at time zone 'UTC')::date
   order by pc.effective_from desc, pc.created_at desc
   limit 1),
  x.units::numeric(20,4)::text,
  x.net_sales::numeric(20,4)::text,
  x.first_sold
from lines x
left join public.sku_aliases s
  on s.business_id = p_business_id and s.marketplace_code = x.marketplace_code
 and s.raw_sku = x.raw_sku and s.status = 'CONFIRMED'
left join public.catalog_products p on p.id = s.product_id
where p_include_matched or s.id is null
order by (s.id is not null), x.net_sales desc, x.marketplace_code, x.account_label, x.raw_sku;
$$;


-- 4. sku_setup_summary -------------------------------------------------------

create function public.sku_setup_summary(p_business_id uuid)
returns table (
  skus                  bigint,
  recognised            bigint,
  matched_automatically bigint,
  need_attention        bigint
)
language sql
stable
security invoker
set search_path = ''
as $$
  with skus as (
    select distinct a.marketplace_code, ft.raw_sku
    from public.financial_transactions ft
    join public.import_batches b on b.id = ft.source_file_id and b.withdrawn_at is null
    join public.marketplace_accounts a on a.id = ft.marketplace_account_id
    where ft.business_id = p_business_id and ft.raw_sku is not null
  )
  select
    count(*),
    count(s.id),
    count(s.id) filter (where s.method = 'AUTOMATIC'),
    count(*) - count(s.id)
  from skus k
  left join public.sku_aliases s
    on s.business_id = p_business_id and s.marketplace_code = k.marketplace_code
   and s.raw_sku = k.raw_sku and s.status = 'CONFIRMED';
$$;

revoke all on function public.sku_setup_summary(uuid) from anon, public;
grant execute on function public.sku_setup_summary(uuid) to authenticated;

do $$
begin
  if exists (
    select 1 from pg_proc p join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'public'
      and p.proname in ('dashboard_overview', 'sku_mapping_queue', 'sku_setup_rows', 'sku_setup_summary')
      and (p.prosecdef or has_function_privilege('anon', p.oid, 'EXECUTE'))
  ) then
    raise exception 'SECURITY: the readers must be SECURITY INVOKER and closed to anon.';
  end if;
  raise notice 'Migration 0046 verified: faster SKU readers and dashboard.';
end;
$$;

commit;
