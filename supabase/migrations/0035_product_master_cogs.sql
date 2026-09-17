-- ============================================================================
-- 0035  Product master, SKU mapping, dated COGS and Gross Profit
-- ============================================================================
-- GCC Phase 6.
--
-- WHAT CHANGES
--   1. catalog_products   the business's own products (name, own SKU code,
--                         category, brand), archived rather than deleted.
--   2. sku_aliases        a marketplace SKU -> product, CONFIRMED or REJECTED by
--                         an owner or admin. Never an automatic merge (A10);
--                         suggestions are computed, never applied.
--   3. product_costs      unit cost per product per currency from a date
--                         (A8). Never edited: a wrong entry is withdrawn and a
--                         new one added. A back-dated entry is the explicit,
--                         audited backfill of decision B7.
--   4. ledger_classified_lines gains quantity, quantity_basis, attribution;
--      ledger_product_lines adds the product, the unit cost in force on the
--      sale date, and the line's COGS.
--   5. pnl_summary() gains COGS and Gross Profit (decision B16: Gross Profit =
--      Contribution - COGS). Gross Profit is NULL unless final; unmapped SKUs
--      and missing costs are named with their units and sales.
--   6. pnl_by_product(), sku_mapping_queue(), catalog_product_overview().
--   7. Owner/admin writers for products, mappings and costs (B11), audited.
--
-- COGS covers units sold (Product sales lines with a quantity). A refunded
-- unit's cost is not added back in V1 (the returned stock's condition is not
-- known): decision B17, default.
--
-- Ledger rows are not touched. Depends on 0030-0034.
-- APPLY THIS IN THE SUPABASE SQL EDITOR.
-- Clear the editor first: click in it, press Ctrl+A, then Delete.
-- ============================================================================

begin;


-- ----------------------------------------------------------------------------
-- 1. Products
-- ----------------------------------------------------------------------------

create function public.sku_normalize(p_value text)
returns text
language sql
immutable
parallel safe
set search_path = ''
as $$
  select upper(regexp_replace(coalesce(p_value, ''), '[^A-Za-z0-9]', '', 'g'));
$$;

create table public.catalog_products (
  id          uuid primary key default gen_random_uuid(),
  business_id uuid not null references public.businesses (id) on delete cascade,
  name        text not null check (length(trim(name)) between 1 and 200 and not public.ledger_text_has_email(name)),
  sku_code    text check (sku_code is null or (length(trim(sku_code)) between 1 and 120 and not public.ledger_text_has_email(sku_code))),
  category    text check (category is null or (length(trim(category)) between 1 and 80 and not public.ledger_text_has_email(category))),
  brand       text check (brand is null or (length(trim(brand)) between 1 and 80 and not public.ledger_text_has_email(brand))),
  status      text not null default 'ACTIVE' check (status in ('ACTIVE', 'ARCHIVED')),
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now(),
  constraint catalog_products_business_id_id_key unique (business_id, id)
);

comment on table public.catalog_products is
  'The business''s own products. Marketplace SKUs point here through confirmed '
  'sku_aliases; costs are dated in product_costs. Archived, never deleted.';

create unique index catalog_products_sku_code_key
  on public.catalog_products (business_id, public.sku_normalize(sku_code))
  where sku_code is not null;

create index catalog_products_business_idx on public.catalog_products (business_id, status, name);

create trigger catalog_products_set_updated_at
  before update on public.catalog_products
  for each row execute function public.set_updated_at();


-- ----------------------------------------------------------------------------
-- 2. SKU mappings (decisions only; suggestions are computed)
-- ----------------------------------------------------------------------------

create table public.sku_aliases (
  id               uuid primary key default gen_random_uuid(),
  business_id      uuid not null references public.businesses (id) on delete cascade,
  marketplace_code text not null references public.marketplaces (code),
  raw_sku          text not null check (length(raw_sku) between 1 and 200 and not public.ledger_text_has_email(raw_sku)),
  product_id       uuid not null,
  status           text not null check (status in ('CONFIRMED', 'REJECTED')),
  note             text check (note is null or (length(note) <= 300 and not public.ledger_text_has_email(note))),
  decided_by       uuid,
  decided_at       timestamptz not null default now(),
  constraint sku_aliases_product_fkey
    foreign key (business_id, product_id)
    references public.catalog_products (business_id, id) on delete cascade
);

