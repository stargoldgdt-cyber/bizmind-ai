-- ============================================================================
-- BizMind AI — Migration 0005: Historical cost stability
-- ============================================================================
--
-- FIXES A REAL CORRECTNESS BUG introduced in migration 0004.
--
-- Those import functions ended with two statements that copied the CURRENT
-- product catalogue cost into any order line that had none:
--
--     update public.order_items oi
--     set unit_cost = pv.unit_cost
--     ...
--     where oi.unit_cost is null and pv.unit_cost is not null;
--
-- That was wrong, and wrong in the most dangerous way this product can be
-- wrong: it produced a plausible number nobody would question.
--
-- WHY IT MATTERS
-- --------------
-- An order line's cost is a HISTORICAL SNAPSHOT — what the item actually cost
-- at the moment it was sold. Today's catalogue price is a different fact.
-- Copying one into the other means:
--
--   * A supplier price change silently rewrites last year's profit.
--   * Two people running the same report months apart get different answers.
--   * "Profit is overstated" warnings vanish without the gap being filled by
--     anything real — the number just stops admitting it is unknown.
--
-- Observed in Phase 5 testing: an order imported with no cost was given
-- 1500.00 from the catalogue, which turned an honest "cost unknown" into a
-- confident, invented margin.
--
-- THE RULE FROM NOW ON
-- --------------------
--   1. A cost in the imported file is stored on the line as the historical
--      snapshot.
--   2. No cost in the file means NO COST ON THE LINE. Nothing is copied in.
--   3. A line with no cost is marked `cost_missing` and reported as such.
--   4. Profit uses the order-line cost ONLY.
--   5. Changing a catalogue cost can never alter historical profit.
--   6. Any future "backfill historical costs" feature must be explicit,
--      previewed, audited, and never automatic.
--
-- What the import functions still do is link a line to its catalogue product
-- by SKU. That sets identity (`variant_id`, `product_id`) and touches no
-- money, so it cannot move a profit figure.
-- ============================================================================

begin;


-- ----------------------------------------------------------------------------
-- 1. Make "cost missing" a first-class fact
-- ----------------------------------------------------------------------------
-- Generated, not stored independently, so it can never drift out of step with
-- the column it describes. A null cost means the cost is genuinely unknown for
-- that sale — not zero, and not "look it up somewhere else".

alter table public.order_items
  add column cost_missing boolean
  generated always as (unit_cost is null) stored;

comment on column public.order_items.unit_cost is
  'Historical cost snapshot: what one unit cost AT THE TIME OF THIS SALE. '
  'Never populated from the current product catalogue. Null means unknown.';

comment on column public.order_items.cost_missing is
  'True when this line has no recorded cost, so any margin including it is '
  'overstated. Derived from unit_cost; cannot be set directly.';

-- Finding lines with no cost is the basis of the honesty warning on the
-- dashboard, and of any future explicit backfill tool.
create index order_items_cost_missing_idx
  on public.order_items (business_id)
  where unit_cost is null;


-- ----------------------------------------------------------------------------
-- 2. import_apply_orders — backfill removed
-- ----------------------------------------------------------------------------

create or replace function public.import_apply_orders(
  p_batch_id uuid,
  p_rows     jsonb
)
returns jsonb
language plpgsql
security invoker
set search_path = ''
as $$
declare
  v_batch          public.import_batches;
  v_row            jsonb;
  v_item           jsonb;
  v_customer_id    uuid;
  v_order_id       uuid;
  v_inserted       boolean;
  v_created        integer := 0;
  v_updated        integer := 0;
  v_items          integer := 0;
  v_customers      integer := 0;
  v_missing_cost   integer := 0;
  v_email          text;
