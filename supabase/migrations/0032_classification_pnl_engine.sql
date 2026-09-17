-- ============================================================================
-- 0032  Automatic classification and the P&L engine
-- ============================================================================
-- GCC Phase 3. Every ledger line is classified automatically, at CALCULATION
-- time, into Financial Type -> Category -> Subcategory -> P&L Treatment
-- (ARCHITECTURE_BASELINE.md section C, "Automatic classification").
--
-- WHAT CHANGES
--   1. classification_categories   the shared model: 24 categories, each with
--                                  its financial type, default P&L treatment
--                                  and the figure it belongs to.
--   2. classification_rules        versioned rules: marketplace code -> category
--                                  and subcategory, with confidence. Separate
--                                  from ledger_mapping_rules, which keep deciding
--                                  what is written at import (quantity,
--                                  attribution). A correction is a new version.
--   3. The 21 Amazon Flat File V2 codes, restated in the model (HIGH).
--   4. tax_profiles.input_vat_treatment  UNKNOWN | RECOVERABLE | NON_RECOVERABLE
--                                  (B1), set by the owner.
--   5. ledger_classified_lines     every counting line with its classification
--                                  resolved through the rules active NOW.
--   6. pnl_summary(), pnl_breakdown(), ledger_data_quality()
--   7. classification_rule_classify() / _retire() / _impact(): an owner or
--      admin may classify a code BizMind does not know, for their business
--      only (B2 amended).
--
-- Ledger rows are not touched. Depends on 0030 and 0031.
-- APPLY THIS IN THE SUPABASE SQL EDITOR.
-- Clear the editor first: click in it, press Ctrl+A, then Delete.
-- ============================================================================

begin;


-- ----------------------------------------------------------------------------
-- 1. The classification model (reference data)
-- ----------------------------------------------------------------------------

create table public.classification_categories (
  code              text primary key check (code ~ '^[A-Z][A-Z_]{1,40}$'),
  financial_type    text not null check (financial_type in ('REVENUE', 'EXPENSE', 'TAX', 'CASH', 'MEMO')),
  label             text not null check (length(label) between 1 and 80),
  default_treatment text not null check (default_treatment in (
    'INCREASE_REVENUE', 'DECREASE_REVENUE', 'INCREASE_EXPENSE', 'NO_PNL_IMPACT', 'CONDITIONAL')),
  metric_group      text not null check (metric_group in (
    'GROSS_SALES', 'SALES_REFUNDS', 'SELLER_DISCOUNTS', 'OTHER_INCOME', 'MARKETPLACE_FEES',
    'FULFILLMENT', 'ADVERTISING', 'OTHER_MARKETPLACE_COSTS', 'INPUT_VAT', 'OUTPUT_VAT', 'CASH', 'MEMO')),
  sort_order        smallint not null,
  constraint classification_categories_treatment_fits_type check (
    (financial_type = 'REVENUE' and default_treatment in ('INCREASE_REVENUE', 'DECREASE_REVENUE'))
    or (financial_type = 'EXPENSE' and default_treatment = 'INCREASE_EXPENSE')
    or (financial_type = 'TAX' and default_treatment in ('CONDITIONAL', 'NO_PNL_IMPACT'))
    or (financial_type in ('CASH', 'MEMO') and default_treatment = 'NO_PNL_IMPACT')
  )
);

comment on table public.classification_categories is
  'The one classification model for every marketplace. A category fixes the '
  'financial type and the default P&L treatment; metrics are defined over '
  'categories, never over marketplace codes. Written by migrations only.';