comment on table public.sku_aliases is
  'A person''s decision that a marketplace SKU is (CONFIRMED) or is not '
  '(REJECTED) a product. At most one CONFIRMED product per SKU per marketplace. '
  'Applied when figures are calculated, so a change reaches every period.';

create unique index sku_aliases_decision_key
  on public.sku_aliases (business_id, marketplace_code, raw_sku, product_id);

create unique index sku_aliases_one_confirmed
  on public.sku_aliases (business_id, marketplace_code, raw_sku)
  where status = 'CONFIRMED';

create index sku_aliases_product_idx on public.sku_aliases (product_id) where status = 'CONFIRMED';


-- ----------------------------------------------------------------------------
-- 3. Dated product costs
-- ----------------------------------------------------------------------------

create table public.product_costs (
  id             uuid primary key default gen_random_uuid(),
  business_id    uuid not null references public.businesses (id) on delete cascade,
  product_id     uuid not null,
  currency       char(3) not null check (currency ~ '^[A-Z]{3}$'),
  unit_cost      numeric(20,4) not null check (unit_cost >= 0),
  effective_from date not null,
  note           text check (note is null or (length(note) <= 300 and not public.ledger_text_has_email(note))),
  created_by     uuid,
  created_at     timestamptz not null default now(),
  retired_at     timestamptz,
  retired_by     uuid,
  retire_reason  text check (retire_reason is null or (length(retire_reason) <= 300 and not public.ledger_text_has_email(retire_reason))),
  constraint product_costs_retired_check check ((retired_at is null) = (retired_by is null)),
  constraint product_costs_product_fkey
    foreign key (business_id, product_id)
    references public.catalog_products (business_id, id) on delete cascade
);

comment on table public.product_costs is
  'Unit cost of a product in one currency from a date (A8). The cost in force '
  'on a sale''s date values that sale. Never edited; a mistaken entry is '
  'withdrawn. A back-dated entry is the audited backfill of decision B7.';

create index product_costs_lookup_idx
  on public.product_costs (product_id, currency, effective_from desc, created_at desc)
  where retired_at is null;

create function public.product_cost_guard()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if tg_op = 'UPDATE' then
    if old.retired_at is null
       and new.retired_at is not null
       and (to_jsonb(new) - 'retired_at' - 'retired_by' - 'retire_reason')
         = (to_jsonb(old) - 'retired_at' - 'retired_by' - 'retire_reason') then
      return new;
    end if;
    raise exception 'A product cost cannot be edited. Add a new dated cost, or withdraw this one.'
      using errcode = '42501';
  end if;

  -- Deleted only with its business or its product.
  if not exists (select 1 from public.businesses b where b.id = old.business_id)
     or not exists (select 1 from public.catalog_products p where p.id = old.product_id) then
    return old;
  end if;

  raise exception 'A product cost cannot be deleted. Withdraw it instead.' using errcode = '42501';
end;
$$;

create trigger product_costs_guard
  before update or delete on public.product_costs
  for each row execute function public.product_cost_guard();


-- ----------------------------------------------------------------------------
-- 4. Lines with quantity, and lines with their product and cost
-- ----------------------------------------------------------------------------
-- Columns are only appended, so CREATE OR REPLACE keeps every dependant.

