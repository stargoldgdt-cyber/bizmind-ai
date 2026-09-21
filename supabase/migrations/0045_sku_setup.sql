-- ============================================================================
-- 0045  SKU setup: automatic matching of identical SKUs, one-sheet Excel setup
-- ============================================================================
-- Built on 0035 (products, SKU mappings, dated costs). Owner decision
-- 2026-09-18: "set up once, BizMind remembers, only new SKUs need attention".
--
-- WHAT CHANGES
--   1. sku_aliases.method: MANUAL (a person on screen), EXCEL (a person, in a
--      setup sheet) or AUTOMATIC (identical SKU, below). Existing rows are
--      MANUAL. product_costs.source gains EXCEL.
--   2. sku_identity_key(): a SKU with spaces and dashes removed, in capitals.
--      Only those three differences are ignored (owner decision); dots,
--      slashes, underscores and extra words still make a SKU different.
--   3. sku_auto_match(business): matches every unmatched marketplace SKU whose
--      identity key equals exactly ONE product's own SKU code or ONE SKU a
--      person already matched (any marketplace). It never replaces a
--      confirmed mapping, never re-makes a pairing a person rejected, and
--      labels each match AUTOMATIC. Undo = reject the pairing (sku_alias_decide).
--      This narrows decision A10 as the owner approved: identical SKUs only;
--      similar-but-different SKUs stay suggestions.
--   4. sku_setup_rows(business, include_matched): the one-sheet template.
--   5. sku_setup_apply(business, rows): applies a filled sheet (OWNER/ADMIN):
--      finds or creates each product by its Product SKU, remembers each SKU's
--      product, and adds costs to the PRODUCT:
--        - a product with no cost in the currency: from the first day any of
--          its SKUs sold in that currency, so past months become complete;
--        - a product with a different cost in force: a new cost from today,
--          history untouched;
--        - the same cost as in force: nothing.
--      Rows that disagree (one Product SKU, two costs in a currency; one SKU,
--      two products) are refused as a whole call; the app removes them first.
--   6. sku_alias_decide() records method MANUAL (otherwise copied from 0035).
--   7. ledger_file_sku_summary(file): SKUs in one uploaded file, recognised or not.
--
-- Nothing in the ledger, classification, VAT or P&L changes. Costs are still
-- only added or withdrawn, never edited. Depends on 0030-0044.
-- APPLY THIS IN THE SUPABASE SQL EDITOR.
-- Clear the editor first: click in it, press Ctrl+A, then Delete.
-- ============================================================================

begin;


-- ----------------------------------------------------------------------------
-- 1. How a mapping was made; where a cost came from
-- ----------------------------------------------------------------------------

alter table public.sku_aliases
  add column method text not null default 'MANUAL' check (method in ('MANUAL', 'EXCEL', 'AUTOMATIC'));

comment on column public.sku_aliases.method is
  'MANUAL: decided by a person on screen. EXCEL: decided by a person in a setup sheet. '
  'AUTOMATIC: an identical SKU (spaces, dashes and capitals ignored) matched by BizMind; '
  'undone by rejecting the pairing.';

alter table public.product_costs drop constraint product_costs_source_check;
alter table public.product_costs add constraint product_costs_source_check
  check (source in ('MANUAL', 'SHEETS', 'EXCEL'));

comment on column public.product_costs.source is
  'MANUAL: entered on Products and costs. SHEETS: read from a connected Google Sheet. '
  'EXCEL: from an uploaded SKU setup sheet.';


-- ----------------------------------------------------------------------------
-- 2. Identity key
-- ----------------------------------------------------------------------------

create function public.sku_identity_key(p_value text)
returns text
language sql
immutable
parallel safe
set search_path = ''
as $$
  select upper(regexp_replace(coalesce(p_value, ''), '[[:space:]-]+', '', 'g'));
$$;

comment on function public.sku_identity_key(text) is
  'A SKU with spaces and dashes removed, in capitals. Two SKUs with the same key '
  'are the same SKU written differently; nothing else is treated as the same.';