insert into public.classification_categories
  (code, financial_type, label, default_treatment, metric_group, sort_order) values
  ('PRODUCT_SALES', 'REVENUE', 'Product sales', 'INCREASE_REVENUE', 'GROSS_SALES', 10),
  ('SHIPPING_INCOME', 'REVENUE', 'Shipping income', 'INCREASE_REVENUE', 'GROSS_SALES', 20),
  ('SALES_REFUNDS', 'REVENUE', 'Sales refunds and returns', 'DECREASE_REVENUE', 'SALES_REFUNDS', 30),
  ('SELLER_DISCOUNTS', 'REVENUE', 'Seller-funded discounts', 'DECREASE_REVENUE', 'SELLER_DISCOUNTS', 40),
  ('OTHER_INCOME', 'REVENUE', 'Other income', 'INCREASE_REVENUE', 'OTHER_INCOME', 50),
  ('REIMBURSEMENT', 'REVENUE', 'Reimbursements', 'INCREASE_REVENUE', 'OTHER_INCOME', 60),
  ('SUBSIDY_INCOME', 'REVENUE', 'Subsidy and promotion income', 'INCREASE_REVENUE', 'OTHER_INCOME', 70),
  ('MARKETPLACE_FEE', 'EXPENSE', 'Marketplace fees', 'INCREASE_EXPENSE', 'MARKETPLACE_FEES', 110),
  ('PAYMENT_FEE', 'EXPENSE', 'Payment and COD fees', 'INCREASE_EXPENSE', 'MARKETPLACE_FEES', 120),
  ('REFUND_FEE', 'EXPENSE', 'Refund fees', 'INCREASE_EXPENSE', 'MARKETPLACE_FEES', 130),
  ('FULFILLMENT', 'EXPENSE', 'Fulfillment and logistics', 'INCREASE_EXPENSE', 'FULFILLMENT', 140),
  ('STORAGE', 'EXPENSE', 'Storage', 'INCREASE_EXPENSE', 'FULFILLMENT', 150),
  ('ADVERTISING', 'EXPENSE', 'Advertising', 'INCREASE_EXPENSE', 'ADVERTISING', 160),
  ('PENALTY', 'EXPENSE', 'Penalties', 'INCREASE_EXPENSE', 'OTHER_MARKETPLACE_COSTS', 170),
  ('OTHER_MARKETPLACE_EXPENSE', 'EXPENSE', 'Other marketplace expenses', 'INCREASE_EXPENSE', 'OTHER_MARKETPLACE_COSTS', 180),
  ('INPUT_VAT', 'TAX', 'Input VAT', 'CONDITIONAL', 'INPUT_VAT', 210),
  ('OUTPUT_VAT', 'TAX', 'Output VAT', 'NO_PNL_IMPACT', 'OUTPUT_VAT', 220),
  ('PAYOUT', 'CASH', 'Payouts', 'NO_PNL_IMPACT', 'CASH', 310),
  ('RESERVE_HOLD', 'CASH', 'Reserve held', 'NO_PNL_IMPACT', 'CASH', 320),
  ('RESERVE_RELEASE', 'CASH', 'Reserve released', 'NO_PNL_IMPACT', 'CASH', 330),
  ('TRANSFER', 'CASH', 'Transfers', 'NO_PNL_IMPACT', 'CASH', 340),
  ('REPORT_TOTAL', 'MEMO', 'Report totals', 'NO_PNL_IMPACT', 'MEMO', 410),
  ('REPORT_RESULT', 'MEMO', 'Report results', 'NO_PNL_IMPACT', 'MEMO', 420),
  ('INFORMATIONAL', 'MEMO', 'Informational', 'NO_PNL_IMPACT', 'MEMO', 430);


-- ----------------------------------------------------------------------------
-- 2. Classification rules (versioned data)
-- ----------------------------------------------------------------------------

create table public.classification_rules (
  id               uuid primary key default gen_random_uuid(),
  scope            text not null default 'GLOBAL' check (scope in ('GLOBAL', 'BUSINESS')),
  business_id      uuid references public.businesses (id) on delete cascade,
  marketplace_code text not null references public.marketplaces (code),
  format_id        text not null check (length(format_id) between 1 and 120),
  match_key        text not null check (length(match_key) between 1 and 300),
  category         text not null references public.classification_categories (code),
  subcategory      text not null check (
    length(trim(subcategory)) between 1 and 80 and not public.ledger_text_has_email(subcategory)
  ),
  confidence       text not null check (confidence in ('HIGH', 'MEDIUM')),
  evidence         text not null check (
    length(trim(evidence)) between 1 and 1000 and not public.ledger_text_has_email(evidence)
  ),
  version          integer not null default 1 check (version >= 1),
  supersedes_id    uuid references public.classification_rules (id) on delete cascade,
  status           text not null default 'ACTIVE' check (status in ('ACTIVE', 'RETIRED')),
  created_at       timestamptz not null default now(),
  constraint classification_rules_scope_business_check check ((scope = 'GLOBAL') = (business_id is null)),
  -- A business's own classification is confirmed by a person, so it is never
  -- "under review"; only BizMind's pattern rules can be MEDIUM.
  constraint classification_rules_business_confidence_check check (scope = 'GLOBAL' or confidence = 'HIGH')
);

comment on table public.classification_rules is
  'Marketplace code -> category and subcategory, applied when figures are '
  'calculated. Never edited: a correction is a new version and the old one is '
  'RETIRED, so a fix reaches every past period without touching the ledger.';

create unique index classification_rules_version_key
  on public.classification_rules (
    coalesce(business_id, '00000000-0000-0000-0000-000000000000'::uuid),
    marketplace_code, format_id, match_key, version);

create unique index classification_rules_one_active
  on public.classification_rules (
    coalesce(business_id, '00000000-0000-0000-0000-000000000000'::uuid),
    marketplace_code, format_id, match_key)
  where status = 'ACTIVE';

create index classification_rules_lookup_idx
  on public.classification_rules (marketplace_code, format_id, match_key)
  where status = 'ACTIVE';

/** Never edited; retired only. Deleted only as part of deleting the owning business. */
create function public.classification_rule_guard()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if tg_op = 'UPDATE' then
    if old.status = 'ACTIVE'
       and new.status = 'RETIRED'
       and (to_jsonb(new) - 'status') = (to_jsonb(old) - 'status') then
      return new;
    end if;
    raise exception 'A classification rule cannot be edited. Add a new version and retire this one.'
      using errcode = '42501';
  end if;

  if old.business_id is not null
     and not exists (select 1 from public.businesses b where b.id = old.business_id) then
    return old;
  end if;

  raise exception 'A classification rule cannot be deleted. Retire it instead.'
    using errcode = '42501';
