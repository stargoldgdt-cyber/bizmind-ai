-- ============================================================================
-- BizMind AI — Migration 0004: Import pipeline
-- ============================================================================
--
-- File import is the FIRST CONNECTOR, not a one-off upload feature. Shopify,
-- WooCommerce and the REST connector will reuse everything downstream of the
-- mapping step:
--
--   Source ──► raw records ──► mapping ──► validation ──► normalisation
--                                                              │
--                                                              ▼
--                                          these functions ──► universal model
--
-- A file connector differs from Shopify in exactly two ways: how the raw
-- records are obtained, and whether the column mapping is chosen by the user
-- or fixed by the vendor. Nothing below this line knows or cares which.
--
-- WHY THE WRITES LIVE IN SQL
-- --------------------------
-- An import must be all-or-nothing. Half an import is worse than none: the
-- owner sees a number that is neither the old truth nor the new one. A
-- function body is a single transaction, so a failure on row 900 of 1000
-- leaves the database exactly as it was.
--
-- SECURITY INVOKER, so RLS applies. Crucially, `business_id` is read FROM THE
-- BATCH ROW, never from the caller's arguments — and the batch itself is only
-- visible to its own tenant. A caller therefore cannot import into a business
-- they do not belong to, even by passing another business's id.
--
-- IDEMPOTENCY
-- -----------
-- Re-importing the same file updates rather than duplicates, via the unique
-- keys already on the universal model. Order lines are replaced wholesale for
-- a re-imported order, because appending them would silently double the
-- quantities and therefore the cost of goods.
-- ============================================================================

begin;


-- ----------------------------------------------------------------------------
-- 1. Enumerations
-- ----------------------------------------------------------------------------

create type public.import_entity as enum ('ORDERS', 'PRODUCTS', 'EXPENSES');

create type public.import_status as enum (
  'DRAFT',      -- uploaded and parsed, awaiting a column mapping
  'READY',      -- mapped and validated, awaiting confirmation
  'COMPLETED',
  'FAILED',
  'CANCELLED'
);


-- ----------------------------------------------------------------------------
-- 2. Customer identity
-- ----------------------------------------------------------------------------
-- Email becomes the natural key for a buyer within a business, so importing
-- the same customer from two channels produces one customer rather than two.
-- Without this, repeat-rate and customer-value analytics would be wrong in a
-- way nobody would notice.

drop index if exists public.customers_email_idx;

create unique index customers_email_key
  on public.customers (business_id, lower(email))
  where email is not null;


-- ----------------------------------------------------------------------------
-- 3. import_batches
-- ----------------------------------------------------------------------------
-- One row per uploaded file. Holds the parsed rows so mapping and preview can
-- be re-run without re-uploading, and so a completed import stays auditable:
-- months later it is still possible to see exactly what was loaded and how it
-- was interpreted.

create table public.import_batches (
  id               uuid primary key default gen_random_uuid(),
  business_id      uuid not null references public.businesses (id) on delete cascade,
  created_by       uuid references public.profiles (id) on delete set null,

  entity           public.import_entity not null,
  status           public.import_status not null default 'DRAFT',

  -- Which channel the file represents. Part of the idempotency key, so a
  -- re-exported Amazon file updates the same orders rather than duplicating.
  source           public.channel_type,
  channel_id       uuid references public.channels (id) on delete set null,

  file_name        text not null,
  file_type        text not null check (file_type in ('csv', 'xlsx')),
  file_size_bytes  bigint not null check (file_size_bytes >= 0),

  columns          jsonb not null default '[]'::jsonb,
  raw_rows         jsonb not null default '[]'::jsonb,
  row_count        integer not null default 0,

  mapping          jsonb,
  options          jsonb,

  rows_valid       integer,
  rows_failed      integer,
  created_count    integer,
  updated_count    integer,
  error            text,

  created_at       timestamptz not null default now(),
  updated_at       timestamptz not null default now(),
  committed_at     timestamptz
);