-- ----------------------------------------------------------------------------
-- 3. Automatic matching of identical SKUs
-- ----------------------------------------------------------------------------

create function public.sku_auto_match(p_business_id uuid)
returns integer
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_match   record;
  v_id      uuid;
  v_matched integer := 0;
begin
  if (select auth.uid()) is null then
    raise exception 'Not authenticated.' using errcode = '28000';
  end if;
  if p_business_id is null or p_business_id not in (select public.current_user_business_ids()) then
    raise exception 'That business could not be found.' using errcode = 'P0002';
  end if;
  -- Anyone who can import may trigger it: it only applies the owner-approved
  -- identical-SKU rule, never a judgement (DECISIONS.md, 2026-09-18).
  if not public.current_user_has_role(p_business_id, array['OWNER', 'ADMIN', 'STAFF']::public.business_role[]) then
    raise exception 'A viewer cannot change SKU mappings.' using errcode = '42501';
  end if;

  for v_match in
    with unmatched as (
      select distinct a.marketplace_code, ft.raw_sku, public.sku_identity_key(ft.raw_sku) as key
      from public.financial_transactions ft
      join public.marketplace_accounts a on a.id = ft.marketplace_account_id
      where ft.business_id = p_business_id
        and ft.raw_sku is not null
        and public.sku_identity_key(ft.raw_sku) <> ''
        and not exists (
          select 1 from public.sku_aliases s
          where s.business_id = p_business_id and s.marketplace_code = a.marketplace_code
            and s.raw_sku = ft.raw_sku and s.status = 'CONFIRMED'
        )
    ),
    known as (
      select public.sku_identity_key(p.sku_code) as key, p.id as product_id
      from public.catalog_products p
      where p.business_id = p_business_id and p.status = 'ACTIVE' and p.sku_code is not null
      union
      select public.sku_identity_key(s.raw_sku), s.product_id
      from public.sku_aliases s
      join public.catalog_products p on p.id = s.product_id and p.status = 'ACTIVE'
      where s.business_id = p_business_id and s.status = 'CONFIRMED'
    ),
    candidates as (
      select u.marketplace_code, u.raw_sku, u.key, array_agg(distinct k.product_id) as products
      from unmatched u
      join known k on k.key = u.key
      group by u.marketplace_code, u.raw_sku, u.key
    )
    select c.marketplace_code, c.raw_sku, c.key, c.products[1] as product_id
    from candidates c
    where cardinality(c.products) = 1
      -- A pairing a person rejected is never made again.
      and not exists (
        select 1 from public.sku_aliases r
        where r.business_id = p_business_id and r.marketplace_code = c.marketplace_code
          and r.raw_sku = c.raw_sku and r.product_id = c.products[1] and r.status = 'REJECTED'
      )
  loop
    insert into public.sku_aliases (business_id, marketplace_code, raw_sku, product_id, status, note, decided_by, method)
    values (p_business_id, v_match.marketplace_code, v_match.raw_sku, v_match.product_id, 'CONFIRMED',
            'Matched automatically: identical SKU', null, 'AUTOMATIC')
    on conflict do nothing
    returning id into v_id;

    if v_id is not null then
      v_matched := v_matched + 1;
      perform public.write_audit_log(
        p_business_id, 'sku_alias.matched_automatically', 'sku_aliases', v_id, null,
        jsonb_build_object('marketplace_code', v_match.marketplace_code, 'raw_sku', v_match.raw_sku,
                           'product_id', v_match.product_id, 'identity_key', v_match.key)
      );
    end if;
    v_id := null;
  end loop;

  return v_matched;
end;
$$;


-- ----------------------------------------------------------------------------
-- 4. The one-sheet setup template
-- ----------------------------------------------------------------------------