end;
$$;

create trigger classification_rules_guard
  before update or delete on public.classification_rules
  for each row execute function public.classification_rule_guard();

/**
 * The key a line is matched on: its three source codes joined with "|".
 * Adapters store their codes so that this equals the rule's match key (Amazon:
 * transaction-type | amount-type | amount-description).
 */
create function public.classification_match_key(
  p_source_type        text,
  p_source_subtype     text,
  p_source_description text
)
returns text
language sql
immutable
parallel safe
set search_path = ''
as $$
  select coalesce(p_source_type, '') || '|' || coalesce(p_source_subtype, '') || '|'
      || coalesce(p_source_description, '');
$$;


-- ----------------------------------------------------------------------------
-- 3. Amazon Flat File V2, restated in the model
-- ----------------------------------------------------------------------------

insert into public.classification_rules (
  scope, business_id, marketplace_code, format_id, match_key, category, subcategory, confidence, evidence
)
select 'GLOBAL', null, 'AMAZON', 'amazon.settlement.flat_file_v2', r.match_key, r.category, r.subcategory, 'HIGH',
       'Owner-approved classification (2026-09-15), verified on four real Amazon.ae Flat File V2 '
       'settlements with July 2026 reproduced exactly. ' || r.note
from (values
  ('Order|ItemPrice|Principal', 'PRODUCT_SALES', 'Principal', 'Product sales.'),
  ('Order|ItemPrice|Shipping', 'SHIPPING_INCOME', 'Shipping charged', 'Shipping charged to the buyer.'),
  ('Order|ItemPrice|COD', 'OTHER_INCOME', 'COD charge', 'Cash-on-delivery charge collected; other income, not sales.'),
  ('Order|ItemFees|CODFee', 'PAYMENT_FEE', 'COD fee', 'Cash-on-delivery fee.'),
  ('Order|ItemFees|Commission', 'MARKETPLACE_FEE', 'Referral commission', 'Referral commission.'),
  ('Order|ItemFees|FBAPerUnitFulfillmentFee', 'FULFILLMENT', 'FBA per-unit fulfilment', 'FBA fulfilment fee per unit.'),
  ('Order|ItemFees|ShippingChargeback', 'FULFILLMENT', 'Shipping chargeback', 'Shipping cost charged back to the seller.'),
  ('Order|ItemFees|VariableClosingFee', 'MARKETPLACE_FEE', 'Variable closing fee', 'Variable closing fee.'),
  ('Order|Promotion|Shipping', 'SELLER_DISCOUNTS', 'Shipping promotion', 'Seller-funded shipping promotion.'),
  ('Refund|ItemPrice|Principal', 'SALES_REFUNDS', 'Refunded principal', 'Refunded product sales.'),
  ('Refund|ItemPrice|Shipping', 'SALES_REFUNDS', 'Refunded shipping', 'Refunded shipping charge.'),
  ('Refund|ItemPrice|COD', 'OTHER_INCOME', 'COD charge', 'Cash-on-delivery charge reversed on a refund.'),
  ('Refund|ItemFees|CODFee', 'PAYMENT_FEE', 'COD fee', 'Cash-on-delivery fee reversed on a refund.'),
  ('Refund|ItemFees|Commission', 'MARKETPLACE_FEE', 'Referral commission', 'Referral commission reversed on a refund.'),
  ('Refund|ItemFees|RefundCommission', 'REFUND_FEE', 'Refund administration fee', 'Refund administration fee kept by Amazon.'),
  ('Refund|ItemFees|ShippingChargeback', 'FULFILLMENT', 'Shipping chargeback', 'Shipping chargeback reversed on a refund.'),
  ('Refund|Promotion|Shipping', 'SELLER_DISCOUNTS', 'Shipping promotion', 'Shipping promotion reversed on a refund.'),
  ('ServiceFee|Cost of Advertising|TransactionTotalAmount', 'ADVERTISING', 'Sponsored ads', 'Sponsored ads spend, marketplace level.'),
  ('AmazonFees|Premium Services Fee|Base fee', 'MARKETPLACE_FEE', 'SP 360 premium services', 'Selling Partner 360 service fee, confirmed by the owner.'),
  ('AmazonFees|Premium Services Fee|Tax on fee', 'INPUT_VAT', 'VAT on SP 360 fee', 'VAT on the SP 360 fee; its P&L effect follows the account VAT setting (B1).'),
  ('FBAFees|FBA Inventory Storage Fee|Base fee', 'STORAGE', 'FBA storage', 'FBA inventory storage fee.')
) as r (match_key, category, subcategory, note)
where not exists (
  select 1 from public.classification_rules x
  where x.business_id is null
    and x.marketplace_code = 'AMAZON'
    and x.format_id = 'amazon.settlement.flat_file_v2'
    and x.match_key = r.match_key
);


-- ----------------------------------------------------------------------------
-- 4. The account's VAT setting (B1)
-- ----------------------------------------------------------------------------

