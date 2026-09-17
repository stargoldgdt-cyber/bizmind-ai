-- ============================================================================
-- 0037  Operating expenses, Net Profit, and product data from Google Sheets
-- ============================================================================
-- GCC Phase 7. Depends on 0036 (the two new import_entity values) and on
-- 0030-0035.
--
-- WHAT CHANGES
--   1. Expenses are classified automatically, at calculation time, like
--      marketplace lines: an expense's own category name is matched to one of
--      BizMind's expense categories by versioned rules. Each category belongs
--      to a cost class:
--        OPERATING     rent, salaries, software ... -> reduces Net Profit
--        ADVERTISING   advertising outside the marketplaces -> reduces Net Profit
--        NOT_PROFIT    stock purchases (already in COGS), marketplace charges
--                      (already in the marketplace reports), tax payments,
--                      owner drawings and financing -> never in Net Profit
--      A category name no rule knows is UNCLASSIFIED and keeps Net Profit
--      incomplete. An owner or admin classifies it once for the business
--      (audited). Generic names that could double count ("advertising",
--      "marketing", "other") are deliberately left for the owner.
--      The expenses table itself is unchanged: existing expenses, uploads and
--      synced expense tabs keep working (decision B14).
--   2. pnl_net_profit(): per currency, Net Profit = Gross Profit (all
--      marketplace accounts in that currency, 0035) - operating expenses -
--      advertising outside the marketplaces (decision B16). NULL unless final.
--      Expenses are business-wide: they are never allocated to an account or a
--      product (A7).
--   3. Google Sheets dataset targets (A4): a tab can now hold the product
--      master (CATALOG -> catalog_products) or product costs (PRODUCT_COSTS ->
--      dated product_costs). A synced cost that changes is withdrawn and
--      replaced, never edited; a product is never archived or deleted by a
--      sync. Marketplace SKU matching still happens only inside BizMind (A10).
--      The sync gates of 0020-0023 are widened for the two new resources; a
--      dataset sync batch cannot be "withdrawn" as if it were a legacy import.
--
-- Ledger rows are not touched.
-- APPLY THIS IN THE SUPABASE SQL EDITOR, AFTER 0036.
-- Clear the editor first: click in it, press Ctrl+A, then Delete.
-- ============================================================================

begin;


-- ----------------------------------------------------------------------------
-- 1. Expense categories and their rules
-- ----------------------------------------------------------------------------

create table public.expense_categories (
  code        text primary key check (code ~ '^[A-Z][A-Z_]{1,40}$'),
  label       text not null check (length(label) between 1 and 80),
  cost_class  text not null check (cost_class in ('OPERATING', 'ADVERTISING', 'NOT_PROFIT')),
  explanation text not null check (length(explanation) between 1 and 300),
  sort_order  integer not null
);

comment on table public.expense_categories is
  'BizMind''s expense categories. The cost class decides whether an expense '
  'reduces Net Profit. Reference data, the same for every business.';

insert into public.expense_categories (code, label, cost_class, explanation, sort_order) values
  ('RENT', 'Rent and utilities', 'OPERATING', 'Premises, warehouse, electricity, internet.', 10),
  ('SALARIES', 'Salaries and staff', 'OPERATING', 'Wages, payroll and staff costs.', 20),
  ('SOFTWARE', 'Software and subscriptions', 'OPERATING', 'Tools and services paid by subscription.', 30),
  ('PROFESSIONAL_FEES', 'Accounting, legal and professional', 'OPERATING', 'Accountants, lawyers, auditors, consultants.', 40),
  ('SHIPPING_OWN', 'Delivery you pay directly', 'OPERATING', 'Couriers and delivery outside the marketplaces'' own fulfilment.', 50),
  ('PACKAGING', 'Packaging and supplies', 'OPERATING', 'Boxes, labels and packing materials.', 60),
  ('BANK_CHARGES', 'Bank and payment charges', 'OPERATING', 'Bank fees and payment-gateway charges outside the marketplaces.', 70),
  ('TRAVEL', 'Travel and transport', 'OPERATING', 'Travel, fuel and local transport.', 80),
  ('OFFICE', 'Office and administration', 'OPERATING', 'Office running costs and administration.', 90),
  ('LICENCES', 'Licences and government fees', 'OPERATING', 'Trade licences, visas and government fees.', 100),
  ('OTHER_OPERATING', 'Other operating expense', 'OPERATING', 'A running cost of the business not listed above.', 110),
  ('EXTERNAL_ADVERTISING', 'Advertising outside the marketplaces', 'ADVERTISING', 'Social media, search and influencer marketing. Marketplace ads are already in the marketplace reports.', 200),
  ('STOCK_PURCHASES', 'Stock purchases', 'NOT_PROFIT', 'Buying products. Their cost counts as cost of goods sold when they sell, so the purchase itself is not counted again.', 300),
  ('MARKETPLACE_CHARGES', 'Already in the marketplace reports', 'NOT_PROFIT', 'Marketplace fees and ads BizMind already reads from Amazon and noon. Counting them here would count them twice.', 310),
  ('TAX_PAYMENTS', 'VAT and tax payments', 'NOT_PROFIT', 'VAT and tax paid to the authorities. Kept apart from profit.', 320),
  ('OWNER_AND_FINANCING', 'Owner drawings, loans and transfers', 'NOT_PROFIT', 'Money moving between the owner, lenders and the business. Not a cost.', 330);

/** The matching form of an expense category name: letters and digits, lower case, single spaces. */
create function public.expense_category_key(p_name text)
returns text
language sql
immutable
parallel safe
set search_path = ''
as $$
  select lower(btrim(regexp_replace(coalesce(p_name, ''), '[^[:alnum:]]+', ' ', 'g')));
$$;