create function public.sku_setup_rows(p_business_id uuid, p_include_matched boolean default false)
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
    count(*) filter (where l.is_cost_line)                                        as cost_lines,
    coalesce(sum(l.quantity::numeric) filter (where l.is_cost_line), 0)          as units,
    coalesce(sum(l.amount::numeric) filter (where l.metric_group in
      ('GROSS_SALES', 'SALES_REFUNDS', 'SELLER_DISCOUNTS')), 0)                  as net_sales,
    min((l.posted_at at time zone 'UTC')::date) filter (where l.is_cost_line)    as first_sold,
    (array_agg(l.source_row_id order by l.posted_at, l.line_index))[1]           as sample_row
  from public.ledger_product_lines l
  where l.business_id = p_business_id
    and l.raw_sku is not null
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


-- ----------------------------------------------------------------------------
-- 5. Applying a filled sheet (or one inline row)
-- ----------------------------------------------------------------------------
-- p_rows: [{ row, marketplace_code, raw_sku, product_id | product_sku,
--            product_name, unit_cost | null, currency | null }]
-- The app validates first and sends only rows that agree; this function checks
-- everything again and refuses a call that still disagrees.

create function public.sku_setup_apply(p_business_id uuid, p_rows jsonb)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_today       date := (now() at time zone 'UTC')::date;
  v_row         jsonb;
  v_rownum      integer;
  v_mc          text;
  v_sku         text;
  v_psku        text;
  v_pname       text;
  v_pid         uuid;
  v_product     public.catalog_products;
  v_existing    public.sku_aliases;
  v_alias_id    uuid;
  v_cost        record;
  v_current     numeric(20,4);
  v_has_cost    boolean;
  v_from        date;
  v_cost_id     uuid;
  v_conflict    text;
  v_created     integer := 0;
  v_matched     integer := 0;
  v_changed     integer := 0;
  v_unchanged   integer := 0;
  v_costs_added integer := 0;
  v_costs_same  integer := 0;
  v_backfilled  integer := 0;
  v_auto        integer := 0;
  v_products    jsonb := '{}'::jsonb;   -- row number -> product id