alter table public.tax_profiles
  add column input_vat_treatment text not null default 'UNKNOWN'
    check (input_vat_treatment in ('UNKNOWN', 'RECOVERABLE', 'NON_RECOVERABLE'));

comment on column public.tax_profiles.input_vat_treatment is
  'How input VAT on marketplace fees counts in profit (B1): RECOVERABLE -> no '
  'P&L impact; NON_RECOVERABLE -> an expense; UNKNOWN -> contribution is '
  'incomplete. Set by the owner once their accountant confirms it.';

create function public.tax_profile_set_input_vat(p_account_id uuid, p_treatment text)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_before public.tax_profiles;
begin
  if (select auth.uid()) is null then
    raise exception 'Not authenticated.' using errcode = '28000';
  end if;

  select * into v_before from public.tax_profiles t where t.marketplace_account_id = p_account_id;

  if v_before.id is null
     or v_before.business_id not in (select public.current_user_business_ids()) then
    raise exception 'That marketplace account could not be found.' using errcode = 'P0002';
  end if;

  if not public.current_user_has_role(v_before.business_id, array['OWNER']::public.business_role[]) then
    raise exception 'Only an owner can change tax settings.' using errcode = '42501';
  end if;

  if p_treatment is null or p_treatment not in ('UNKNOWN', 'RECOVERABLE', 'NON_RECOVERABLE') then
    raise exception 'Choose Recoverable, Non-recoverable or Unknown.' using errcode = '22023';
  end if;

  update public.tax_profiles t
  set input_vat_treatment = p_treatment,
      updated_by          = (select auth.uid())
  where t.id = v_before.id;

  perform public.write_audit_log(
    v_before.business_id, 'tax_profile.input_vat_treatment_set', 'tax_profiles', v_before.id,
    jsonb_build_object('input_vat_treatment', v_before.input_vat_treatment),
    jsonb_build_object('input_vat_treatment', p_treatment)
  );
end;
$$;


-- ----------------------------------------------------------------------------
-- 5. Every counting line, classified through the rules active now
-- ----------------------------------------------------------------------------
-- Rule precedence for a line: a HIGH BizMind rule, then the business's own
-- classification, then a MEDIUM BizMind rule. Money stays exact text.

create view public.ledger_classified_lines
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
  end                                            as classification_status