comment on table public.import_batches is
  'One uploaded file. Retains the parsed rows and the mapping so an import '
  'remains auditable long after it completed.';

create index import_batches_business_idx
  on public.import_batches (business_id, created_at desc);

create trigger import_batches_set_updated_at
  before update on public.import_batches
  for each row execute function public.set_updated_at();


-- ----------------------------------------------------------------------------
-- 4. import_issues — row-level reporting
-- ----------------------------------------------------------------------------
-- "17 rows failed" is not useful. "Row 42: Order Date could not be read from
-- 03/04/2026 because the date format is ambiguous" is.

create table public.import_issues (
  id          uuid primary key default gen_random_uuid(),
  business_id uuid not null references public.businesses (id) on delete cascade,
  batch_id    uuid not null references public.import_batches (id) on delete cascade,
  row_number  integer not null,
  severity    text not null check (severity in ('ERROR', 'WARNING')),
  field       text,
  message     text not null,
  raw_value   text,
  created_at  timestamptz not null default now()
);

create index import_issues_batch_idx
  on public.import_issues (batch_id, row_number);


-- ----------------------------------------------------------------------------
-- 5. Row Level Security
-- ----------------------------------------------------------------------------
-- Same pattern as every other business-owned table. Importing writes business
-- data, so it needs STAFF or above; a VIEWER may look at the history.

do $$
declare
  t text;
begin
  foreach t in array array['import_batches', 'import_issues']
  loop
    execute format('alter table public.%I enable row level security', t);
    execute format('alter table public.%I force row level security', t);

    execute format($f$
      create policy %I on public.%I for select to authenticated
      using (business_id in (select public.current_user_business_ids()))
    $f$, t || '_select_member', t);

    execute format($f$
      create policy %I on public.%I for insert to authenticated
      with check (public.current_user_has_role(
        business_id, array['OWNER','ADMIN','STAFF']::public.business_role[]))
    $f$, t || '_insert_staff', t);

    execute format($f$
      create policy %I on public.%I for update to authenticated
      using (public.current_user_has_role(
        business_id, array['OWNER','ADMIN','STAFF']::public.business_role[]))
      with check (public.current_user_has_role(
        business_id, array['OWNER','ADMIN','STAFF']::public.business_role[]))
    $f$, t || '_update_staff', t);

    execute format($f$
      create policy %I on public.%I for delete to authenticated
      using (public.current_user_has_role(
        business_id, array['OWNER','ADMIN']::public.business_role[]))
    $f$, t || '_delete_admin', t);

    execute format('revoke all on public.%I from anon', t);
    execute format(
      'grant select, insert, update, delete on public.%I to authenticated', t);
  end loop;
end;
$$;


-- ----------------------------------------------------------------------------
-- 6. Shared guard
-- ----------------------------------------------------------------------------
-- Loads a batch and refuses if the caller cannot see it. Because the SELECT is
-- RLS-filtered, "not found" and "not yours" are the same answer — which is the
-- correct behaviour: it does not confirm that another tenant's batch exists.

create or replace function public.import_load_batch(p_batch_id uuid)
returns public.import_batches
language plpgsql
security invoker
set search_path = ''
as $$
declare
  v_batch public.import_batches;
begin
  select * into v_batch
  from public.import_batches
  where id = p_batch_id;

  if not found then
    raise exception 'Import batch not found.' using errcode = '42501';
  end if;

  if v_batch.status = 'COMPLETED' then
    raise exception 'This import has already been applied.' using errcode = 'P0001';
  end if;

  return v_batch;
end;
$$;


-- ----------------------------------------------------------------------------
-- 7. import_apply_orders
-- ----------------------------------------------------------------------------
-- Expects rows already validated and normalised by the application:
--
--   [{ external_id, order_number, placed_at, status, currency,
--      subtotal, discount_total, tax_total, shipping_total, fee_total, total,
--      customer_email, customer_name,
--      items: [{ sku, name, quantity, unit_price, unit_cost,
--                discount, tax, line_total }] }]

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
  v_email          text;