create table public.expense_category_rules (
  id            uuid primary key default gen_random_uuid(),
  business_id   uuid references public.businesses (id) on delete cascade,
  match_key     text not null check (length(match_key) between 1 and 120),
  category_code text not null references public.expense_categories (code),
  status        text not null default 'ACTIVE' check (status in ('ACTIVE', 'RETIRED')),
  created_by    uuid,
  created_at    timestamptz not null default now(),
  retired_by    uuid,
  retired_at    timestamptz,
  constraint expense_category_rules_retired_check check ((status = 'RETIRED') = (retired_at is not null))
);

comment on table public.expense_category_rules is
  'Which expense category a category name means. GLOBAL rules (no business) '
  'are BizMind''s, seeded here; a business''s own rule wins over a global one. '
  'Never edited: a rule is retired and a new one added.';

create unique index expense_category_rules_one_active
  on public.expense_category_rules (coalesce(business_id, '00000000-0000-0000-0000-000000000000'::uuid), match_key)
  where status = 'ACTIVE';

create index expense_category_rules_business_idx
  on public.expense_category_rules (business_id, status);

create function public.expense_category_rule_guard()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if tg_op = 'UPDATE' then
    if old.status = 'ACTIVE' and new.status = 'RETIRED'
       and (to_jsonb(new) - 'status' - 'retired_by' - 'retired_at')
         = (to_jsonb(old) - 'status' - 'retired_by' - 'retired_at') then
      return new;
    end if;
    raise exception 'An expense category rule cannot be edited. Retire it and add a new one.'
      using errcode = '42501';
  end if;

  if old.business_id is not null
     and not exists (select 1 from public.businesses b where b.id = old.business_id) then
    return old;
  end if;
  raise exception 'An expense category rule cannot be deleted. Retire it instead.' using errcode = '42501';
end;
$$;

create trigger expense_category_rules_guard
  before update or delete on public.expense_category_rules
  for each row execute function public.expense_category_rule_guard();

-- Only exact, unambiguous names. Anything that could be a marketplace cost or
-- a stock purchase in disguise ("advertising", "marketing", "other",
-- "freight") is left for the owner.
insert into public.expense_category_rules (business_id, match_key, category_code)
select null, public.expense_category_key(k), c
from (values
  ('rent', 'RENT'), ('office rent', 'RENT'), ('warehouse rent', 'RENT'), ('utilities', 'RENT'),
  ('electricity', 'RENT'), ('internet', 'RENT'), ('rent and utilities', 'RENT'),
  ('salaries', 'SALARIES'), ('salary', 'SALARIES'), ('wages', 'SALARIES'), ('payroll', 'SALARIES'),
  ('staff costs', 'SALARIES'), ('salaries and wages', 'SALARIES'),
  ('software', 'SOFTWARE'), ('subscriptions', 'SOFTWARE'), ('software subscriptions', 'SOFTWARE'),
  ('accounting', 'PROFESSIONAL_FEES'), ('accounting fees', 'PROFESSIONAL_FEES'), ('legal', 'PROFESSIONAL_FEES'),
  ('legal fees', 'PROFESSIONAL_FEES'), ('professional fees', 'PROFESSIONAL_FEES'), ('audit fees', 'PROFESSIONAL_FEES'),
  ('courier', 'SHIPPING_OWN'), ('courier charges', 'SHIPPING_OWN'), ('delivery charges', 'SHIPPING_OWN'),
  ('packaging', 'PACKAGING'), ('packing materials', 'PACKAGING'), ('packaging materials', 'PACKAGING'),
  ('bank charges', 'BANK_CHARGES'), ('bank fees', 'BANK_CHARGES'), ('payment gateway fees', 'BANK_CHARGES'),
  ('travel', 'TRAVEL'), ('fuel', 'TRAVEL'), ('transportation', 'TRAVEL'),
  ('office expenses', 'OFFICE'), ('stationery', 'OFFICE'), ('office supplies', 'OFFICE'),
  ('trade licence', 'LICENCES'), ('trade license', 'LICENCES'), ('licence fees', 'LICENCES'),
  ('license fees', 'LICENCES'), ('visa fees', 'LICENCES'), ('government fees', 'LICENCES'),
  ('facebook ads', 'EXTERNAL_ADVERTISING'), ('meta ads', 'EXTERNAL_ADVERTISING'), ('google ads', 'EXTERNAL_ADVERTISING'),
  ('instagram ads', 'EXTERNAL_ADVERTISING'), ('tiktok ads', 'EXTERNAL_ADVERTISING'), ('snapchat ads', 'EXTERNAL_ADVERTISING'),
  ('influencer marketing', 'EXTERNAL_ADVERTISING'),
  ('inventory', 'STOCK_PURCHASES'), ('stock', 'STOCK_PURCHASES'), ('stock purchase', 'STOCK_PURCHASES'),
  ('stock purchases', 'STOCK_PURCHASES'), ('inventory purchases', 'STOCK_PURCHASES'), ('purchases', 'STOCK_PURCHASES'),
  ('cogs', 'STOCK_PURCHASES'), ('cost of goods sold', 'STOCK_PURCHASES'),
  ('amazon fees', 'MARKETPLACE_CHARGES'), ('noon fees', 'MARKETPLACE_CHARGES'), ('marketplace fees', 'MARKETPLACE_CHARGES'),
  ('amazon ads', 'MARKETPLACE_CHARGES'), ('noon ads', 'MARKETPLACE_CHARGES'), ('amazon advertising', 'MARKETPLACE_CHARGES'),
  ('noon advertising', 'MARKETPLACE_CHARGES'), ('fba fees', 'MARKETPLACE_CHARGES'), ('fbn fees', 'MARKETPLACE_CHARGES'),
  ('vat', 'TAX_PAYMENTS'), ('vat payment', 'TAX_PAYMENTS'), ('corporate tax', 'TAX_PAYMENTS'),
  ('owner drawings', 'OWNER_AND_FINANCING'), ('drawings', 'OWNER_AND_FINANCING'), ('dividends', 'OWNER_AND_FINANCING'),
  ('loan repayment', 'OWNER_AND_FINANCING'), ('loan repayments', 'OWNER_AND_FINANCING')
) as seed (k, c);


-- ----------------------------------------------------------------------------
-- 2. Expenses, classified at calculation time
-- ----------------------------------------------------------------------------