begin
  if (select auth.uid()) is null then
    raise exception 'Not authenticated.' using errcode = '28000';
  end if;
  if p_business_id is null or p_business_id not in (select public.current_user_business_ids()) then
    raise exception 'That business could not be found.' using errcode = 'P0002';
  end if;
  if not public.current_user_has_role(p_business_id, array['OWNER', 'ADMIN']::public.business_role[]) then
    raise exception 'Only an owner or admin can set up SKUs and costs.' using errcode = '42501';
  end if;
  if jsonb_typeof(p_rows) is distinct from 'array' or jsonb_array_length(p_rows) = 0 then
    raise exception 'There are no rows to apply.' using errcode = '22023';
  end if;
  if jsonb_array_length(p_rows) > 5000 then
    raise exception 'Apply at most 5,000 rows at a time.' using errcode = '22023';
  end if;

  if exists (
    select 1 from jsonb_array_elements(p_rows) r where coalesce(r ->> 'row', '') !~ '^[0-9]{1,6}$'
  ) or (select count(distinct r ->> 'row') from jsonb_array_elements(p_rows) r) <> jsonb_array_length(p_rows) then
    raise exception 'Every row needs its own row number.' using errcode = '22023';
  end if;

  -- Shape of every row.
  for v_row in select value from jsonb_array_elements(p_rows)
  loop
    if coalesce(v_row ->> 'raw_sku', '') = '' or coalesce(v_row ->> 'marketplace_code', '') = ''
       or (coalesce(btrim(v_row ->> 'product_sku'), '') = '' and coalesce(v_row ->> 'product_id', '') = '') then
      raise exception 'Row %: a marketplace, a marketplace SKU and a product are needed.', v_row ->> 'row'
        using errcode = '22023';
    end if;
    if v_row ->> 'unit_cost' is not null and (
         (v_row ->> 'unit_cost') !~ '^[0-9]{1,16}(\.[0-9]{1,4})?$'
         or coalesce(v_row ->> 'currency', '') !~ '^[A-Z]{3}$') then
      raise exception 'Row %: the cost must be a plain number with a currency.', v_row ->> 'row'
        using errcode = '22023';
    end if;
    if not exists (
      select 1 from public.financial_transactions ft
      join public.marketplace_accounts a on a.id = ft.marketplace_account_id
      where ft.business_id = p_business_id and a.marketplace_code = v_row ->> 'marketplace_code'
        and ft.raw_sku = v_row ->> 'raw_sku'
    ) then
      raise exception 'Row %: SKU "%" does not appear in your marketplace files.', v_row ->> 'row', v_row ->> 'raw_sku'
        using errcode = 'P0002';
    end if;
  end loop;

  -- One Product SKU, two costs in one currency: refused.
  select string_agg(distinct btrim(r ->> 'product_sku'), ', ') into v_conflict
  from jsonb_array_elements(p_rows) r
  where r ->> 'unit_cost' is not null and coalesce(btrim(r ->> 'product_sku'), '') <> ''
  group by public.sku_normalize(r ->> 'product_sku'), r ->> 'currency'
  having count(distinct (r ->> 'unit_cost')::numeric(20,4)) > 1
  limit 1;
  if v_conflict is not null then
    raise exception 'Product SKU % has different costs in the sheet. Keep one cost per product and currency.', v_conflict
      using errcode = '22023';
  end if;

  -- One marketplace SKU, two products: refused.
  select r ->> 'raw_sku' into v_conflict
  from jsonb_array_elements(p_rows) r
  group by r ->> 'marketplace_code', r ->> 'raw_sku'
  having count(distinct coalesce(r ->> 'product_id', public.sku_normalize(r ->> 'product_sku'))) > 1
  limit 1;
  if v_conflict is not null then
    raise exception 'Marketplace SKU % is given two different products. A SKU is one product.', v_conflict
      using errcode = '22023';
  end if;

  -- Products and mappings.
  for v_row in select value from jsonb_array_elements(p_rows)
  loop
    v_rownum := (v_row ->> 'row')::integer;
    v_mc     := v_row ->> 'marketplace_code';
    v_sku    := v_row ->> 'raw_sku';
    v_psku   := nullif(btrim(v_row ->> 'product_sku'), '');
    v_pname  := nullif(btrim(v_row ->> 'product_name'), '');

    if coalesce(v_row ->> 'product_id', '') <> '' then
      select * into v_product from public.catalog_products p
      where p.id = (v_row ->> 'product_id')::uuid and p.business_id = p_business_id;
    else
      select * into v_product from public.catalog_products p
      where p.business_id = p_business_id and p.sku_code is not null
        and public.sku_normalize(p.sku_code) = public.sku_normalize(v_psku);
      if v_product.id is null then
        if public.sku_normalize(v_psku) = '' then
          raise exception 'Row %: the Product SKU needs letters or digits.', v_rownum using errcode = '22023';
        end if;
        begin
          insert into public.catalog_products (business_id, name, sku_code)
          values (p_business_id, coalesce(v_pname, v_psku), v_psku)
          returning * into v_product;
        exception
          when check_violation then
            raise exception 'Row %: check the Product SKU and Product Name (no email addresses, not too long).', v_rownum
              using errcode = '23514';
        end;
        v_created := v_created + 1;
        perform public.write_audit_log(
          p_business_id, 'catalog_product.created', 'catalog_products', v_product.id, null,
          jsonb_build_object('name', v_product.name, 'sku_code', v_product.sku_code, 'via', 'SKU setup sheet')
        );
      end if;
    end if;

    if v_product.id is null then
      raise exception 'Row %: that product could not be found.', v_rownum using errcode = 'P0002';
    end if;
    if v_product.status <> 'ACTIVE' then
      raise exception 'Row %: product % is archived. Restore it first.', v_rownum, coalesce(v_product.sku_code, v_product.name)
        using errcode = '22023';
    end if;
    v_products := v_products || jsonb_build_object(v_rownum::text, v_product.id);

    select * into v_existing from public.sku_aliases s
    where s.business_id = p_business_id and s.marketplace_code = v_mc and s.raw_sku = v_sku and s.status = 'CONFIRMED';

    if v_existing.id is not null and v_existing.product_id = v_product.id then
      v_unchanged := v_unchanged + 1;
    else
      -- A person's decision in the sheet: replaces an earlier mapping (a bulk
      -- correction) and overrides an earlier rejection of this pairing.
      if v_existing.id is not null then
        update public.sku_aliases s
        set status = 'REJECTED', decided_by = (select auth.uid()), decided_at = now(),
            note = 'Replaced in a SKU setup sheet'
        where s.id = v_existing.id;
        v_changed := v_changed + 1;
      else
        v_matched := v_matched + 1;
      end if;

      insert into public.sku_aliases (business_id, marketplace_code, raw_sku, product_id, status, note, decided_by, method)
      values (p_business_id, v_mc, v_sku, v_product.id, 'CONFIRMED', null, (select auth.uid()), 'EXCEL')
      on conflict (business_id, marketplace_code, raw_sku, product_id)
      do update set status = 'CONFIRMED', note = null, decided_by = excluded.decided_by,
                    decided_at = now(), method = 'EXCEL'
      returning id into v_alias_id;

      perform public.write_audit_log(
        p_business_id, 'sku_alias.decided', 'sku_aliases', v_alias_id,
        case when v_existing.id is null then null
             else jsonb_build_object('product_id', v_existing.product_id, 'method', v_existing.method) end,
        jsonb_build_object('marketplace_code', v_mc, 'raw_sku', v_sku, 'product_id', v_product.id,
                           'status', 'CONFIRMED', 'method', 'EXCEL')
      );
    end if;
  end loop;

  -- Costs, once per product and currency.
  for v_cost in
    select distinct (v_products ->> (r ->> 'row'))::uuid as product_id,
           r ->> 'currency' as currency,
           (r ->> 'unit_cost')::numeric(20,4) as unit_cost
    from jsonb_array_elements(p_rows) r
    where r ->> 'unit_cost' is not null
  loop
    select exists (
      select 1 from public.product_costs c
      where c.product_id = v_cost.product_id and c.currency = v_cost.currency and c.retired_at is null
    ) into v_has_cost;

    if not v_has_cost then
      -- First cost: from the first day any of the product's SKUs sold in this
      -- currency, so every past month gets its cost (decision B7 backfill).
      select min((l.posted_at at time zone 'UTC')::date) into v_from
      from public.ledger_product_lines l
      where l.business_id = p_business_id and l.product_id = v_cost.product_id
        and l.currency = v_cost.currency and l.is_cost_line;
      v_from := least(coalesce(v_from, v_today), v_today);
    else
      select c.unit_cost into v_current
      from public.product_costs c
      where c.product_id = v_cost.product_id and c.currency = v_cost.currency and c.retired_at is null
        and c.effective_from <= v_today
      order by c.effective_from desc, c.created_at desc
      limit 1;
      if v_current is not null and v_current = v_cost.unit_cost then
        v_costs_same := v_costs_same + 1;
        continue;
      end if;
      -- A different cost: from today. History is never rewritten.
      v_from := v_today;
    end if;

    insert into public.product_costs (business_id, product_id, currency, unit_cost, effective_from, note, created_by, source)
    values (p_business_id, v_cost.product_id, v_cost.currency, v_cost.unit_cost, v_from,
            'From a SKU setup sheet', (select auth.uid()), 'EXCEL')
    returning id into v_cost_id;
    v_costs_added := v_costs_added + 1;
    if v_from < v_today then
      v_backfilled := v_backfilled + 1;
    end if;

    perform public.write_audit_log(
      p_business_id, 'product_cost.added', 'product_costs', v_cost_id, null,
      jsonb_build_object('product_id', v_cost.product_id, 'currency', v_cost.currency,
                         'unit_cost', v_cost.unit_cost::text, 'effective_from', v_from,
                         'backdated', v_from < v_today, 'via', 'SKU setup sheet')
    );
    v_current := null;
  end loop;

  -- New products and mappings can make other SKUs identical to a known one.
  v_auto := public.sku_auto_match(p_business_id);

  return jsonb_build_object(
    'products_created', v_created,
    'skus_matched', v_matched,
    'skus_changed', v_changed,
    'skus_unchanged', v_unchanged,
    'costs_added', v_costs_added,
    'costs_backfilled', v_backfilled,
    'costs_unchanged', v_costs_same,
    'matched_automatically', v_auto
  );