create or replace view public.ledger_classified_lines
with (security_invoker = true)
as
select
  ft.id,
  ft.business_id,
  ft.marketplace_account_id,
  a.marketplace_code,
  a.label                                        as account_label,
  ft.source_file_id,
  b.format_id,
  ft.source_row_id,
  ft.line_index,
  public.classification_match_key(ft.source_type, ft.source_subtype, ft.source_description) as match_key,
  ft.source_type,
  ft.source_subtype,
  ft.source_description,
  ft.amount::text                                as amount,
  ft.currency,
  ft.posted_at,
  ft.order_ref,
  ft.raw_sku,
  ft.side                                        as import_side,
  ft.category                                    as import_category,
  r.id                                           as rule_id,
  r.scope                                        as rule_scope,
  r.confidence                                   as rule_confidence,
  r.version                                      as rule_version,
  c.financial_type,
  r.category,
  c.label                                        as category_label,
  r.subcategory,
  c.metric_group,
  c.default_treatment,
  case
    when r.id is null then null
    when c.default_treatment <> 'CONDITIONAL' then c.default_treatment
    when tp.input_vat_treatment = 'RECOVERABLE' then 'NO_PNL_IMPACT'
    when tp.input_vat_treatment = 'NON_RECOVERABLE' then 'INCREASE_EXPENSE'
    else 'CONDITIONAL'
  end                                            as pnl_treatment,
  case
    when r.id is null then 'UNKNOWN'
    when r.scope = 'GLOBAL' and r.confidence = 'MEDIUM' then 'UNDER_REVIEW'
    else 'CLASSIFIED'
  end                                            as classification_status,
  coalesce(r.amount_includes_vat, false)         as rule_includes_vat,
  coalesce(r.separates_included_vat, false)      as rule_separates_vat,
  ft.quantity::text                              as quantity,
  ft.quantity_basis,
  ft.attribution
from public.financial_transactions ft
join public.import_batches b on b.id = ft.source_file_id and b.withdrawn_at is null
join public.marketplace_accounts a on a.id = ft.marketplace_account_id
left join public.tax_profiles tp on tp.marketplace_account_id = ft.marketplace_account_id
left join lateral (
  select cr.id, cr.scope, cr.confidence, cr.version, cr.category, cr.subcategory,
         cr.amount_includes_vat, cr.separates_included_vat
  from public.classification_rules cr
  where cr.status = 'ACTIVE'
    and cr.marketplace_code = a.marketplace_code
    and cr.format_id = b.format_id
    and cr.match_key = public.classification_match_key(ft.source_type, ft.source_subtype, ft.source_description)
    and (cr.business_id is null or cr.business_id = ft.business_id)
  order by case
             when cr.business_id is null and cr.confidence = 'HIGH' then 1
             when cr.business_id is not null then 2
             else 3
           end
  limit 1
) r on true
left join public.classification_categories c on c.code = r.category;

create view public.ledger_product_lines
with (security_invoker = true)
as
select
  l.*,
  al.product_id,
  p.name                                                      as product_name,
  p.category                                                  as product_category,
  (l.category = 'PRODUCT_SALES' and l.quantity is not null)   as is_cost_line,
  case
    when not (l.category = 'PRODUCT_SALES' and l.quantity is not null) then 'NOT_APPLICABLE'
    when al.product_id is null then 'NO_PRODUCT'
    when pc.unit_cost is null then 'NO_COST'
    else 'COSTED'
  end                                                         as cogs_status,
  pc.unit_cost::text                                          as unit_cost,
  case
    when l.category = 'PRODUCT_SALES' and l.quantity is not null and pc.unit_cost is not null
      then (-(l.quantity::numeric(20,4) * pc.unit_cost))::numeric(20,4)::text
  end                                                         as cogs
from public.ledger_classified_lines l
left join public.sku_aliases al
  on al.business_id = l.business_id
 and al.marketplace_code = l.marketplace_code
 and al.raw_sku = l.raw_sku
 and al.status = 'CONFIRMED'
left join public.catalog_products p on p.id = al.product_id
left join lateral (
  select pcost.unit_cost
  from public.product_costs pcost
  where pcost.product_id = al.product_id
    and pcost.currency = l.currency
    and pcost.retired_at is null
    and pcost.effective_from <= (l.posted_at at time zone 'UTC')::date
  order by pcost.effective_from desc, pcost.created_at desc
  limit 1
) pc on true;

comment on view public.ledger_product_lines is
  'Classified lines with their product (confirmed SKU mapping), the unit cost '
  'in force on the sale date, and the line''s COGS. Money as exact text.';


-- ----------------------------------------------------------------------------
-- 5. pnl_summary() with COGS and Gross Profit (B16)
-- ----------------------------------------------------------------------------

drop function public.pnl_summary(timestamptz, timestamptz, uuid, uuid, boolean);

create function public.pnl_summary(
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
  gross_profit_reasons            text[]
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
    coalesce(sum(s.amt) filter (where s.cogs_status in ('NO_PRODUCT', 'NO_COST')), 0) as sales_uncosted
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
    sum(j.sales_uncosted) as sales_uncosted
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
    ], null)                                                             as reasons
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
  (j.gross_sales + j.sales_refunds + j.seller_discounts)::numeric(20,4)::text,
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
  ], null)