create view public.expense_lines
with (security_invoker = true)
as
select
  e.id,
  e.business_id,
  e.incurred_at,
  e.amount::text                                   as amount,
  (-e.amount)::numeric(20,4)::text                 as signed_amount,
  e.currency::text                                 as currency,
  e.category                                       as category_name,
  public.expense_category_key(e.category)          as match_key,
  r.id                                             as rule_id,
  case when r.id is null then null when r.business_id is null then 'GLOBAL' else 'BUSINESS' end as rule_scope,
  c.code                                           as category_code,
  c.label                                          as category_label,
  c.cost_class,
  case when r.id is null then 'UNCLASSIFIED' else 'CLASSIFIED' end as classification_status,
  e.description,
  e.vendor,
  e.external_id,
  e.source::text                                   as source
from public.expenses e
left join lateral (
  select cr.id, cr.business_id, cr.category_code
  from public.expense_category_rules cr
  where cr.status = 'ACTIVE'
    and cr.match_key = public.expense_category_key(e.category)
    and (cr.business_id is null or cr.business_id = e.business_id)
  -- The business's own word wins over BizMind's.
  order by (cr.business_id is null)
  limit 1
) r on true
left join public.expense_categories c on c.code = r.category_code;

comment on view public.expense_lines is
  'Every expense with its category and cost class, decided now by the active '
  'rules. Amounts as exact text; signed_amount is negative (money out).';

create function public.expense_summary(
  p_from        timestamptz,
  p_to          timestamptz,
  p_business_id uuid
)
returns table (
  currency                   text,
  lines                      bigint,
  operating_expenses         text,
  external_advertising       text,
  not_in_profit              text,
  unclassified_lines         bigint,
  unclassified_amount        text
)
language sql
stable
security invoker
set search_path = ''
as $$
  select
    x.currency,
    count(*),
    coalesce(sum(x.signed_amount::numeric) filter (where x.cost_class = 'OPERATING'), 0)::numeric(20,4)::text,
    coalesce(sum(x.signed_amount::numeric) filter (where x.cost_class = 'ADVERTISING'), 0)::numeric(20,4)::text,
    coalesce(sum(x.signed_amount::numeric) filter (where x.cost_class = 'NOT_PROFIT'), 0)::numeric(20,4)::text,
    count(*) filter (where x.classification_status = 'UNCLASSIFIED'),
    coalesce(sum(x.signed_amount::numeric) filter (where x.classification_status = 'UNCLASSIFIED'), 0)::numeric(20,4)::text
  from public.expense_lines x
  where x.business_id = p_business_id
    and x.incurred_at >= p_from
    and x.incurred_at < p_to
  group by x.currency
  order by x.currency;
$$;

create function public.expense_breakdown(
  p_from        timestamptz,
  p_to          timestamptz,
  p_business_id uuid
)
returns table (
  currency       text,
  cost_class     text,
  category_code  text,
  category_label text,
  category_name  text,
  lines          bigint,
  total          text
)
language sql
stable
security invoker
set search_path = ''
as $$
  select
    x.currency,
    coalesce(x.cost_class, 'UNCLASSIFIED'),
    x.category_code,
    x.category_label,
    case when x.category_code is null then min(x.category_name) end,
    count(*),
    sum(x.signed_amount::numeric)::numeric(20,4)::text
  from public.expense_lines x
  where x.business_id = p_business_id
    and x.incurred_at >= p_from
    and x.incurred_at < p_to
  group by x.currency, x.cost_class, x.category_code, x.category_label,
           case when x.category_code is null then x.match_key end
  order by x.currency,
           case coalesce(x.cost_class, 'UNCLASSIFIED')
             when 'UNCLASSIFIED' then 0 when 'OPERATING' then 1 when 'ADVERTISING' then 2 else 3 end,
           sum(x.signed_amount::numeric);
$$;

create function public.expense_periods(p_business_id uuid)
returns table (month date, currency text, lines bigint)
language sql
stable
security invoker
set search_path = ''
as $$
  select date_trunc('month', x.incurred_at at time zone 'UTC')::date, x.currency, count(*)
  from public.expense_lines x
  where x.business_id = p_business_id
  group by 1, 2
  order by 1 desc, 2;
$$;

create function public.expense_category_queue(p_business_id uuid)
returns table (
  match_key     text,
  category_name text,
  lines         bigint,
  currencies    text,
  total         text,
  first_seen    timestamptz,
  last_seen     timestamptz
)
language sql
stable
security invoker
set search_path = ''
as $$
  select
    x.match_key,
    coalesce(min(x.category_name), '(no category)'),
    count(*),
    string_agg(distinct x.currency, ', '),
    sum(x.signed_amount::numeric)::numeric(20,4)::text,
    min(x.incurred_at),
    max(x.incurred_at)
  from public.expense_lines x
  where x.business_id = p_business_id
    and x.classification_status = 'UNCLASSIFIED'
  group by x.match_key
  order by sum(x.signed_amount::numeric), x.match_key;
$$;


-- ----------------------------------------------------------------------------
-- 3. Net Profit (B16)
-- ----------------------------------------------------------------------------