end;
$$;


-- ----------------------------------------------------------------------------
-- 6. sku_alias_decide(): a person's decision is MANUAL (otherwise 0035's)
-- ----------------------------------------------------------------------------

create or replace function public.sku_alias_decide(
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
    insert into public.sku_aliases (business_id, marketplace_code, raw_sku, product_id, status, note, decided_by, method)
    values (p_business_id, p_marketplace_code, p_raw_sku, p_product_id, p_decision,
            nullif(trim(coalesce(p_note, '')), ''), (select auth.uid()), 'MANUAL')
    on conflict (business_id, marketplace_code, raw_sku, product_id)
    do update set status = excluded.status, note = excluded.note,
                  decided_by = excluded.decided_by, decided_at = now(), method = 'MANUAL'
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


-- ----------------------------------------------------------------------------
-- 7. SKUs in one uploaded file
-- ----------------------------------------------------------------------------

create function public.ledger_file_sku_summary(p_source_file_id uuid)
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
    select distinct a.marketplace_code, ft.business_id, ft.raw_sku
    from public.financial_transactions ft
    join public.marketplace_accounts a on a.id = ft.marketplace_account_id
    where ft.source_file_id = p_source_file_id and ft.raw_sku is not null
  )
  select
    count(*),
    count(s.id),
    count(s.id) filter (where s.method = 'AUTOMATIC'),
    count(*) - count(s.id)
  from skus k
  left join public.sku_aliases s
    on s.business_id = k.business_id and s.marketplace_code = k.marketplace_code
   and s.raw_sku = k.raw_sku and s.status = 'CONFIRMED';
