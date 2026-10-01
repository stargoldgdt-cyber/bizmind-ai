-- ============================================================================
-- 0054  SKU setup: close a cost-coverage gap left by matching SKUs later
-- ============================================================================
-- Real bug, found from the owner's live data (2026-09-26): Noon.ae, May 2026
-- showed "4 unit(s) sold of products with no cost" (AED 1,386.00) on
-- Marketplace P&L, while Products and costs said every SKU was matched and
-- nothing needed attention. Both screens were telling the truth about
-- DIFFERENT things -- SKU mapping was complete, cost DATE COVERAGE was not --
-- but the gap was real and had no page to fix it from. Root cause traced to
-- sku_setup_apply() (migration 0045):
--
--   1. A product's FIRST cost, for a currency, is correctly backfilled to the
--      earliest sale among whatever SKUs are matched to it AT THAT MOMENT
--      (line ~450, unchanged here).
--   2. When MORE marketplace SKUs are matched to that SAME product LATER (a
--      separate sheet, days or months after), and the sheet's cost for them
--      is the SAME value already on file, the function took a silent
--      "nothing changed" shortcut and never re-checked whether those newly
--      matched SKUs carry sales from BEFORE the cost's effective_from.
--
-- Confirmed in the owner's own data: product VT-A388 got its first cost
-- (220 AED) on 2026-09-19, backfilled to 2026-05-31 -- correct for the one
-- Amazon SKU matched that day. Two noon.ae SKUs were matched two days later
-- (2026-09-21) with sales back to 2026-01-28, at the SAME 220 AED, so the
-- "cost unchanged" branch skipped them -- leaving January through May
-- permanently uncosted with no page ever pointing at it.
--
-- THE FIX (one behavioural change, everything else copied verbatim from
-- 0045): when a batch's cost for a product+currency matches what is already
-- on file, the function now ALSO checks whether that product+currency has
-- any currently uncosted line (cogs_status = 'NO_COST' on
-- ledger_product_lines -- the exact same signal Marketplace P&L already
-- reads, so this can never disagree with what the owner sees there). If it
-- does, it backfills ONE MORE cost row, same value, dated to the earliest
-- uncosted sale -- closing exactly the gap that exists, nothing more. A
-- genuinely DIFFERENT cost still only ever applies from today (B7: history
-- is never rewritten by a price change) -- that branch is untouched.
--
-- The ledger stays untouched; this only adds a `product_costs` row, exactly
-- as a person adding a backdated cost by hand already could (product_costs
-- rows are add-only -- "a cost can only be withdrawn, never edited").
-- Same signature (uuid, jsonb), same SECURITY DEFINER, same role checks.
-- APPLY THIS IN THE SUPABASE SQL EDITOR.
-- Clear the editor first: click in it, press Ctrl+A, then Delete.
-- ============================================================================

begin;

drop function public.sku_setup_apply(uuid, jsonb);

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
  -- 0054: the earliest still-uncosted sale for a product+currency, if any.
  v_gap_from    date;
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
        -- 0054: the sheet's cost for this product+currency matches what is
        -- already on file -- but a SKU newly matched in THIS batch (or an
        -- earlier one) may carry sales from before that cost's
        -- effective_from, which the old code never re-checked once a cost
        -- already existed. cogs_status = 'NO_COST' is the exact same signal
        -- Marketplace P&L already reads, so this can never disagree with
        -- what the owner sees there. Close a real gap; do nothing when there
        -- is none.
        select min((l.posted_at at time zone 'UTC')::date) into v_gap_from
        from public.ledger_product_lines l
        where l.business_id = p_business_id and l.product_id = v_cost.product_id
          and l.currency = v_cost.currency and l.is_cost_line and l.cogs_status = 'NO_COST';

        if v_gap_from is not null then
          insert into public.product_costs (business_id, product_id, currency, unit_cost, effective_from, note, created_by, source)
          values (p_business_id, v_cost.product_id, v_cost.currency, v_cost.unit_cost, v_gap_from,
                  'Backfilled: a SKU matched later had earlier, uncosted sales at the same cost', (select auth.uid()), 'EXCEL')
          returning id into v_cost_id;
          v_costs_added := v_costs_added + 1;
          v_backfilled := v_backfilled + 1;
          perform public.write_audit_log(
            p_business_id, 'product_cost.added', 'product_costs', v_cost_id, null,
            jsonb_build_object('product_id', v_cost.product_id, 'currency', v_cost.currency,
                               'unit_cost', v_cost.unit_cost::text, 'effective_from', v_gap_from,
                               'backdated', true, 'via', 'SKU setup sheet (gap backfill, 0054)')
          );
        else
          v_costs_same := v_costs_same + 1;
        end if;
        v_current := null;
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