create function public.pnl_net_profit(
  p_from        timestamptz,
  p_to          timestamptz,
  p_business_id uuid
)
returns table (
  currency                       text,
  accounts                       bigint,
  contribution                   text,
  cogs                           text,
  gross_profit                   text,
  gross_profit_status            text,
  gross_profit_before_open_items text,
  expense_lines                  bigint,
  operating_expenses             text,
  external_advertising           text,
  not_in_profit                  text,
  unclassified_expense_lines     bigint,
  unclassified_expense_amount    text,
  net_profit                     text,
  net_profit_status              text,
  net_profit_before_open_items   text,
  net_profit_reasons             text[]
)
language sql
stable
security invoker
set search_path = ''
as $$
with market as (
  select * from public.pnl_summary(p_from, p_to, null, p_business_id, true)
),
spend as (
  select * from public.expense_summary(p_from, p_to, p_business_id)
),
joined as (
  select
    coalesce(m.currency::text, s.currency)                          as currency,
    m.accounts,
    m.contribution,
    m.cogs,
    m.gross_profit,
    m.gross_profit_status,
    m.gross_profit_before_open_items,
    m.gross_profit_reasons,
    coalesce(s.lines, 0)                                            as expense_lines,
    coalesce(s.operating_expenses, '0')::numeric(20,4)              as operating,
    coalesce(s.external_advertising, '0')::numeric(20,4)            as advertising,
    coalesce(s.not_in_profit, '0')::numeric(20,4)                   as excluded,
    coalesce(s.unclassified_lines, 0)                               as unclassified_lines,
    coalesce(s.unclassified_amount, '0')::numeric(20,4)             as unclassified_amount,
    (m.currency is null)                                            as no_marketplace_data
  from market m
  full join spend s on s.currency = m.currency::text
)
select
  j.currency,
  coalesce(j.accounts, 0),
  j.contribution,
  coalesce(j.cogs, '0.0000'),
  j.gross_profit,
  coalesce(j.gross_profit_status, 'INCOMPLETE'),
  coalesce(j.gross_profit_before_open_items, '0.0000'),
  j.expense_lines,
  j.operating::text,
  j.advertising::text,
  j.excluded::text,
  j.unclassified_lines,
  j.unclassified_amount::text,
  case
    when j.gross_profit is null or j.unclassified_lines > 0 then null
    else (j.gross_profit::numeric + j.operating + j.advertising)::numeric(20,4)::text
  end,
  case
    when j.gross_profit is null or j.unclassified_lines > 0 then 'INCOMPLETE'
    else 'FINAL'
  end,
  (coalesce(j.gross_profit_before_open_items, '0')::numeric + j.operating + j.advertising)::numeric(20,4)::text,
  coalesce(j.gross_profit_reasons, '{}'::text[])
    || array_remove(array[
         case when j.no_marketplace_data then 'NO_MARKETPLACE_DATA' end,
         case when j.unclassified_lines > 0 then 'EXPENSES_UNCLASSIFIED' end
       ], null)
from joined j
order by j.currency;
$$;

comment on function public.pnl_net_profit(timestamptz, timestamptz, uuid) is
  'Net Profit per currency for [p_from, p_to): every marketplace account''s gross '
  'profit in that currency, less operating expenses and advertising outside the '
  'marketplaces. net_profit is NULL unless FINAL; the *_before_open_items figure '
  'is informational only.';


-- ----------------------------------------------------------------------------
-- 4. Classifying an expense category (OWNER or ADMIN, decision B11)
-- ----------------------------------------------------------------------------

create function public.expense_category_classify(
  p_business_id   uuid,
  p_category_name text,
  p_category_code text
)
returns uuid
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_key      text := public.expense_category_key(p_category_name);
  v_previous public.expense_category_rules;
  v_id       uuid;
begin
  if (select auth.uid()) is null then
    raise exception 'Not authenticated.' using errcode = '28000';
  end if;
  if p_business_id is null or p_business_id not in (select public.current_user_business_ids()) then
    raise exception 'That business could not be found.' using errcode = 'P0002';
  end if;
  if not public.current_user_has_role(p_business_id, array['OWNER', 'ADMIN']::public.business_role[]) then
    raise exception 'Only an owner or admin can classify expenses.' using errcode = '42501';
  end if;
  if v_key = '' then
    raise exception 'Expenses with no category cannot be classified together. Give them a category first.'
      using errcode = '22023';
  end if;
  if not exists (select 1 from public.expense_categories c where c.code = p_category_code) then
    raise exception 'Choose one of BizMind''s expense categories.' using errcode = '22023';
  end if;
  if not exists (
    select 1 from public.expenses e
    where e.business_id = p_business_id and public.expense_category_key(e.category) = v_key
  ) then
    raise exception 'No expense in this business uses that category.' using errcode = 'P0002';
  end if;

  select * into v_previous
  from public.expense_category_rules r
  where r.business_id = p_business_id and r.match_key = v_key and r.status = 'ACTIVE';

  if v_previous.id is not null then
    update public.expense_category_rules
    set status = 'RETIRED', retired_by = (select auth.uid()), retired_at = now()
    where id = v_previous.id;
  end if;

  insert into public.expense_category_rules (business_id, match_key, category_code, created_by)
  values (p_business_id, v_key, p_category_code, (select auth.uid()))
  returning id into v_id;

  perform public.write_audit_log(
    p_business_id, 'expense_category.classified', 'expense_category_rules', v_id,
    case when v_previous.id is null then null
         else jsonb_build_object('category_code', v_previous.category_code, 'rule_id', v_previous.id) end,
    jsonb_build_object('category_name', left(p_category_name, 120), 'match_key', v_key, 'category_code', p_category_code)
  );
  return v_id;
end;
$$;

create function public.expense_category_rule_retire(p_rule_id uuid)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_rule public.expense_category_rules;
begin
  if (select auth.uid()) is null then
    raise exception 'Not authenticated.' using errcode = '28000';
  end if;
  select * into v_rule from public.expense_category_rules r where r.id = p_rule_id;
  if v_rule.id is null or v_rule.business_id is null
     or v_rule.business_id not in (select public.current_user_business_ids()) then
    raise exception 'That classification could not be found.' using errcode = 'P0002';
  end if;
  if not public.current_user_has_role(v_rule.business_id, array['OWNER', 'ADMIN']::public.business_role[]) then
    raise exception 'Only an owner or admin can classify expenses.' using errcode = '42501';
  end if;
  if v_rule.status <> 'ACTIVE' then
    raise exception 'That classification was already undone.' using errcode = '22023';
  end if;

  update public.expense_category_rules
  set status = 'RETIRED', retired_by = (select auth.uid()), retired_at = now()
  where id = v_rule.id;

  perform public.write_audit_log(
    v_rule.business_id, 'expense_category.retired', 'expense_category_rules', v_rule.id,
    jsonb_build_object('match_key', v_rule.match_key, 'category_code', v_rule.category_code),
    null
  );