from public.financial_transactions ft
join public.import_batches b on b.id = ft.source_file_id and b.withdrawn_at is null
join public.marketplace_accounts a on a.id = ft.marketplace_account_id
left join public.tax_profiles tp on tp.marketplace_account_id = ft.marketplace_account_id
left join lateral (
  select cr.id, cr.scope, cr.confidence, cr.version, cr.category, cr.subcategory
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

comment on view public.ledger_classified_lines is
  'Lines of active files, classified through the rules active now: Financial '
  'Type -> Category -> Subcategory -> P&L Treatment. UNKNOWN when no rule '
  'matches. Money as exact text.';


-- ----------------------------------------------------------------------------
-- 6. The P&L engine
-- ----------------------------------------------------------------------------
-- All arithmetic happens here, on exact numerics. Periods are half-open
-- [p_from, p_to) on posted_at, in UTC. One row per marketplace account: figures
-- in different currencies are never combined (A12).
--
-- Amounts keep the marketplace's sign from the seller's view (sales positive,
-- fees and refunds negative), so every figure is a plain signed sum and a
-- reversal nets off by itself.

create function public.pnl_summary(
  p_from       timestamptz,
  p_to         timestamptz,
  p_account_id uuid default null
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
  incomplete_reasons              text[]
)
language sql
stable
security invoker
set search_path = ''
as $$
with scoped as (
  select l.*, l.amount::numeric(20,4) as amt
  from public.ledger_classified_lines l
  where l.posted_at >= p_from
    and l.posted_at < p_to
    and (p_account_id is null or l.marketplace_account_id = p_account_id)
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
totals as (
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
    count(*) filter (where s.pnl_treatment = 'CONDITIONAL')                          as conditional_lines
  from scoped s
  group by s.marketplace_account_id, s.account_label, s.marketplace_code, s.currency
),
judged as (
  select
    t.*,
    coalesce(e.n, 0)                                                   as row_error_count,
    (t.unknown_lines > 0 or coalesce(e.n, 0) > 0)                      as figures_incomplete,
    (t.unknown_lines > 0 or coalesce(e.n, 0) > 0 or t.conditional_lines > 0) as contribution_incomplete
  from totals t
  left join errors e on e.marketplace_account_id = t.marketplace_account_id
)
select
  j.marketplace_account_id,
  j.account_label,
  j.marketplace_code,
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
  coalesce(tp.input_vat_treatment, 'UNKNOWN'),
  j.lines,
  j.unknown_lines,
  j.unknown_amount::numeric(20,4)::text,
  j.review_lines,
  j.review_amount::numeric(20,4)::text,
  j.conditional_lines,
  j.row_error_count,
  array_remove(array[
    case when j.unknown_lines > 0 then 'UNKNOWN_LINES' end,
    case when j.conditional_lines > 0 then 'VAT_TREATMENT_UNKNOWN' end,
    case when j.row_error_count > 0 then 'ROW_ERRORS' end
  ], null)
from judged j
left join public.tax_profiles tp on tp.marketplace_account_id = j.marketplace_account_id
order by j.account_label;
$$;

comment on function public.pnl_summary(timestamptz, timestamptz, uuid) is
  'Figures per marketplace account for [p_from, p_to). contribution is NULL '
  'unless FINAL; contribution_before_open_items is informational only.';

create function public.pnl_breakdown(
  p_from       timestamptz,
  p_to         timestamptz,
  p_account_id uuid default null
)
returns table (
  marketplace_account_id uuid,
  account_label          text,
  currency               char(3),
  financial_type         text,
  category               text,
  category_label         text,
  subcategory            text,
  match_key              text,
  classification_status  text,
  pnl_treatment          text,
  metric_group           text,
  sort_order             smallint,
  lines                  bigint,
  total                  text
)
language sql
stable
security invoker
set search_path = ''
as $$
  select
    l.marketplace_account_id,
    l.account_label,
    l.currency::char(3),
    l.financial_type,
    l.category,
    l.category_label,
    l.subcategory,
    case when l.classification_status = 'UNKNOWN' then l.match_key end,
    l.classification_status,
    l.pnl_treatment,
    l.metric_group,
    c.sort_order,
    count(*),
    sum(l.amount::numeric(20,4))::numeric(20,4)::text
  from public.ledger_classified_lines l
  left join public.classification_categories c on c.code = l.category
  where l.posted_at >= p_from
    and l.posted_at < p_to
    and (p_account_id is null or l.marketplace_account_id = p_account_id)
  group by
    l.marketplace_account_id, l.account_label, l.currency, l.financial_type, l.category,
    l.category_label, l.subcategory,
    case when l.classification_status = 'UNKNOWN' then l.match_key end,
    l.classification_status, l.pnl_treatment, l.metric_group, c.sort_order
  order by l.account_label, c.sort_order nulls last, l.subcategory nulls last, 8 nulls last;
$$;

create function public.ledger_data_quality(
  p_from       timestamptz default null,
  p_to         timestamptz default null,
  p_account_id uuid default null
)
returns table (
  issue_kind             text,
  severity               text,
  marketplace_account_id uuid,
  account_label          text,
  currency               char(3),
  format_id              text,
  reference              text,
  category               text,
  subcategory            text,
  lines                  bigint,
  amount                 text,
  files                  bigint,
  detail                 text
)
language sql
stable
security invoker
set search_path = ''
as $$
with scoped as (
  select l.*
  from public.ledger_classified_lines l
  where (p_from is null or l.posted_at >= p_from)
    and (p_to is null or l.posted_at < p_to)
    and (p_account_id is null or l.marketplace_account_id = p_account_id)
),
scoped_files as (
  select distinct s.marketplace_account_id, s.account_label, s.currency, s.source_file_id from scoped s
),
issues as (
  select
    'UNKNOWN_CODE'::text                                 as issue_kind,
    'WARNING'::text                                      as severity,
    s.marketplace_account_id                             as marketplace_account_id,
    s.account_label                                      as account_label,
    s.currency::char(3)                                  as currency,
    s.format_id                                          as format_id,
    s.match_key                                          as reference,
    null::text                                           as category,
    null::text                                           as subcategory,
    count(*)                                             as lines,
    sum(s.amount::numeric(20,4))::numeric(20,4)::text    as amount,
    count(distinct s.source_file_id)                     as files,
    'Not classified yet. Kept with its amount; counts towards no figure, and the figures it could affect are incomplete.'::text as detail
  from scoped s
  where s.classification_status = 'UNKNOWN'
  group by s.marketplace_account_id, s.account_label, s.currency, s.format_id, s.match_key

  union all

  select
    'UNDER_REVIEW', 'INFO', s.marketplace_account_id, s.account_label, s.currency::char(3),
    s.format_id, s.match_key, s.category, s.subcategory,
    count(*), sum(s.amount::numeric(20,4))::numeric(20,4)::text, count(distinct s.source_file_id),
    'Counted using a medium-confidence rule. Check it against the marketplace report.'
  from scoped s
  where s.classification_status = 'UNDER_REVIEW'
  group by s.marketplace_account_id, s.account_label, s.currency, s.format_id, s.match_key,
           s.category, s.subcategory

  union all

  select
    'VAT_TREATMENT_UNKNOWN', 'WARNING', s.marketplace_account_id, s.account_label, s.currency::char(3),
    null, null, 'INPUT_VAT', null,
    count(*), sum(s.amount::numeric(20,4))::numeric(20,4)::text, count(distinct s.source_file_id),
    'The VAT setting for this account is Unknown, so contribution is incomplete. Set it once your accountant confirms whether this VAT is recoverable.'
  from scoped s
  where s.pnl_treatment = 'CONDITIONAL'
  group by s.marketplace_account_id, s.account_label, s.currency

  union all

  select
    'ROW_ERRORS', 'WARNING', f.marketplace_account_id, f.account_label, f.currency::char(3),
    null, null, null, null,
    count(*), null, count(distinct f.source_file_id),
    'Rows in these files could not be read, so the figures they belong to are incomplete.'
  from scoped_files f
  join public.import_issues i on i.batch_id = f.source_file_id and i.severity = 'ERROR'
  group by f.marketplace_account_id, f.account_label, f.currency

  union all

  select
    'SETTLEMENT_MISMATCH', 'WARNING', st.marketplace_account_id, a.label, st.currency::char(3),
    null, st.external_settlement_id, null, null,
    count(ft.id), (st.reported_total - coalesce(sum(ft.amount), 0))::numeric(20,4)::text, 1::bigint,
    'The total the marketplace reported differs from the sum of its lines by this amount.'
  from public.settlements st
  join (select distinct sf.source_file_id from scoped_files sf) sf on sf.source_file_id = st.source_file_id
  join public.marketplace_accounts a on a.id = st.marketplace_account_id
  left join public.financial_transactions ft on ft.settlement_id = st.id
  group by st.id, st.marketplace_account_id, a.label, st.currency, st.external_settlement_id, st.reported_total
  having st.reported_total is not null and st.reported_total <> coalesce(sum(ft.amount), 0)
)
select * from issues
order by severity desc, issue_kind, account_label, reference;
$$;


-- ----------------------------------------------------------------------------
-- 7. A business classifies a code BizMind does not know (B2 amended)
-- ----------------------------------------------------------------------------

/** What classifying a code would affect: its lines per account and month. Read-only. */
create function public.classification_rule_impact(
  p_business_id      uuid,
  p_marketplace_code text,
  p_format_id        text,
  p_match_key        text
)
returns table (
  marketplace_account_id uuid,
  account_label          text,
  currency               char(3),
  month                  date,
  lines                  bigint,
  amount                 text,
  classification_status  text,
  category               text,
  subcategory            text
)
language sql
stable
security invoker
set search_path = ''
as $$
  select
    l.marketplace_account_id,
    l.account_label,
    l.currency::char(3),
    (date_trunc('month', l.posted_at at time zone 'UTC'))::date,
    count(*),
    sum(l.amount::numeric(20,4))::numeric(20,4)::text,
    l.classification_status,
    l.category,
    l.subcategory
  from public.ledger_classified_lines l
  where l.business_id = p_business_id
    and l.marketplace_code = p_marketplace_code
    and l.format_id = p_format_id
    and l.match_key = p_match_key
  group by 1, 2, 3, 4, 7, 8, 9
  order by 4, 2;
$$;

create function public.classification_rule_classify(
  p_business_id      uuid,
  p_marketplace_code text,
  p_format_id        text,
  p_match_key        text,
  p_category         text,
  p_subcategory      text,
  p_note             text default null
)
returns uuid
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_old  public.classification_rules;
  v_id   uuid;
  v_note text := nullif(trim(coalesce(p_note, '')), '');
begin
  if (select auth.uid()) is null then
    raise exception 'Not authenticated.' using errcode = '28000';
  end if;

  if p_business_id is null
     or p_business_id not in (select public.current_user_business_ids()) then
    raise exception 'That business could not be found.' using errcode = 'P0002';
  end if;

  if not public.current_user_has_role(p_business_id, array['OWNER', 'ADMIN']::public.business_role[]) then
    raise exception 'Only an owner or admin can classify a marketplace code.' using errcode = '42501';
  end if;

  if not exists (select 1 from public.classification_categories c where c.code = p_category) then
    raise exception 'That category does not exist.' using errcode = '22023';
  end if;

  if p_subcategory is null or length(trim(p_subcategory)) not between 1 and 80 then
    raise exception 'Give the line a short name, up to 80 characters.' using errcode = '22023';
  end if;

  if exists (
    select 1 from public.classification_rules r
    where r.business_id is null and r.status = 'ACTIVE'
      and r.marketplace_code = p_marketplace_code
      and r.format_id = p_format_id
      and r.match_key = p_match_key
  ) then
    raise exception 'BizMind already classifies this marketplace code. Report a mismatch instead of changing it.'
      using errcode = '42501';
  end if;

  if not exists (
    select 1
    from public.financial_transactions ft
    join public.import_batches b on b.id = ft.source_file_id
    join public.marketplace_accounts a on a.id = ft.marketplace_account_id
    where ft.business_id = p_business_id
      and a.marketplace_code = p_marketplace_code
      and b.format_id = p_format_id
      and public.classification_match_key(ft.source_type, ft.source_subtype, ft.source_description) = p_match_key
  ) then
    raise exception 'That marketplace code does not appear in this business''s files.' using errcode = 'P0002';
  end if;

  select * into v_old
  from public.classification_rules r
  where r.business_id = p_business_id and r.status = 'ACTIVE'
    and r.marketplace_code = p_marketplace_code
    and r.format_id = p_format_id
    and r.match_key = p_match_key
  for update;

  if v_old.id is not null then
    update public.classification_rules r set status = 'RETIRED' where r.id = v_old.id;
  end if;

  begin
    insert into public.classification_rules (
      scope, business_id, marketplace_code, format_id, match_key, category, subcategory,
      confidence, evidence, version, supersedes_id
    )
    values (
      'BUSINESS', p_business_id, p_marketplace_code, p_format_id, p_match_key, p_category,
      trim(p_subcategory), 'HIGH',
      'Classified for this business by an owner or admin on '
        || to_char(now() at time zone 'UTC', 'YYYY-MM-DD') || coalesce('. Note: ' || v_note, ''),
      coalesce(v_old.version, 0) + 1, v_old.id
    )
    returning id into v_id;
  exception
    when check_violation then
      raise exception 'The name or note is not valid. It must be short and must not contain an email address.'
        using errcode = '23514';
  end;

  perform public.write_audit_log(
    p_business_id, 'classification_rule.created', 'classification_rules', v_id,
    case when v_old.id is null then null
         else jsonb_build_object('rule_id', v_old.id, 'category', v_old.category,
                                 'subcategory', v_old.subcategory, 'version', v_old.version) end,
    jsonb_build_object('marketplace_code', p_marketplace_code, 'format_id', p_format_id,
                       'match_key', p_match_key, 'category', p_category,
                       'subcategory', trim(p_subcategory), 'version', coalesce(v_old.version, 0) + 1)
  );

  return v_id;
end;
$$;

create function public.classification_rule_retire(p_rule_id uuid)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_rule public.classification_rules;
begin
  if (select auth.uid()) is null then
    raise exception 'Not authenticated.' using errcode = '28000';
  end if;

  select * into v_rule from public.classification_rules r where r.id = p_rule_id;

  if v_rule.id is null
     or v_rule.business_id is null
     or v_rule.business_id not in (select public.current_user_business_ids()) then
    raise exception 'That classification could not be found.' using errcode = 'P0002';
  end if;

  if not public.current_user_has_role(v_rule.business_id, array['OWNER', 'ADMIN']::public.business_role[]) then
    raise exception 'Only an owner or admin can change a classification.' using errcode = '42501';
  end if;

  if v_rule.status <> 'ACTIVE' then
    raise exception 'That classification is already retired.' using errcode = '22023';
  end if;

  update public.classification_rules r set status = 'RETIRED' where r.id = v_rule.id;

  perform public.write_audit_log(
    v_rule.business_id, 'classification_rule.retired', 'classification_rules', v_rule.id,
    jsonb_build_object('match_key', v_rule.match_key, 'category', v_rule.category,
                       'subcategory', v_rule.subcategory, 'version', v_rule.version, 'status', 'ACTIVE'),
    jsonb_build_object('status', 'RETIRED')
  );
end;
$$;


-- ----------------------------------------------------------------------------
-- 8. Row Level Security and privileges
-- ----------------------------------------------------------------------------

alter table public.classification_categories enable row level security;
alter table public.classification_categories force row level security;
alter table public.classification_rules      enable row level security;
alter table public.classification_rules      force row level security;

create policy classification_categories_select_all
  on public.classification_categories for select to authenticated using (true);

create policy classification_rules_select
  on public.classification_rules for select to authenticated
  using (business_id is null or business_id in (select public.current_user_business_ids()));

do $$
declare
  t text;
  f text;
begin
  foreach t in array array['classification_categories', 'classification_rules', 'ledger_classified_lines']
  loop
    execute format('revoke all on table public.%I from anon, authenticated, public', t);
    execute format('grant select on table public.%I to authenticated', t);
  end loop;

  foreach f in array array[
    'public.tax_profile_set_input_vat(uuid, text)',
    'public.classification_rule_classify(uuid, text, text, text, text, text, text)',
    'public.classification_rule_retire(uuid)',
    'public.classification_rule_impact(uuid, text, text, text)',
    'public.pnl_summary(timestamptz, timestamptz, uuid)',
    'public.pnl_breakdown(timestamptz, timestamptz, uuid)',
    'public.ledger_data_quality(timestamptz, timestamptz, uuid)'
  ]
  loop
    execute format('revoke all on function %s from anon, public', f);
    execute format('grant execute on function %s to authenticated', f);
  end loop;

  revoke all on function public.classification_match_key(text, text, text) from anon, public;
  grant execute on function public.classification_match_key(text, text, text) to authenticated, service_role;

  revoke all on function public.classification_rule_guard() from anon, authenticated, public;
end;
$$;


-- ----------------------------------------------------------------------------
-- 9. Self-verification
-- ----------------------------------------------------------------------------

do $$
declare
  t   text;
  f   text;
  v_n integer;
begin
  foreach t in array array['classification_categories', 'classification_rules']
  loop
    if not exists (
      select 1 from pg_class c join pg_namespace n on n.oid = c.relnamespace
      where n.nspname = 'public' and c.relname = t and c.relrowsecurity and c.relforcerowsecurity
    ) then
      raise exception 'SECURITY: RLS is not enabled and forced on public.%.', t;
    end if;
    if has_table_privilege('authenticated', format('public.%I', t), 'INSERT')
       or has_table_privilege('authenticated', format('public.%I', t), 'UPDATE')
       or has_table_privilege('authenticated', format('public.%I', t), 'DELETE') then
      raise exception 'SECURITY: authenticated can write public.% directly.', t;
    end if;
    if has_table_privilege('anon', format('public.%I', t), 'SELECT') then
      raise exception 'SECURITY: anon can read public.%.', t;
    end if;
  end loop;

  if not exists (
    select 1 from pg_class c join pg_namespace n on n.oid = c.relnamespace
    where n.nspname = 'public' and c.relname = 'ledger_classified_lines'
      and coalesce(c.reloptions, '{}') @> array['security_invoker=true']
  ) or has_table_privilege('anon', 'public.ledger_classified_lines', 'SELECT') then
    raise exception 'SECURITY: ledger_classified_lines must be an invoker view anon cannot read.';
  end if;

  if not exists (select 1 from pg_trigger where tgname = 'classification_rules_guard' and not tgisinternal) then
    raise exception 'Guard trigger classification_rules_guard is missing.';
  end if;

  foreach f in array array['tax_profile_set_input_vat', 'classification_rule_classify', 'classification_rule_retire']
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

  foreach f in array array['pnl_summary', 'pnl_breakdown', 'ledger_data_quality', 'classification_rule_impact']
  loop
    if exists (
      select 1 from pg_proc p join pg_namespace n on n.oid = p.pronamespace
      where n.nspname = 'public' and p.proname = f and p.prosecdef
    ) then
      raise exception 'SECURITY: %() must be SECURITY INVOKER so RLS decides what it sees.', f;
    end if;
  end loop;

  foreach f in array array[
    'tax_profile_set_input_vat', 'classification_rule_classify', 'classification_rule_retire',
    'classification_rule_impact', 'pnl_summary', 'pnl_breakdown', 'ledger_data_quality'
  ]
  loop
    if exists (
      select 1 from pg_proc p join pg_namespace n on n.oid = p.pronamespace
      where n.nspname = 'public' and p.proname = f and has_function_privilege('anon', p.oid, 'EXECUTE')
    ) then
      raise exception 'SECURITY: anon can execute %().', f;
    end if;
  end loop;

  select count(*) into v_n from public.classification_categories;
  if v_n <> 24 then
    raise exception 'Expected 24 classification categories, found %.', v_n;
  end if;

  select count(*) into v_n from public.classification_rules
  where business_id is null and status = 'ACTIVE' and marketplace_code = 'AMAZON'
    and format_id = 'amazon.settlement.flat_file_v2' and confidence = 'HIGH';
  if v_n <> 21 then
    raise exception 'Expected 21 active Amazon classification rules, found %.', v_n;
  end if;

  -- Every Amazon code the importer knows is classified, and nothing else.
  select count(*) into v_n
  from public.ledger_mapping_rules m
  where m.business_id is null and m.status = 'ACTIVE'
    and m.format_id = 'amazon.settlement.flat_file_v2'
    and not exists (
      select 1 from public.classification_rules c
      where c.business_id is null and c.status = 'ACTIVE'
        and c.format_id = m.format_id and c.match_key = m.match_key);
  if v_n <> 0 then
    raise exception '% Amazon import code(s) have no classification rule.', v_n;
  end if;

  select count(*) into v_n
  from public.classification_rules c
  where c.business_id is null and c.status = 'ACTIVE'
    and c.format_id = 'amazon.settlement.flat_file_v2'
    and not exists (
      select 1 from public.ledger_mapping_rules m
      where m.business_id is null and m.status = 'ACTIVE'
        and m.format_id = c.format_id and m.match_key = c.match_key);
  if v_n <> 0 then
    raise exception '% Amazon classification rule(s) match no import code.', v_n;
  end if;

  if public.classification_match_key('Order', null, 'Principal') <> 'Order||Principal' then
    raise exception 'SELF-CHECK: classification_match_key does not behave as intended.';
  end if;

  begin
    insert into public.classification_categories
      (code, financial_type, label, default_treatment, metric_group, sort_order)
    values ('SELF_CHECK', 'REVENUE', 'x', 'INCREASE_EXPENSE', 'GROSS_SALES', 1);
    raise exception 'SELF-CHECK: a revenue category was allowed to increase expense.';
  exception when check_violation then
    null;
  end;

  begin
    update public.classification_rules set subcategory = 'x'
    where business_id is null and match_key = 'Order|ItemPrice|Principal';
    raise exception 'SELF-CHECK: a classification rule was edited.';
  exception when others then
    if sqlerrm not like '%cannot be edited%' then
      raise exception 'SELF-CHECK failed for the rule guard: %', sqlerrm;
    end if;
  end;

  raise notice
    'Migration 0032 verified: 24 categories, 21 Amazon rules matching the importer, '
    'rules are versioned and guarded, readers run with the caller''s rights, and '
    'only owners and admins can classify.';
end;
$$;


commit;