$$;


-- ----------------------------------------------------------------------------
-- 8. Privileges and self-verification
-- ----------------------------------------------------------------------------

do $$
declare
  f text;
begin
  foreach f in array array[
    'public.sku_identity_key(text)',
    'public.sku_auto_match(uuid)',
    'public.sku_setup_rows(uuid, boolean)',
    'public.sku_setup_apply(uuid, jsonb)',
    'public.ledger_file_sku_summary(uuid)'
  ]
  loop
    execute format('revoke all on function %s from anon, public', f);
    execute format('grant execute on function %s to authenticated', f);
  end loop;
end;
$$;

do $$
begin
  if public.sku_identity_key('sg-T84D b Blue  Fog-FBA') <> 'SGT84DBBLUEFOGFBA'
     or public.sku_identity_key('SG.T84D') = public.sku_identity_key('SGT84D')
     or public.sku_identity_key('SG_T84D') = public.sku_identity_key('SGT84D')
     or public.sku_identity_key('SG-T84D B Blue Fog FBA') = public.sku_identity_key('SG-T84D') then
    raise exception 'SELF-CHECK: sku_identity_key ignores more than spaces, dashes and capitals.';
  end if;
  if exists (
    select 1 from pg_proc p join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'public'
      and p.proname in ('sku_identity_key', 'sku_auto_match', 'sku_setup_rows', 'sku_setup_apply', 'ledger_file_sku_summary')
      and has_function_privilege('anon', p.oid, 'EXECUTE')
  ) then
    raise exception 'SECURITY: a SKU setup function is open to anon.';
  end if;
  if exists (
    select 1 from pg_proc p join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'public' and p.proname in ('sku_setup_rows', 'ledger_file_sku_summary') and p.prosecdef
  ) then
    raise exception 'SECURITY: the SKU setup readers must be SECURITY INVOKER.';
  end if;
  if exists (select 1 from public.sku_aliases where method <> 'MANUAL') then
    raise exception 'SELF-CHECK: existing mappings must all start as MANUAL.';
  end if;
  raise notice 'Migration 0045 verified: identical-SKU matching and one-sheet SKU setup.';
end;
$$;

commit;