end;
$$;


-- ----------------------------------------------------------------------------
-- 5. Product data from Google Sheets (A4)
-- ----------------------------------------------------------------------------

alter table public.product_costs
  add column source text not null default 'MANUAL' check (source in ('MANUAL', 'SHEETS')),
  -- No foreign key: a cost outlives the connection that brought it, and the
  -- cost guard refuses the update a SET NULL would make.
  add column integration_account_id uuid;

-- A cost a sync replaces is withdrawn by no person: who withdrew it is known
-- only when someone did. It is still never set on a cost in force.
alter table public.product_costs drop constraint product_costs_retired_check;
alter table public.product_costs add constraint product_costs_retired_check
  check (retired_at is not null or retired_by is null);

comment on column public.product_costs.source is
  'MANUAL: entered on Products and costs. SHEETS: read from a connected Google Sheet.';

alter table public.sync_jobs drop constraint sync_jobs_resource_check;
alter table public.sync_jobs add constraint sync_jobs_resource_check
  check (resource in ('ORDERS', 'PRODUCTS', 'CUSTOMERS', 'INVENTORY', 'EXPENSES', 'CATALOG', 'PRODUCT_COSTS'));

alter table public.integration_record_state drop constraint integration_record_state_entity_check;
alter table public.integration_record_state add constraint integration_record_state_entity_check
  check (entity in ('ORDERS', 'PRODUCTS', 'EXPENSES', 'CATALOG', 'PRODUCT_COSTS'));

/** A dataset sync wrote current data, not a batch of records: nothing to withdraw. */
create function public.import_batch_dataset_guard()
returns trigger
language plpgsql
security invoker
set search_path = ''
as $$
begin
  if new.withdrawn_at is not null and old.withdrawn_at is null
     and new.entity::text in ('CATALOG', 'PRODUCT_COSTS') then
    raise exception 'A product or cost sync cannot be withdrawn. Archive a product or withdraw a cost on Products and costs instead.'
      using errcode = '42501';
  end if;
  return new;
end;
$$;

create trigger import_batches_dataset_guard
  before update on public.import_batches
  for each row execute function public.import_batch_dataset_guard();

/** The job a dataset writer serves, its batch, and its business. */
create function public.sync_dataset_batch(p_job_id uuid, p_resource text, p_rows jsonb)
returns public.import_batches
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_job   public.sync_jobs;
  v_run   uuid;
  v_batch public.import_batches;
begin
  select * into v_job from public.sync_jobs where id = p_job_id;
  if v_job.id is null then
    raise exception 'No such sync job.' using errcode = 'P0002';
  end if;
  if v_job.resource <> p_resource then
    raise exception 'This sync job does not hold that kind of data.' using errcode = 'P0001';
  end if;
  if jsonb_typeof(coalesce(p_rows, '[]'::jsonb)) <> 'array' then
    raise exception 'Rows must be a list.' using errcode = '22023';
  end if;

  select r.id into v_run
  from public.sync_runs r
  where r.job_id = p_job_id and r.status = 'RUNNING'
  order by r.started_at desc
  limit 1;

  insert into public.import_batches (
    business_id, entity, status, source, channel_id, file_name, file_type,
    file_size_bytes, row_count, integration_account_id, sync_run_id, committed_at, source_kind
  )
  values (
    v_job.business_id, p_resource::public.import_entity, 'COMPLETED', 'OTHER', null,
    'sync:' || p_resource, 'api', 0, jsonb_array_length(coalesce(p_rows, '[]'::jsonb)),
    v_job.integration_account_id, v_run, now(), 'GOOGLE_SHEETS'
  )
  returning * into v_batch;

  return v_batch;
end;
$$;

/**
 * The product master from a synced tab. p_rows: [{ sku, name, category, brand }].
 * A product is matched on its SKU code (ignoring case and punctuation), added
 * when new, updated when its name, category or brand changed. Never archived,
 * never deleted, never matched to a marketplace SKU.
 */
create function public.sync_apply_catalog(p_job_id uuid, p_rows jsonb)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_batch   public.import_batches := public.sync_dataset_batch(p_job_id, 'CATALOG', p_rows);
  v_row     jsonb;
  v_sku     text;
  v_name    text;
  v_cat     text;
  v_brand   text;
  v_product public.catalog_products;
  v_created integer := 0;
  v_updated integer := 0;
begin
  for v_row in select value from jsonb_array_elements(coalesce(p_rows, '[]'::jsonb))
  loop
    v_sku   := nullif(btrim(v_row ->> 'sku'), '');
    v_name  := nullif(btrim(v_row ->> 'name'), '');
    v_cat   := nullif(btrim(v_row ->> 'category'), '');
    v_brand := nullif(btrim(v_row ->> 'brand'), '');
    if v_sku is null or v_name is null or public.sku_normalize(v_sku) = '' then
      raise exception 'A product row needs a SKU code with letters or digits, and a name.' using errcode = '22023';
    end if;

    select * into v_product
    from public.catalog_products p
    where p.business_id = v_batch.business_id
      and p.sku_code is not null
      and public.sku_normalize(p.sku_code) = public.sku_normalize(v_sku);

    if v_product.id is null then
      insert into public.catalog_products (business_id, name, sku_code, category, brand)
      values (v_batch.business_id, v_name, v_sku, v_cat, v_brand);
      v_created := v_created + 1;
    elsif (v_product.name, v_product.category, v_product.brand)
          is distinct from (v_name, v_cat, v_brand) then
      update public.catalog_products
      set name = v_name, category = v_cat, brand = v_brand
      where id = v_product.id;
      v_updated := v_updated + 1;
    end if;
  end loop;

  update public.import_batches
  set created_count = v_created, updated_count = v_updated,
      rows_valid = jsonb_array_length(coalesce(p_rows, '[]'::jsonb))
  where id = v_batch.id;

  insert into public.audit_logs (business_id, actor_id, action, entity_type, entity_id, before_data, after_data)
  values (v_batch.business_id, null, 'catalog_product.synced', 'import_batches', v_batch.id, null,
          jsonb_build_object('created', v_created, 'updated', v_updated,
                             'integration_account_id', v_batch.integration_account_id));

  return jsonb_build_object('batch_id', v_batch.id, 'products_created', v_created, 'products_updated', v_updated);