begin
  v_batch := public.import_load_batch(p_batch_id);

  for v_row in select * from jsonb_array_elements(p_rows)
  loop
    -- Resolve the buyer. Email is the natural key within a business, so the
    -- same person arriving from two channels stays one customer.
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

    -- Upsert the order. The conflict target matches the partial unique index
    -- created in migration 0002, which is what makes a re-import an update.
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

    -- Replace the lines rather than appending them. Appending on re-import
    -- would double the quantities, and therefore the cost of goods, producing
    -- a wrong margin that looks entirely plausible.
    delete from public.order_items where order_id = v_order_id;

    for v_item in select * from jsonb_array_elements(coalesce(v_row -> 'items', '[]'::jsonb))
    loop
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
    end loop;
  end loop;

  -- Link order lines to the catalogue where a SKU matches something already
  -- imported. Done as one statement afterwards rather than per row, and it
  -- deliberately does NOT invent products for unknown SKUs: a product needs a
  -- cost to be useful, and guessing one would corrupt every margin.
  update public.order_items oi
  set variant_id = pv.id,
      product_id = pv.product_id
  from public.product_variants pv
  where pv.business_id = v_batch.business_id
    and oi.business_id = v_batch.business_id
    and oi.variant_id is null
    and oi.sku is not null
    and pv.sku = oi.sku;

  -- Where a line has no cost of its own, inherit the catalogue cost. Only
  -- fills genuine gaps; an explicit cost from the file always wins, because
  -- it is the cost that actually applied at the time of sale.
  update public.order_items oi
  set unit_cost = pv.unit_cost
  from public.product_variants pv
  where pv.id = oi.variant_id
    and oi.business_id = v_batch.business_id
    and oi.unit_cost is null
    and pv.unit_cost is not null;

  update public.import_batches
  set status        = 'COMPLETED',
      created_count = v_created,
      updated_count = v_updated,
      committed_at  = now()
  where id = p_batch_id;

  return jsonb_build_object(
    'orders_created',    v_created,
    'orders_updated',    v_updated,
    'items_written',     v_items,
    'customers_created', v_customers
  );
end;
$$;


-- ----------------------------------------------------------------------------
-- 8. import_apply_products
-- ----------------------------------------------------------------------------
-- Every product gets exactly one variant, even with no options, so order
-- lines, stock and cost always attach to the same kind of record.

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
      -- A blank cost in the file must not erase a cost already recorded.
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

      -- Stock must be reconstructable by summing movements, so an opening
      -- balance is recorded as a movement rather than only as a level.
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

  -- Newly known costs backfill order lines that had none. Explicit costs
  -- already on a line are never overwritten.
  update public.order_items oi
  set variant_id = pv.id,
      product_id = pv.product_id
  from public.product_variants pv
  where pv.business_id = v_batch.business_id
    and oi.business_id = v_batch.business_id
    and oi.variant_id is null
    and oi.sku is not null
    and pv.sku = oi.sku;

  update public.order_items oi
  set unit_cost = pv.unit_cost
  from public.product_variants pv
  where pv.id = oi.variant_id
    and oi.business_id = v_batch.business_id
    and oi.unit_cost is null
    and pv.unit_cost is not null;

  update public.import_batches
  set status = 'COMPLETED', created_count = v_created,
      updated_count = v_updated, committed_at = now()
  where id = p_batch_id;

  return jsonb_build_object('products_created', v_created, 'products_updated', v_updated);
end;
$$;


-- ----------------------------------------------------------------------------
-- 9. import_apply_expenses
-- ----------------------------------------------------------------------------

create or replace function public.import_apply_expenses(
  p_batch_id uuid,
  p_rows     jsonb
)
returns jsonb
language plpgsql
security invoker
set search_path = ''
as $$
declare
  v_batch     public.import_batches;
  v_row       jsonb;
  v_external  text;
  v_inserted  boolean;
  v_created   integer := 0;
  v_updated   integer := 0;