-- Re-close the function: DROP + CREATE resets Postgres's default grant
-- (EXECUTE to PUBLIC). Restores the exact grant 0045 set: authenticated only.
revoke all on function public.sku_setup_apply(uuid, jsonb) from anon, public;
grant execute on function public.sku_setup_apply(uuid, jsonb) to authenticated;

comment on function public.sku_setup_apply(uuid, jsonb) is
  'Applies a filled SKU setup sheet: matches SKUs to products and records their costs (OWNER/ADMIN only). '
  'A cost''s first backfill covers every SKU matched to the product AT THAT TIME; 0054 also closes a gap left '
  'when more SKUs, with earlier sales at the SAME cost, are matched to the product in a later sheet.';

do $$
begin
  if exists (
    select 1 from pg_proc p join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'public' and p.proname = 'sku_setup_apply'
      and (not p.prosecdef or has_function_privilege('anon', p.oid, 'EXECUTE'))
  ) then
    raise exception 'SECURITY: sku_setup_apply must stay SECURITY DEFINER and closed to anon.';
  end if;
  raise notice 'Migration 0054 verified: sku_setup_apply now closes a cost-coverage gap left by SKUs matched later.';
end;
$$;

-- ----------------------------------------------------------------------------
-- One-time repair: the fixed function above only protects a SHEET APPLIED
-- FROM NOW ON. It cannot reach back and fix a gap a sheet already left behind
-- before today. This closes those, for every business on the platform (the
-- same bug could have hit any seller who matched more SKUs to an
-- already-costed product in a later sheet, not only this one business) --
-- inserting EXACTLY the row sku_setup_apply() would insert itself if the same
-- sheet were re-applied today: one new product_costs row, same value already
-- on file, dated to the earliest still-uncosted sale. Nothing is edited or
-- deleted; a cost can only be added, per the existing rule.
-- ----------------------------------------------------------------------------
do $$
declare
  v_gap      record;
  v_cost_id  uuid;
  v_repaired integer := 0;
begin
  for v_gap in
    select
      l.business_id,
      l.product_id,
      l.currency,
      min((l.posted_at at time zone 'UTC')::date) as gap_from,
      (
        select c.unit_cost from public.product_costs c
        where c.product_id = l.product_id and c.currency = l.currency and c.retired_at is null
        order by c.effective_from asc, c.created_at asc
        limit 1
      ) as unit_cost
    from public.ledger_product_lines l
    where l.is_cost_line
      and l.cogs_status = 'NO_COST'
      and exists (
        select 1 from public.product_costs c
        where c.product_id = l.product_id and c.currency = l.currency and c.retired_at is null
      )
    group by l.business_id, l.product_id, l.currency
  loop
    insert into public.product_costs (business_id, product_id, currency, unit_cost, effective_from, note, created_by, source)
    values (
      v_gap.business_id, v_gap.product_id, v_gap.currency, v_gap.unit_cost, v_gap.gap_from,
      'Backfilled: a SKU matched later had earlier, uncosted sales at the same cost (0054 one-time repair)',
      null, 'EXCEL'
    )
    returning id into v_cost_id;

    -- write_audit_log() requires a signed-in auth.uid() (it stamps the actor
    -- from the session and re-checks business membership) -- neither exists
    -- in a raw SQL Editor run, so this writes audit_logs directly instead.
    -- actor_id null marks it as a system action, not a person's click.
    insert into public.audit_logs (business_id, actor_id, action, entity_type, entity_id, before_data, after_data)
    values (
      v_gap.business_id, null, 'product_cost.added', 'product_costs', v_cost_id, null,
      jsonb_build_object('product_id', v_gap.product_id, 'currency', v_gap.currency,
                         'unit_cost', v_gap.unit_cost::text, 'effective_from', v_gap.gap_from,
                         'backdated', true, 'via', '0054 one-time repair')
    );
    v_repaired := v_repaired + 1;
  end loop;
  raise notice '0054 one-time repair: % cost-coverage gap(s) closed.', v_repaired;
end;
$$;

commit;