end;
$$;

/**
 * Dated product costs from a synced tab.
 * p_rows: [{ sku, costs: [{ currency, unit_cost, effective_from | null }] }].
 *
 * A dated cost: kept when the same cost is already in force from that date;
 * otherwise the costs from that date are withdrawn and the new one added.
 * An undated cost applies from the day it is first synced (B7): nothing
 * changes while it matches the cost in force, and a new version starts today
 * when it differs. A SKU code BizMind does not know becomes a product named
 * after it. Every replacement is in the audit log.
 */
create function public.sync_apply_product_costs(p_job_id uuid, p_rows jsonb)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_batch    public.import_batches := public.sync_dataset_batch(p_job_id, 'PRODUCT_COSTS', p_rows);
  v_today    date := (now() at time zone 'UTC')::date;
  v_row      jsonb;
  v_cost     jsonb;
  v_sku      text;
  v_currency text;
  v_amount   numeric(20,4);
  v_from     date;
  v_dated    boolean;
  v_product  uuid;
  v_current  public.product_costs;
  v_created  integer := 0;
  v_added    integer := 0;
  v_replaced integer := 0;
  v_changes  jsonb := '[]'::jsonb;
begin
  for v_row in select value from jsonb_array_elements(coalesce(p_rows, '[]'::jsonb))
  loop
    v_sku := nullif(btrim(v_row ->> 'sku'), '');
    if v_sku is null or public.sku_normalize(v_sku) = '' then
      raise exception 'A cost row needs a SKU code with letters or digits.' using errcode = '22023';
    end if;

    select p.id into v_product
    from public.catalog_products p
    where p.business_id = v_batch.business_id
      and p.sku_code is not null
      and public.sku_normalize(p.sku_code) = public.sku_normalize(v_sku);

    if v_product is null then
      insert into public.catalog_products (business_id, name, sku_code)
      values (v_batch.business_id, v_sku, v_sku)
      returning id into v_product;
      v_created := v_created + 1;
    end if;

    for v_cost in select value from jsonb_array_elements(coalesce(v_row -> 'costs', '[]'::jsonb))
    loop
      v_currency := v_cost ->> 'currency';
      if coalesce(v_currency, '') !~ '^[A-Z]{3}$'
         or coalesce(v_cost ->> 'unit_cost', '') !~ '^[0-9]{1,16}(\.[0-9]{1,4})?$'
         or coalesce(v_cost ->> 'effective_from', '0000-00-00') !~ '^\d{4}-\d{2}-\d{2}$' then
        raise exception 'A cost for SKU % is not a currency, a plain number and a date.', v_sku using errcode = '22023';
      end if;
      v_amount := (v_cost ->> 'unit_cost')::numeric(20,4);
      v_dated  := v_cost ->> 'effective_from' is not null;
      v_from   := coalesce((v_cost ->> 'effective_from')::date, v_today);

      if v_dated then
        select * into v_current
        from public.product_costs c
        where c.product_id = v_product and c.currency = v_currency
          and c.effective_from = v_from and c.retired_at is null
        order by c.created_at desc
        limit 1;
      else
        select * into v_current
        from public.product_costs c
        where c.product_id = v_product and c.currency = v_currency
          and c.effective_from <= v_today and c.retired_at is null
        order by c.effective_from desc, c.created_at desc
        limit 1;
      end if;

      continue when v_current.id is not null and v_current.unit_cost = v_amount;

      if exists (
        select 1 from public.product_costs c
        where c.product_id = v_product and c.currency = v_currency
          and c.effective_from = v_from and c.retired_at is null
      ) then
        update public.product_costs c
        set retired_at = now(), retired_by = null, retire_reason = 'Changed in the Google Sheet'
        where c.product_id = v_product and c.currency = v_currency
          and c.effective_from = v_from and c.retired_at is null;
        v_replaced := v_replaced + 1;
      else
        v_added := v_added + 1;
      end if;

      insert into public.product_costs (
        business_id, product_id, currency, unit_cost, effective_from, note, source, integration_account_id
      )
      values (
        v_batch.business_id, v_product, v_currency, v_amount, v_from,
        case when v_dated then null else 'No date in the sheet: applies from the day it was first synced' end,
        'SHEETS', v_batch.integration_account_id
      );

      if jsonb_array_length(v_changes) < 200 then
        v_changes := v_changes || jsonb_build_object(
          'product_id', v_product, 'currency', v_currency, 'effective_from', v_from,
          'unit_cost', v_amount::text,
          'previous_unit_cost', case when v_current.id is null then null else v_current.unit_cost::text end,
          'dated', v_dated);
      end if;
    end loop;
  end loop;

  update public.import_batches
  set created_count = v_added + v_created, updated_count = v_replaced,
      rows_valid = jsonb_array_length(coalesce(p_rows, '[]'::jsonb))
  where id = v_batch.id;

  insert into public.audit_logs (business_id, actor_id, action, entity_type, entity_id, before_data, after_data)
  values (v_batch.business_id, null, 'product_cost.synced', 'import_batches', v_batch.id, null,
          jsonb_build_object('costs_added', v_added, 'costs_replaced', v_replaced,
                             'products_created', v_created, 'changes', v_changes,
                             'integration_account_id', v_batch.integration_account_id));

  return jsonb_build_object(
    'batch_id', v_batch.id, 'costs_added', v_added, 'costs_replaced', v_replaced,
    'products_created', v_created
  );
end;
$$;


-- ----------------------------------------------------------------------------
-- 6. The sync gates of 0021 and 0023, widened for the two datasets
-- ----------------------------------------------------------------------------
-- Copied verbatim from their latest definitions; only the list of resources
-- changes. Same signatures, so they are replaced in place and keep their
-- privileges.