begin
  v_batch := public.import_load_batch(p_batch_id);

  for v_row in select * from jsonb_array_elements(p_rows)
  loop
    v_external := nullif(trim(v_row ->> 'external_id'), '');

    if v_external is not null then
      insert into public.expenses (
        business_id, category, description, vendor, amount, currency,
        incurred_at, source, external_id
      )
      values (
        v_batch.business_id,
        coalesce(nullif(trim(v_row ->> 'category'), ''), 'Uncategorised'),
        nullif(trim(v_row ->> 'description'), ''),
        nullif(trim(v_row ->> 'vendor'), ''),
        (v_row ->> 'amount')::numeric,
        v_row ->> 'currency',
        (v_row ->> 'incurred_at')::timestamptz,
        v_batch.source,
        v_external
      )
      on conflict (business_id, source, external_id) where external_id is not null
      do update set
        category    = excluded.category,
        description = coalesce(excluded.description, public.expenses.description),
        vendor      = coalesce(excluded.vendor, public.expenses.vendor),
        amount      = excluded.amount,
        currency    = excluded.currency,
        incurred_at = excluded.incurred_at
      returning (xmax = 0) into v_inserted;

      if v_inserted then v_created := v_created + 1; else v_updated := v_updated + 1; end if;
    else
      -- With no reference of its own, an expense cannot be recognised on a
      -- second import. The application warns about this before committing.
      insert into public.expenses (
        business_id, category, description, vendor, amount, currency, incurred_at
      )
      values (
        v_batch.business_id,
        coalesce(nullif(trim(v_row ->> 'category'), ''), 'Uncategorised'),
        nullif(trim(v_row ->> 'description'), ''),
        nullif(trim(v_row ->> 'vendor'), ''),
        (v_row ->> 'amount')::numeric,
        v_row ->> 'currency',
        (v_row ->> 'incurred_at')::timestamptz
      );
      v_created := v_created + 1;
    end if;
  end loop;

  update public.import_batches
  set status = 'COMPLETED', created_count = v_created,
      updated_count = v_updated, committed_at = now()
  where id = p_batch_id;

  return jsonb_build_object('expenses_created', v_created, 'expenses_updated', v_updated);
end;
$$;


-- ----------------------------------------------------------------------------
-- 10. Privileges
-- ----------------------------------------------------------------------------

revoke all on function public.import_load_batch(uuid) from anon, public;
grant execute on function public.import_load_batch(uuid) to authenticated;

revoke all on function public.import_apply_orders(uuid, jsonb) from anon, public;
grant execute on function public.import_apply_orders(uuid, jsonb) to authenticated;

revoke all on function public.import_apply_products(uuid, jsonb) from anon, public;
grant execute on function public.import_apply_products(uuid, jsonb) to authenticated;

revoke all on function public.import_apply_expenses(uuid, jsonb) from anon, public;
grant execute on function public.import_apply_expenses(uuid, jsonb) to authenticated;


-- ----------------------------------------------------------------------------
-- 11. Self-verification
-- ----------------------------------------------------------------------------

do $$
declare
  t          text;
  v_rls      boolean;
  v_policies integer;
begin
  foreach t in array array['import_batches', 'import_issues']
  loop
    select c.relrowsecurity into v_rls
    from pg_class c join pg_namespace n on n.oid = c.relnamespace
    where n.nspname = 'public' and c.relname = t;

    if v_rls is not true then
      raise exception 'SECURITY: table public.% has RLS disabled', t;
    end if;

    select count(*) into v_policies
    from pg_policies where schemaname = 'public' and tablename = t;

    if v_policies <> 4 then
      raise exception 'SECURITY: table public.% has % policies, expected 4', t, v_policies;
    end if;
  end loop;

  raise notice 'Migration 0004 verified: import tables protected, apply functions installed.';
end;
$$;


commit;