begin
  v_batch := public.import_load_batch(p_batch_id);

  for v_row in select * from jsonb_array_elements(p_rows)
  loop
    v_customer_id := null;
    v_email := nullif(trim(v_row ->> 'customer_email'), '');

    if v_email is not null then
      insert into public.customers (business_id, email, full_name, source)
      values (
        v_batch.business_id,
        v_email,
        nullif(trim(v_row ->> 'customer_name'), ''),
        v_batch.source
      )
      on conflict (business_id, lower(email)) where email is not null
      do update set
        full_name = coalesce(public.customers.full_name, excluded.full_name)
      returning id, (xmax = 0) into v_customer_id, v_inserted;

      if v_inserted then
        v_customers := v_customers + 1;
      end if;
    end if;

    insert into public.orders (
      business_id, channel_id, customer_id, source, external_id, order_number,
      status, currency, subtotal, discount_total, tax_total, shipping_total,
      fee_total, total, placed_at
    )
    values (
      v_batch.business_id,
      v_batch.channel_id,
      v_customer_id,
      v_batch.source,
      v_row ->> 'external_id',
      nullif(trim(v_row ->> 'order_number'), ''),
      coalesce((v_row ->> 'status')::public.order_status, 'FULFILLED'),
      v_row ->> 'currency',
      coalesce((v_row ->> 'subtotal')::numeric, 0),
      coalesce((v_row ->> 'discount_total')::numeric, 0),
      coalesce((v_row ->> 'tax_total')::numeric, 0),
      coalesce((v_row ->> 'shipping_total')::numeric, 0),
      coalesce((v_row ->> 'fee_total')::numeric, 0),
      coalesce((v_row ->> 'total')::numeric, 0),
      (v_row ->> 'placed_at')::timestamptz
    )
    on conflict (business_id, source, external_id) where external_id is not null
    do update set
      channel_id     = excluded.channel_id,
      customer_id    = coalesce(excluded.customer_id, public.orders.customer_id),
      order_number   = coalesce(excluded.order_number, public.orders.order_number),
      status         = excluded.status,
      currency       = excluded.currency,
      subtotal       = excluded.subtotal,
      discount_total = excluded.discount_total,
      tax_total      = excluded.tax_total,
      shipping_total = excluded.shipping_total,
      fee_total      = excluded.fee_total,
      total          = excluded.total,
      placed_at      = excluded.placed_at
    returning id, (xmax = 0) into v_order_id, v_inserted;

    if v_inserted then
      v_created := v_created + 1;
    else
      v_updated := v_updated + 1;
    end if;

    delete from public.order_items where order_id = v_order_id;

    for v_item in select * from jsonb_array_elements(coalesce(v_row -> 'items', '[]'::jsonb))
    loop
      -- unit_cost is taken from the FILE and from nowhere else. A null here
      -- stays null: the cost of that sale is unknown, and the dashboard says
      -- so rather than borrowing a number from the catalogue.
      insert into public.order_items (
        business_id, order_id, sku, name, quantity, unit_price, unit_cost,
        discount, tax, line_total
      )
      values (
        v_batch.business_id,
        v_order_id,
        nullif(trim(v_item ->> 'sku'), ''),
        nullif(trim(v_item ->> 'name'), ''),
        (v_item ->> 'quantity')::numeric,
        coalesce((v_item ->> 'unit_price')::numeric, 0),
        (v_item ->> 'unit_cost')::numeric,
        coalesce((v_item ->> 'discount')::numeric, 0),
        coalesce((v_item ->> 'tax')::numeric, 0),
        coalesce((v_item ->> 'line_total')::numeric, 0)
      );

      v_items := v_items + 1;
      if (v_item ->> 'unit_cost') is null then
        v_missing_cost := v_missing_cost + 1;
      end if;
    end loop;
  end loop;

  -- Identity only. This links a line to its catalogue product so the product
  -- can be named and grouped later. It sets no money column, so it cannot
  -- change a profit figure.
  update public.order_items oi
  set variant_id = pv.id,
      product_id = pv.product_id
  from public.product_variants pv
  where pv.business_id = v_batch.business_id
    and oi.business_id = v_batch.business_id
    and oi.variant_id is null
    and oi.sku is not null
    and pv.sku = oi.sku;

  -- NOTE: there is deliberately NO statement here copying pv.unit_cost into
  -- oi.unit_cost. See the header of this migration.

  update public.import_batches
  set status        = 'COMPLETED',
      created_count = v_created,
      updated_count = v_updated,
      committed_at  = now()
  where id = p_batch_id;

  return jsonb_build_object(
    'orders_created',      v_created,
    'orders_updated',      v_updated,
    'items_written',       v_items,
    'customers_created',   v_customers,
    'items_missing_cost',  v_missing_cost
  );
end;
$$;


-- ----------------------------------------------------------------------------
-- 3. import_apply_products — backfill removed
-- ----------------------------------------------------------------------------
-- Importing or re-pricing the catalogue must not reach into finished orders.
-- This is the statement that made a supplier price change rewrite history.

create or replace function public.import_apply_products(
  p_batch_id uuid,
  p_rows     jsonb
)
returns jsonb
language plpgsql
security invoker
set search_path = ''
as $$
declare
  v_batch      public.import_batches;
  v_row        jsonb;
  v_product_id uuid;
  v_variant_id uuid;
  v_inserted   boolean;
  v_created    integer := 0;
  v_updated    integer := 0;
  v_stock      numeric;