create or replace function public.sync_record_state_commit(
  p_job_id  uuid,
  p_run_id  uuid,
  p_items   jsonb,
  p_pass_id text default null
)
returns integer
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_job   public.sync_jobs;
  v_count integer;
begin
  select * into v_job from public.sync_jobs where id = p_job_id;
  if v_job.id is null then
    raise exception 'No such sync job.' using errcode = 'P0002';
  end if;

  if v_job.resource not in ('ORDERS', 'PRODUCTS', 'EXPENSES', 'CATALOG', 'PRODUCT_COSTS') then
    raise exception 'Record state is kept only for orders, products, expenses, and product and cost tabs.'
      using errcode = 'P0001';
  end if;

  insert into public.integration_record_state (
    business_id, integration_account_id, entity, business_key, content_hash,
    last_outcome, locator, present, first_seen_at, last_seen_at,
    last_changed_at, last_seen_run_id, last_seen_pass
  )
  select
    v_job.business_id, v_job.integration_account_id, v_job.resource,
    d.item ->> 'key',
    d.item ->> 'hash',
    -- A brand-new record must say how it went. Defaulting to APPLIED would
    -- report a rejected row as imported.
    coalesce(nullif(d.item ->> 'outcome', ''), 'REJECTED'),
    coalesce(d.item -> 'locator', '{}'::jsonb),
    true, now(), now(), now(), p_run_id, p_pass_id
  from (
    select distinct on (e.item ->> 'key') e.item
    from jsonb_array_elements(coalesce(p_items, '[]'::jsonb)) as e(item)
    where nullif(e.item ->> 'key', '') is not null
      and nullif(e.item ->> 'hash', '') is not null
  ) d
  on conflict (integration_account_id, entity, business_key) do update set
    last_changed_at = case
      when public.integration_record_state.content_hash
           is distinct from excluded.content_hash then now()
      else public.integration_record_state.last_changed_at
    end,
    content_hash     = excluded.content_hash,
    -- NULL outcome = unchanged: keep what it was.
    last_outcome     = case
      when excluded.last_outcome is not null
           and public.integration_record_state.content_hash
               is distinct from excluded.content_hash
        then excluded.last_outcome
      else public.integration_record_state.last_outcome
    end,
    locator          = excluded.locator,
    present          = true,
    last_seen_at     = now(),
    last_seen_run_id = excluded.last_seen_run_id,
    last_seen_pass   = excluded.last_seen_pass;

  get diagnostics v_count = row_count;
  return v_count;
end;
$$;

create or replace function public.sync_record_issues(
  p_job_id      uuid,
  p_batch_id    uuid,
  p_issues      jsonb,
  p_rows_valid  integer default null,
  p_rows_failed integer default null
)
returns uuid
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_job     public.sync_jobs;
  v_batch   public.import_batches;
  v_channel uuid;
  v_type    public.channel_type;
  v_run     uuid;
begin
  select * into v_job from public.sync_jobs where id = p_job_id;
  if v_job.id is null then
    raise exception 'No such sync job.' using errcode = 'P0002';
  end if;

  if v_job.resource not in ('ORDERS', 'PRODUCTS', 'EXPENSES', 'CATALOG', 'PRODUCT_COSTS') then
    raise exception 'Row problems are recorded only for orders, products, expenses, and product and cost tabs.'
      using errcode = 'P0001';
  end if;

  if p_batch_id is not null then
    select * into v_batch from public.import_batches where id = p_batch_id;

    if v_batch.id is null
       or v_batch.business_id <> v_job.business_id
       or v_batch.integration_account_id is distinct from v_job.integration_account_id then
      raise exception 'That import batch does not belong to this sync.'
        using errcode = '42501';
    end if;
  else
    select a.channel_id into v_channel
    from public.integration_accounts a
    where a.id = v_job.integration_account_id;

    if v_channel is not null then
      select c.type into v_type from public.channels c where c.id = v_channel;
    end if;

    select r.id into v_run
    from public.sync_runs r
    where r.job_id = p_job_id and r.status = 'RUNNING'
    order by r.started_at desc
    limit 1;

    insert into public.import_batches (
      business_id, entity, status, source, channel_id, file_name, file_type,
      file_size_bytes, row_count, integration_account_id, sync_run_id,
      created_count, updated_count, error, committed_at
    )
    values (
      v_job.business_id, v_job.resource::public.import_entity, 'FAILED',
      coalesce(v_type, 'OTHER'::public.channel_type),
      case when v_job.resource = 'ORDERS' then v_channel end,
      'sync:' || v_job.resource, 'api', 0, 0,
      v_job.integration_account_id, v_run,
      0, 0,
      'None of the changed rows on this page could be imported. The problems are listed.',
      now()
    )
    returning * into v_batch;
  end if;

  update public.import_batches
  set rows_valid  = coalesce(p_rows_valid, rows_valid),
      rows_failed = coalesce(p_rows_failed, rows_failed)
  where id = v_batch.id;

  insert into public.import_issues (
    business_id, batch_id, row_number, severity, field, message, raw_value
  )
  select
    v_job.business_id,
    v_batch.id,
    coalesce((e.item ->> 'row_number')::integer, 0),
    case when e.item ->> 'severity' = 'WARNING' then 'WARNING' else 'ERROR' end,
    left(nullif(e.item ->> 'field', ''), 64),
    left(coalesce(nullif(e.item ->> 'message', ''), 'This row could not be imported.'), 1000),
    left(e.item ->> 'raw_value', 200)
  from jsonb_array_elements(coalesce(p_issues, '[]'::jsonb)) with ordinality as e(item, n)
  where e.n <= 500;

  return v_batch.id;
end;
$$;

create or replace function public.sync_reconcile_due(
  p_interval_minutes integer default 15,
  p_limit            integer default 50
)
returns integer
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_account uuid;
  v_entity  text;
  v_count   integer := 0;