from judged j
order by j.currency, j.label;
$$;

comment on function public.pnl_summary(timestamptz, timestamptz, uuid, uuid, boolean) is
  'Figures per marketplace account (or per currency when combined) for [p_from, p_to). '
  'contribution and gross_profit are NULL unless FINAL; the *_before_open_items figures are informational only. '
  'Gross Profit = Contribution - COGS (B16).';


-- ----------------------------------------------------------------------------
-- 6. Product profit, the mapping queue, the product overview
-- ----------------------------------------------------------------------------
-- Product figures use only lines attributed to an order line that carries a
-- SKU. Marketplace-level fees and advertising are never spread across products
-- (A7): they form the NOT_ALLOCATED row, so every row together adds up to the
-- account's contribution.

create function public.pnl_by_product(
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
with scoped as (
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
),
grouped as (
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
  from scoped s
  group by s.currency, s.kind,
           case when s.kind = 'PRODUCT' then s.product_id end,
           case when s.kind = 'UNMAPPED_SKU' then s.raw_sku end,
           case when s.kind = 'UNMAPPED_SKU' then s.marketplace_code end
)
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
from grouped g
order by g.currency,
         case g.kind when 'PRODUCT' then 1 when 'UNMAPPED_SKU' then 2 else 3 end,
         g.net_sales desc;
$$;

create function public.sku_mapping_queue(p_business_id uuid)
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
    coalesce(sum(l.quantity::numeric) filter (where l.is_cost_line), 0)          as units,
    coalesce(sum(l.amount::numeric) filter (where l.metric_group in
      ('GROSS_SALES', 'SALES_REFUNDS', 'SELLER_DISCOUNTS')), 0)                  as net_sales,
    min(l.posted_at)                                                             as first_seen,
    max(l.posted_at)                                                             as last_seen,
    (array_agg(l.source_row_id order by l.posted_at, l.line_index))[1]           as sample_row
  from public.ledger_product_lines l
  where l.business_id = p_business_id
    and l.raw_sku is not null
    and l.product_id is null
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

create function public.catalog_product_overview(p_business_id uuid)
returns table (
  product_id     uuid,
  name           text,
  sku_code       text,
  category       text,
  brand          text,
  status         text,
  mapped_skus    bigint,
  current_costs  jsonb,
  created_at     timestamptz
)
language sql
stable
security invoker
set search_path = ''
as $$
  select
    p.id,
    p.name,
    p.sku_code,
    p.category,
    p.brand,
    p.status,
    (select count(*) from public.sku_aliases a where a.product_id = p.id and a.status = 'CONFIRMED'),
    coalesce((
      select jsonb_agg(jsonb_build_object(
               'currency', c.currency, 'unit_cost', c.unit_cost::text, 'effective_from', c.effective_from)
             order by c.currency)
      from (
        select distinct on (pc.currency) pc.currency, pc.unit_cost, pc.effective_from
        from public.product_costs pc
        where pc.product_id = p.id
          and pc.retired_at is null
          and pc.effective_from <= (now() at time zone 'UTC')::date
        order by pc.currency, pc.effective_from desc, pc.created_at desc
      ) c
    ), '[]'::jsonb),
    p.created_at
  from public.catalog_products p
  where p.business_id = p_business_id
  order by p.status, p.name;
$$;


-- ----------------------------------------------------------------------------
-- 7. Writers (OWNER or ADMIN, decision B11), audited
-- ----------------------------------------------------------------------------

create function public.catalog_product_create(
  p_business_id uuid,
  p_name        text,
  p_sku_code    text default null,
  p_category    text default null,
  p_brand       text default null
)
returns uuid
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_id uuid;
begin
  if (select auth.uid()) is null then
    raise exception 'Not authenticated.' using errcode = '28000';
  end if;
  if p_business_id is null or p_business_id not in (select public.current_user_business_ids()) then
    raise exception 'That business could not be found.' using errcode = 'P0002';
  end if;
  if not public.current_user_has_role(p_business_id, array['OWNER', 'ADMIN']::public.business_role[]) then
    raise exception 'Only an owner or admin can manage products.' using errcode = '42501';
  end if;

  begin
    insert into public.catalog_products (business_id, name, sku_code, category, brand)
    values (
      p_business_id, trim(coalesce(p_name, '')), nullif(trim(coalesce(p_sku_code, '')), ''),
      nullif(trim(coalesce(p_category, '')), ''), nullif(trim(coalesce(p_brand, '')), '')
    )
    returning id into v_id;
  exception
    when unique_violation then
      raise exception 'Another product already uses that SKU code.' using errcode = '23505';
    when check_violation then
      raise exception 'Check the name, SKU code, category and brand (the name is required).' using errcode = '23514';
  end;

  perform public.write_audit_log(
    p_business_id, 'catalog_product.created', 'catalog_products', v_id, null,
    (select jsonb_build_object('name', p.name, 'sku_code', p.sku_code, 'category', p.category, 'brand', p.brand)
     from public.catalog_products p where p.id = v_id)
  );
  return v_id;
end;
$$;

create function public.catalog_product_update(
  p_product_id uuid,
  p_name       text default null,
  p_sku_code   text default null,
  p_category   text default null,
  p_brand      text default null,
  p_status     text default null
)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_before public.catalog_products;
  v_after  public.catalog_products;
begin
  if (select auth.uid()) is null then
    raise exception 'Not authenticated.' using errcode = '28000';
  end if;
  select * into v_before from public.catalog_products p where p.id = p_product_id;
  if v_before.id is null or v_before.business_id not in (select public.current_user_business_ids()) then
    raise exception 'That product could not be found.' using errcode = 'P0002';
  end if;
  if not public.current_user_has_role(v_before.business_id, array['OWNER', 'ADMIN']::public.business_role[]) then
    raise exception 'Only an owner or admin can manage products.' using errcode = '42501';
  end if;
  if p_status is not null and p_status not in ('ACTIVE', 'ARCHIVED') then
    raise exception 'A product is either active or archived.' using errcode = '22023';
  end if;

  -- NULL leaves a field as it is; an empty string clears an optional field.
  begin
    update public.catalog_products p
    set name     = coalesce(nullif(trim(coalesce(p_name, '')), ''), p.name),
        sku_code = case when p_sku_code is null then p.sku_code else nullif(trim(p_sku_code), '') end,
        category = case when p_category is null then p.category else nullif(trim(p_category), '') end,
        brand    = case when p_brand is null then p.brand else nullif(trim(p_brand), '') end,
        status   = coalesce(p_status, p.status)
    where p.id = p_product_id
    returning * into v_after;
  exception
    when unique_violation then
      raise exception 'Another product already uses that SKU code.' using errcode = '23505';
    when check_violation then
      raise exception 'Check the name, SKU code, category and brand.' using errcode = '23514';
  end;

  perform public.write_audit_log(
    v_before.business_id, 'catalog_product.updated', 'catalog_products', p_product_id,
    jsonb_build_object('name', v_before.name, 'sku_code', v_before.sku_code, 'category', v_before.category,
                       'brand', v_before.brand, 'status', v_before.status),
    jsonb_build_object('name', v_after.name, 'sku_code', v_after.sku_code, 'category', v_after.category,
                       'brand', v_after.brand, 'status', v_after.status)
  );
end;
$$;

create function public.sku_alias_decide(
  p_business_id      uuid,
  p_marketplace_code text,
  p_raw_sku          text,
  p_product_id       uuid,
  p_decision         text,
  p_note             text default null
)
returns uuid
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_id       uuid;
  v_previous text;
  v_replaced uuid;
begin
  if (select auth.uid()) is null then
    raise exception 'Not authenticated.' using errcode = '28000';
  end if;
  if p_business_id is null or p_business_id not in (select public.current_user_business_ids()) then
    raise exception 'That business could not be found.' using errcode = 'P0002';
  end if;
  if not public.current_user_has_role(p_business_id, array['OWNER', 'ADMIN']::public.business_role[]) then
    raise exception 'Only an owner or admin can confirm SKU mappings.' using errcode = '42501';
  end if;
  if p_decision is null or p_decision not in ('CONFIRMED', 'REJECTED') then
    raise exception 'Confirm or reject the mapping.' using errcode = '22023';
  end if;
  if not exists (
    select 1 from public.catalog_products p
    where p.id = p_product_id and p.business_id = p_business_id and p.status = 'ACTIVE'
  ) then
    raise exception 'That product could not be found, or it is archived.' using errcode = 'P0002';
  end if;
  if not exists (
    select 1
    from public.financial_transactions ft
    join public.marketplace_accounts a on a.id = ft.marketplace_account_id
    where ft.business_id = p_business_id
      and a.marketplace_code = p_marketplace_code
      and ft.raw_sku = p_raw_sku
  ) then
    raise exception 'That SKU does not appear in this business''s marketplace files.' using errcode = 'P0002';
  end if;

  select a.status into v_previous
  from public.sku_aliases a
  where a.business_id = p_business_id and a.marketplace_code = p_marketplace_code
    and a.raw_sku = p_raw_sku and a.product_id = p_product_id;

  if p_decision = 'CONFIRMED' then
    -- A SKU is one product: confirming a new one replaces the old mapping.
    update public.sku_aliases a
    set status = 'REJECTED', decided_by = (select auth.uid()), decided_at = now(),
        note = 'Replaced by a new mapping'
    where a.business_id = p_business_id and a.marketplace_code = p_marketplace_code
      and a.raw_sku = p_raw_sku and a.status = 'CONFIRMED' and a.product_id <> p_product_id
    returning a.product_id into v_replaced;
  end if;

  begin
    insert into public.sku_aliases (business_id, marketplace_code, raw_sku, product_id, status, note, decided_by)
    values (p_business_id, p_marketplace_code, p_raw_sku, p_product_id, p_decision,
            nullif(trim(coalesce(p_note, '')), ''), (select auth.uid()))
    on conflict (business_id, marketplace_code, raw_sku, product_id)
    do update set status = excluded.status, note = excluded.note,
                  decided_by = excluded.decided_by, decided_at = now()
    returning id into v_id;
  exception
    when check_violation then
      raise exception 'The note is too long or contains an email address.' using errcode = '23514';
  end;

  perform public.write_audit_log(
    p_business_id, 'sku_alias.decided', 'sku_aliases', v_id,
    case when v_previous is null and v_replaced is null then null
         else jsonb_build_object('status', v_previous, 'replaced_product_id', v_replaced) end,
    jsonb_build_object('marketplace_code', p_marketplace_code, 'raw_sku', p_raw_sku,
                       'product_id', p_product_id, 'status', p_decision)
  );
  return v_id;
end;
$$;

create function public.sku_alias_remove(p_alias_id uuid)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_alias public.sku_aliases;
begin
  if (select auth.uid()) is null then
    raise exception 'Not authenticated.' using errcode = '28000';
  end if;
  select * into v_alias from public.sku_aliases a where a.id = p_alias_id;
  if v_alias.id is null or v_alias.business_id not in (select public.current_user_business_ids()) then
    raise exception 'That mapping could not be found.' using errcode = 'P0002';
  end if;
  if not public.current_user_has_role(v_alias.business_id, array['OWNER', 'ADMIN']::public.business_role[]) then
    raise exception 'Only an owner or admin can change SKU mappings.' using errcode = '42501';
  end if;

  delete from public.sku_aliases a where a.id = p_alias_id;

  perform public.write_audit_log(
    v_alias.business_id, 'sku_alias.removed', 'sku_aliases', v_alias.id,
    jsonb_build_object('marketplace_code', v_alias.marketplace_code, 'raw_sku', v_alias.raw_sku,
                       'product_id', v_alias.product_id, 'status', v_alias.status),
    null
  );
end;
$$;

create function public.product_cost_add(
  p_product_id     uuid,
  p_currency       text,
  p_unit_cost      text,
  p_effective_from date,
  p_note           text default null
)
returns uuid
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_product public.catalog_products;
  v_id      uuid;
begin
  if (select auth.uid()) is null then
    raise exception 'Not authenticated.' using errcode = '28000';
  end if;
  select * into v_product from public.catalog_products p where p.id = p_product_id;
  if v_product.id is null or v_product.business_id not in (select public.current_user_business_ids()) then
    raise exception 'That product could not be found.' using errcode = 'P0002';
  end if;
  if not public.current_user_has_role(v_product.business_id, array['OWNER', 'ADMIN']::public.business_role[]) then
    raise exception 'Only an owner or admin can change product costs.' using errcode = '42501';
  end if;
  if coalesce(p_unit_cost, '') !~ '^[0-9]{1,16}(\.[0-9]{1,4})?$' then
    raise exception 'Enter the cost as a plain number, for example 42.50.' using errcode = '22023';
  end if;
  if coalesce(p_currency, '') !~ '^[A-Z]{3}$' then
    raise exception 'Choose a currency.' using errcode = '22023';
  end if;
  if p_effective_from is null then
    raise exception 'Choose the date the cost applies from.' using errcode = '22023';
  end if;

  begin
    insert into public.product_costs (business_id, product_id, currency, unit_cost, effective_from, note, created_by)
    values (v_product.business_id, p_product_id, p_currency, p_unit_cost::numeric(20,4), p_effective_from,
            nullif(trim(coalesce(p_note, '')), ''), (select auth.uid()))
    returning id into v_id;
  exception
    when check_violation then
      raise exception 'The note is too long or contains an email address.' using errcode = '23514';
  end;

  perform public.write_audit_log(
    v_product.business_id, 'product_cost.added', 'product_costs', v_id, null,
    jsonb_build_object('product_id', p_product_id, 'currency', p_currency, 'unit_cost', p_unit_cost,
                       'effective_from', p_effective_from,
                       'backdated', p_effective_from < (now() at time zone 'UTC')::date)
  );
  return v_id;
end;
$$;

create function public.product_cost_retire(p_cost_id uuid, p_reason text default null)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_cost public.product_costs;
begin
  if (select auth.uid()) is null then
    raise exception 'Not authenticated.' using errcode = '28000';
  end if;
  select * into v_cost from public.product_costs c where c.id = p_cost_id;
  if v_cost.id is null or v_cost.business_id not in (select public.current_user_business_ids()) then
    raise exception 'That cost could not be found.' using errcode = 'P0002';
  end if;
  if not public.current_user_has_role(v_cost.business_id, array['OWNER', 'ADMIN']::public.business_role[]) then
    raise exception 'Only an owner or admin can change product costs.' using errcode = '42501';
  end if;
  if v_cost.retired_at is not null then
    raise exception 'That cost is already withdrawn.' using errcode = '22023';
  end if;

  begin
    update public.product_costs c
    set retired_at = now(), retired_by = (select auth.uid()),
        retire_reason = nullif(trim(coalesce(p_reason, '')), '')
    where c.id = p_cost_id;
  exception
    when check_violation then
      raise exception 'The reason is too long or contains an email address.' using errcode = '23514';
  end;

  perform public.write_audit_log(
    v_cost.business_id, 'product_cost.withdrawn', 'product_costs', v_cost.id,
    jsonb_build_object('currency', v_cost.currency, 'unit_cost', v_cost.unit_cost::text,
                       'effective_from', v_cost.effective_from),
    jsonb_build_object('reason', nullif(trim(coalesce(p_reason, '')), ''))
  );
end;
$$;


-- ----------------------------------------------------------------------------
-- 8. Row Level Security and privileges
-- ----------------------------------------------------------------------------

alter table public.catalog_products enable row level security;
alter table public.catalog_products force row level security;
alter table public.sku_aliases      enable row level security;
alter table public.sku_aliases      force row level security;
alter table public.product_costs    enable row level security;
alter table public.product_costs    force row level security;

do $$
declare
  t text;
  f text;
begin
  foreach t in array array['catalog_products', 'sku_aliases', 'product_costs']
  loop
    execute format($p$
      create policy %I on public.%I for select to authenticated
      using (business_id in (select public.current_user_business_ids()))
    $p$, t || '_select_member', t);
  end loop;

  foreach t in array array['catalog_products', 'sku_aliases', 'product_costs', 'ledger_product_lines']
  loop
    execute format('revoke all on table public.%I from anon, authenticated, public', t);
    execute format('grant select on table public.%I to authenticated', t);
  end loop;

  foreach f in array array[
    'public.pnl_summary(timestamptz, timestamptz, uuid, uuid, boolean)',
    'public.pnl_by_product(timestamptz, timestamptz, uuid, uuid)',
    'public.sku_mapping_queue(uuid)',
    'public.catalog_product_overview(uuid)',
    'public.catalog_product_create(uuid, text, text, text, text)',
    'public.catalog_product_update(uuid, text, text, text, text, text)',
    'public.sku_alias_decide(uuid, text, text, uuid, text, text)',
    'public.sku_alias_remove(uuid)',
    'public.product_cost_add(uuid, text, text, date, text)',
    'public.product_cost_retire(uuid, text)'
  ]
  loop
    execute format('revoke all on function %s from anon, public', f);
    execute format('grant execute on function %s to authenticated', f);
  end loop;

  revoke all on function public.sku_normalize(text) from anon, public;
  grant execute on function public.sku_normalize(text) to authenticated, service_role;
  revoke all on function public.product_cost_guard() from anon, authenticated, public;
end;
$$;


-- ----------------------------------------------------------------------------
-- 9. Self-verification
-- ----------------------------------------------------------------------------

do $$
declare
  t text;
  f text;
begin
  foreach t in array array['catalog_products', 'sku_aliases', 'product_costs']
  loop
    if not exists (
      select 1 from pg_class c join pg_namespace n on n.oid = c.relnamespace
      where n.nspname = 'public' and c.relname = t and c.relrowsecurity and c.relforcerowsecurity
    ) then
      raise exception 'SECURITY: RLS is not enabled and forced on public.%.', t;
    end if;
    if has_table_privilege('authenticated', format('public.%I', t), 'INSERT')
       or has_table_privilege('authenticated', format('public.%I', t), 'UPDATE')
       or has_table_privilege('authenticated', format('public.%I', t), 'DELETE')
       or has_table_privilege('anon', format('public.%I', t), 'SELECT') then
      raise exception 'SECURITY: public.% is writable by authenticated or readable by anon.', t;
    end if;
  end loop;

  if not exists (
    select 1 from pg_class c join pg_namespace n on n.oid = c.relnamespace
    where n.nspname = 'public' and c.relname = 'ledger_product_lines'
      and coalesce(c.reloptions, '{}') @> array['security_invoker=true']
  ) or has_table_privilege('anon', 'public.ledger_product_lines', 'SELECT') then
    raise exception 'SECURITY: ledger_product_lines must be an invoker view anon cannot read.';
  end if;

  if not exists (select 1 from pg_trigger where tgname = 'product_costs_guard' and not tgisinternal) then
    raise exception 'Guard trigger product_costs_guard is missing.';
  end if;

  foreach f in array array[
    'catalog_product_create', 'catalog_product_update', 'sku_alias_decide', 'sku_alias_remove',
    'product_cost_add', 'product_cost_retire'
  ]
  loop
    if not exists (
      select 1 from pg_proc p join pg_namespace n on n.oid = p.pronamespace
      where n.nspname = 'public' and p.proname = f and p.prosecdef
        and position('current_user_has_role' in p.prosrc) > 0
        and position('current_user_business_ids' in p.prosrc) > 0
    ) then
      raise exception 'SECURITY: %() does not check the caller''s membership and role.', f;
    end if;
  end loop;

  foreach f in array array['pnl_summary', 'pnl_by_product', 'sku_mapping_queue', 'catalog_product_overview']
  loop
    if (select count(*) from pg_proc p join pg_namespace n on n.oid = p.pronamespace
        where n.nspname = 'public' and p.proname = f) <> 1 then
      raise exception 'Exactly one %() must exist.', f;
    end if;
    if exists (
      select 1 from pg_proc p join pg_namespace n on n.oid = p.pronamespace
      where n.nspname = 'public' and p.proname = f
        and (p.prosecdef or has_function_privilege('anon', p.oid, 'EXECUTE'))
    ) then
      raise exception 'SECURITY: %() must be SECURITY INVOKER and closed to anon.', f;
    end if;
  end loop;

  if public.sku_normalize(' sg-t84d/Black ') <> 'SGT84DBLACK' then
    raise exception 'SELF-CHECK: sku_normalize does not behave as intended.';
  end if;

  raise notice 'Migration 0035 verified: products, mappings and dated costs guarded; COGS and Gross Profit readers invoker.';
end;
$$;


commit;