begin
  v_batch := public.import_load_batch(p_batch_id);

  for v_row in select * from jsonb_array_elements(p_rows)
  loop
    insert into public.products (
      business_id, sku, name, description, category, brand
    )
    values (
      v_batch.business_id,
      v_row ->> 'sku',
      v_row ->> 'name',
      nullif(trim(v_row ->> 'description'), ''),
      nullif(trim(v_row ->> 'category'), ''),
      nullif(trim(v_row ->> 'brand'), '')
    )
    on conflict (business_id, sku) where sku is not null
    do update set
      name        = excluded.name,
      description = coalesce(excluded.description, public.products.description),
      category    = coalesce(excluded.category, public.products.category),
      brand       = coalesce(excluded.brand, public.products.brand)
    returning id, (xmax = 0) into v_product_id, v_inserted;

    if v_inserted then
      v_created := v_created + 1;
    else
      v_updated := v_updated + 1;
    end if;

    insert into public.product_variants (
      business_id, product_id, sku, name, unit_price, unit_cost, barcode
    )
    values (
      v_batch.business_id,
      v_product_id,
      v_row ->> 'sku',
      v_row ->> 'name',
      (v_row ->> 'unit_price')::numeric,
      (v_row ->> 'unit_cost')::numeric,
      nullif(trim(v_row ->> 'barcode'), '')
    )
    on conflict (business_id, sku) where sku is not null
    do update set
      name       = excluded.name,
      unit_price = coalesce(excluded.unit_price, public.product_variants.unit_price),
      unit_cost  = coalesce(excluded.unit_cost, public.product_variants.unit_cost),
      barcode    = coalesce(excluded.barcode, public.product_variants.barcode)
    returning id into v_variant_id;

    v_stock := (v_row ->> 'opening_stock')::numeric;

    if v_stock is not null then
      insert into public.inventory (business_id, variant_id, quantity_on_hand, reorder_point)
      values (
        v_batch.business_id,
        v_variant_id,
        v_stock,
        (v_row ->> 'reorder_point')::numeric
      )
      on conflict (business_id, variant_id, location)
      do update set
        quantity_on_hand = excluded.quantity_on_hand,
        reorder_point    = coalesce(excluded.reorder_point, public.inventory.reorder_point);

      insert into public.inventory_movements (
        business_id, variant_id, movement_type, quantity, unit_cost,
        reference_type, reference_id, note
      )
      values (
        v_batch.business_id, v_variant_id, 'INITIAL', v_stock,
        (v_row ->> 'unit_cost')::numeric,
        'import_batch', p_batch_id, 'Opening stock from file import'
      );
    end if;
  end loop;

  -- Identity only, as above. No money column is touched.
  update public.order_items oi
  set variant_id = pv.id,
      product_id = pv.product_id
  from public.product_variants pv
  where pv.business_id = v_batch.business_id
    and oi.business_id = v_batch.business_id
    and oi.variant_id is null
    and oi.sku is not null
    and pv.sku = oi.sku;

  -- NOTE: no statement copies a catalogue cost into a historical order line.
  -- Changing a product's cost must never move a past month's profit.

  update public.import_batches
  set status = 'COMPLETED', created_count = v_created,
      updated_count = v_updated, committed_at = now()
  where id = p_batch_id;

  return jsonb_build_object('products_created', v_created, 'products_updated', v_updated);
end;
$$;


-- ----------------------------------------------------------------------------
-- 4. Self-verification
-- ----------------------------------------------------------------------------
-- Guards against the backfill ever creeping back in. If either function
-- contains a statement assigning a catalogue cost to an order line, this
-- migration refuses to commit.

do $$
declare
  v_source text;
  fn       text;
begin
  foreach fn in array array['import_apply_orders', 'import_apply_products']
  loop
    select p.prosrc into v_source
    from pg_proc p
    join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'public' and p.proname = fn;

    if v_source ~* 'set\s+unit_cost\s*=\s*pv\.unit_cost' then
      raise exception
        'SAFETY: %() still copies a catalogue cost into order_items. '
        'Historical order profitability must not change when a product is re-priced.',
        fn;
    end if;
  end loop;

  if not exists (
    select 1 from information_schema.columns
    where table_schema = 'public'
      and table_name = 'order_items'
      and column_name = 'cost_missing'
  ) then
    raise exception 'order_items.cost_missing was not created';
  end if;

  raise notice
    'Migration 0005 verified: no catalogue-cost backfill remains, cost_missing present.';
end;
$$;


commit;