begin
  for v_account, v_entity in
    select a.id, a.metadata ->> 'entity'
    from public.integration_accounts a
    where a.provider = 'GOOGLE_SHEETS'
      and a.status = 'CONNECTED'
      and a.metadata ->> 'entity' in ('ORDERS', 'PRODUCTS', 'EXPENSES', 'CATALOG', 'PRODUCT_COSTS')
      and coalesce(a.last_attempted_sync_at, a.connected_at)
            < now() - make_interval(mins => p_interval_minutes)
      and not exists (
        select 1 from public.sync_jobs j
        where j.integration_account_id = a.id
          and j.status in ('QUEUED', 'RUNNING', 'RETRYING', 'DEAD_LETTER')
      )
    order by coalesce(a.last_attempted_sync_at, a.connected_at)
    limit p_limit
  loop
    perform public.sync_enqueue_system(
      v_account, v_entity, 'RECONCILIATION'::public.sync_trigger, 0
    );
    v_count := v_count + 1;
  end loop;

  return v_count;
end;
$$;


-- ----------------------------------------------------------------------------
-- 7. Row Level Security and privileges
-- ----------------------------------------------------------------------------

alter table public.expense_categories enable row level security;
alter table public.expense_categories force row level security;
alter table public.expense_category_rules enable row level security;
alter table public.expense_category_rules force row level security;

create policy expense_categories_select_signed_in on public.expense_categories
  for select to authenticated using (true);

create policy expense_category_rules_select_member on public.expense_category_rules
  for select to authenticated
  using (business_id is null or business_id in (select public.current_user_business_ids()));

do $$
declare
  t text;
  f text;
begin
  foreach t in array array['expense_categories', 'expense_category_rules', 'expense_lines']
  loop
    execute format('revoke all on table public.%I from anon, authenticated, public', t);
    execute format('grant select on table public.%I to authenticated', t);
  end loop;

  foreach f in array array[
    'public.expense_summary(timestamptz, timestamptz, uuid)',
    'public.expense_breakdown(timestamptz, timestamptz, uuid)',
    'public.expense_periods(uuid)',
    'public.expense_category_queue(uuid)',
    'public.pnl_net_profit(timestamptz, timestamptz, uuid)',
    'public.expense_category_classify(uuid, text, text)',
    'public.expense_category_rule_retire(uuid)'
  ]
  loop
    execute format('revoke all on function %s from anon, public', f);
    execute format('grant execute on function %s to authenticated', f);
  end loop;

  -- Session-less writers: the sync worker only.
  foreach f in array array[
    'public.sync_dataset_batch(uuid, text, jsonb)',
    'public.sync_apply_catalog(uuid, jsonb)',
    'public.sync_apply_product_costs(uuid, jsonb)'
  ]
  loop
    execute format('revoke all on function %s from anon, authenticated, public', f);
    execute format('grant execute on function %s to service_role', f);
  end loop;

  revoke all on function public.expense_category_key(text) from anon, public;
  grant execute on function public.expense_category_key(text) to authenticated, service_role;
  revoke all on function public.expense_category_rule_guard() from anon, authenticated, public;
  revoke all on function public.import_batch_dataset_guard() from anon, authenticated, public;
end;
$$;


-- ----------------------------------------------------------------------------
-- 8. Self-verification
-- ----------------------------------------------------------------------------

do $$
declare
  t text;
  f text;
begin
  foreach t in array array['expense_categories', 'expense_category_rules']
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
    where n.nspname = 'public' and c.relname = 'expense_lines'
      and coalesce(c.reloptions, '{}') @> array['security_invoker=true']
  ) or has_table_privilege('anon', 'public.expense_lines', 'SELECT') then
    raise exception 'SECURITY: expense_lines must be an invoker view anon cannot read.';
  end if;

  foreach f in array array['expense_summary', 'expense_breakdown', 'expense_periods', 'expense_category_queue', 'pnl_net_profit']
  loop
    if exists (
      select 1 from pg_proc p join pg_namespace n on n.oid = p.pronamespace
      where n.nspname = 'public' and p.proname = f
        and (p.prosecdef or has_function_privilege('anon', p.oid, 'EXECUTE'))
    ) then
      raise exception 'SECURITY: %() must be SECURITY INVOKER and closed to anon.', f;
    end if;
  end loop;

  foreach f in array array['expense_category_classify', 'expense_category_rule_retire']
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

  foreach f in array array['sync_dataset_batch', 'sync_apply_catalog', 'sync_apply_product_costs']
  loop
    if exists (
      select 1 from pg_proc p join pg_namespace n on n.oid = p.pronamespace
      where n.nspname = 'public' and p.proname = f
        and (has_function_privilege('authenticated', p.oid, 'EXECUTE')
             or has_function_privilege('anon', p.oid, 'EXECUTE'))
    ) then
      raise exception 'SECURITY: %() must be callable by the sync worker only.', f;
    end if;
  end loop;

  foreach f in array array['sync_record_state_commit', 'sync_record_issues', 'sync_reconcile_due']
  loop
    if not exists (
      select 1 from pg_proc p join pg_namespace n on n.oid = p.pronamespace
      where n.nspname = 'public' and p.proname = f
        and position('''PRODUCT_COSTS''' in p.prosrc) > 0
        and not has_function_privilege('authenticated', p.oid, 'EXECUTE')
    ) then
      raise exception 'Sync gate %() was not widened, or is open to signed-in users.', f;
    end if;
  end loop;

  if (select count(*) from public.expense_categories) <> 16 then
    raise exception 'SELF-CHECK: expected 16 expense categories.';
  end if;
  if (select count(*) from public.expense_category_rules where business_id is null and status = 'ACTIVE') <> 75 then
    raise exception 'SELF-CHECK: expected 75 global expense category rules.';
  end if;
  if public.expense_category_key('  Office-Rent / DXB ') <> 'office rent dxb' then
    raise exception 'SELF-CHECK: expense_category_key does not behave as intended.';
  end if;

  raise notice 'Migration 0037 verified: expense classification and Net Profit invoker; dataset writers worker-only; sync gates widened.';
end;
$$;


commit;
