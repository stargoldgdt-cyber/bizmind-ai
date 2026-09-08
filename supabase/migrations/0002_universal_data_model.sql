-- ============================================================================
-- BizMind AI — Migration 0002: Universal data model
-- ============================================================================
--
-- The vendor-neutral shape every integration normalises into. Shopify,
-- WooCommerce, a CSV import and a manual entry all land in these same tables,
-- so analytics and AI never learn what "Shopify" is.
--
--   channels ──┐
--              ├──► orders ──► order_items ──► product_variants ──► products
--   customers ─┘      │                              │
--                     ├──► payments                  └──► inventory
--                     └──► returns                          │
--                                                inventory_movements
--   expenses          (standalone)
--   audit_logs        (cross-cutting)
--
-- WHAT IS DELIBERATELY NOT HERE
-- -----------------------------
-- integrations, sync_jobs, sync_logs   → Phases 9–12
-- ai_insights, ai_conversations        → Phase 8
-- alerts, automation_rules             → Phase 13
--
-- Those are designed when their phase arrives, so the design is informed by
-- real requirements rather than guessed at now.
--
-- MONEY
-- -----
-- All money is `numeric(20,4)`. NEVER float or double — binary floating point
-- cannot represent 0.10 exactly, and errors compound across aggregation.
-- `numeric` is exact decimal arithmetic in PostgreSQL.
--
-- All financial arithmetic happens in SQL, never in JavaScript. This is the
-- same rule that keeps the AI away from calculations: the database computes
-- the number, everything else only displays it.
--
-- QUANTITIES
-- ----------
-- Also `numeric(20,4)`, not integer — goods are sold by weight and volume as
-- well as by the piece.
--
-- SYNCED RECORDS
-- --------------
-- Rows that originate in an external system carry `source` and `external_id`.
-- The unique index on (business_id, source, external_id) makes re-syncing
-- idempotent: importing the same order twice updates it rather than
-- duplicating it. This is what makes a sync safe to retry.
--
-- Each such table also carries `..._external_needs_source`, a check
-- constraint requiring `source` whenever `external_id` is set. This is not
-- bureaucracy: in a unique index, NULL never equals NULL, so two rows with
-- (business, NULL, 'order-123') would NOT collide and the idempotency
-- guarantee would silently disappear. The constraint keeps it real.
--
-- ATOMICITY
-- ---------
-- The whole migration runs inside one transaction. If ANY statement fails --
-- including the self-verification at the end -- every change is rolled back
-- and the database is left exactly as it was. A migration that half-applies
-- is far worse than one that cleanly refuses.
-- ============================================================================

begin;


-- ----------------------------------------------------------------------------
-- 1. Enumerations
-- ----------------------------------------------------------------------------

create type public.channel_type as enum (
  'WEBSITE', 'SHOPIFY', 'WOOCOMMERCE', 'AMAZON', 'DARAZ',
  'EBAY', 'FACEBOOK', 'INSTAGRAM', 'POS', 'MANUAL', 'OTHER'
);

create type public.order_status as enum (
  'PENDING', 'CONFIRMED', 'FULFILLED', 'CANCELLED', 'REFUNDED', 'PARTIALLY_REFUNDED'
);

create type public.payment_status as enum (
  'PENDING', 'PAID', 'FAILED', 'REFUNDED', 'PARTIALLY_REFUNDED'
);

create type public.return_status as enum (
  'REQUESTED', 'APPROVED', 'RECEIVED', 'REFUNDED', 'REJECTED'
);

create type public.inventory_movement_type as enum (
  'PURCHASE', 'SALE', 'RETURN', 'ADJUSTMENT', 'TRANSFER', 'DAMAGE', 'INITIAL'
);


-- ----------------------------------------------------------------------------
-- 2. channels — where a sale came from
-- ----------------------------------------------------------------------------
-- Channel profitability is a core product promise, so every order must be
-- attributable to exactly one channel.

create table public.channels (
  id          uuid primary key default gen_random_uuid(),
  business_id uuid not null references public.businesses (id) on delete cascade,
  name        text not null check (length(trim(name)) between 1 and 80),
  type        public.channel_type not null default 'OTHER',
  is_active   boolean not null default true,
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now(),
  unique (business_id, name)
);

comment on table public.channels is
  'A sales channel: website, marketplace, social, POS. Orders attribute here.';


-- ----------------------------------------------------------------------------
-- 3. customers
-- ----------------------------------------------------------------------------

create table public.customers (
  id          uuid primary key default gen_random_uuid(),
  business_id uuid not null references public.businesses (id) on delete cascade,
  source      public.channel_type,
  external_id text,
  email       text,
  phone       text,
  full_name   text,
  city        text,
  country     text,
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now(),
  -- A unique index treats NULL as distinct, so an external_id with no
  -- source would defeat idempotent re-syncing. Require both together.
  constraint customers_external_needs_source
    check (external_id is null or source is not null)
);

comment on table public.customers is
  'A buyer. Repeat-rate and customer-value analytics resolve through here.';

create index customers_business_idx on public.customers (business_id);
create index customers_email_idx on public.customers (business_id, lower(email))
  where email is not null;

-- Makes re-importing the same customer an update, not a duplicate.
create unique index customers_external_key
  on public.customers (business_id, source, external_id)
  where external_id is not null;


-- ----------------------------------------------------------------------------
-- 4. products and variants
-- ----------------------------------------------------------------------------
-- A product is the thing being sold; a variant is the specific sellable unit
-- (size, colour, pack). Even a product with no options gets one variant, so
-- order lines, stock and cost always attach to the same kind of record rather
-- than sometimes a product and sometimes a variant.

create table public.products (
  id          uuid primary key default gen_random_uuid(),
  business_id uuid not null references public.businesses (id) on delete cascade,
  source      public.channel_type,
  external_id text,
  sku         text,
  name        text not null check (length(trim(name)) between 1 and 300),
  description text,
  category    text,
  brand       text,
  is_active   boolean not null default true,
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now(),
  -- A unique index treats NULL as distinct, so an external_id with no
  -- source would defeat idempotent re-syncing. Require both together.
  constraint products_external_needs_source
    check (external_id is null or source is not null)
);

create index products_business_idx on public.products (business_id);
create index products_category_idx on public.products (business_id, category)
  where category is not null;

create unique index products_sku_key
  on public.products (business_id, sku)
  where sku is not null;

create unique index products_external_key
  on public.products (business_id, source, external_id)
  where external_id is not null;


create table public.product_variants (
  id          uuid primary key default gen_random_uuid(),
  business_id uuid not null references public.businesses (id) on delete cascade,
  product_id  uuid not null references public.products (id) on delete cascade,
  source      public.channel_type,
  external_id text,
  sku         text,
  name        text,
  -- Size, colour, material and so on. Kept flexible because every source
  -- names its options differently; normalising them is not worth the rigidity.
  attributes  jsonb not null default '{}'::jsonb,
  -- Current list price and current unit cost. Historical values are captured
  -- on the order line at the time of sale, because both change over time and
  -- COGS must reflect what the item actually cost then.
  unit_price  numeric(20,4) check (unit_price is null or unit_price >= 0),
  unit_cost   numeric(20,4) check (unit_cost is null or unit_cost >= 0),
  barcode     text,
  is_active   boolean not null default true,
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now(),
  -- A unique index treats NULL as distinct, so an external_id with no
  -- source would defeat idempotent re-syncing. Require both together.
  constraint product_variants_external_needs_source
    check (external_id is null or source is not null)
);

comment on column public.product_variants.unit_cost is
  'Current cost to acquire one unit. Drives COGS and margin.';

create index product_variants_business_idx on public.product_variants (business_id);
create index product_variants_product_idx on public.product_variants (product_id);

create unique index product_variants_sku_key
  on public.product_variants (business_id, sku)
  where sku is not null;

create unique index product_variants_external_key
  on public.product_variants (business_id, source, external_id)
  where external_id is not null;


-- ----------------------------------------------------------------------------
-- 5. inventory
-- ----------------------------------------------------------------------------

create table public.inventory (
  id                uuid primary key default gen_random_uuid(),
  business_id       uuid not null references public.businesses (id) on delete cascade,
  variant_id        uuid not null references public.product_variants (id) on delete cascade,
  -- Free text for now. Becomes a warehouses foreign key when multi-location
  -- arrives; the column name will not need to change.
  location          text not null default 'default',
  quantity_on_hand  numeric(20,4) not null default 0,
  quantity_reserved numeric(20,4) not null default 0 check (quantity_reserved >= 0),
  reorder_point     numeric(20,4) check (reorder_point is null or reorder_point >= 0),
  created_at        timestamptz not null default now(),
  updated_at        timestamptz not null default now(),
  unique (business_id, variant_id, location)
);

comment on column public.inventory.quantity_on_hand is
  'May go negative. Overselling is a real event that the business needs to see, '
  'not something to hide behind a constraint.';

create index inventory_business_idx on public.inventory (business_id);
create index inventory_variant_idx on public.inventory (variant_id);


create table public.inventory_movements (
  id             uuid primary key default gen_random_uuid(),
  business_id    uuid not null references public.businesses (id) on delete cascade,
  variant_id     uuid not null references public.product_variants (id) on delete cascade,
  location       text not null default 'default',
  movement_type  public.inventory_movement_type not null,
  -- Signed: negative for stock leaving. Summing this column must reconstruct
  -- quantity_on_hand, which is what makes stock auditable rather than a
  -- number someone once typed.
  quantity       numeric(20,4) not null,
  unit_cost      numeric(20,4) check (unit_cost is null or unit_cost >= 0),
  -- What caused the movement, e.g. ('order', <order id>).
  reference_type text,
  reference_id   uuid,
  note           text,
  occurred_at    timestamptz not null default now(),
  created_at     timestamptz not null default now()
);

create index inventory_movements_business_idx
  on public.inventory_movements (business_id, occurred_at desc);
create index inventory_movements_variant_idx
  on public.inventory_movements (variant_id, occurred_at desc);


-- ----------------------------------------------------------------------------
-- 6. orders
-- ----------------------------------------------------------------------------

create table public.orders (
  id              uuid primary key default gen_random_uuid(),
  business_id     uuid not null references public.businesses (id) on delete cascade,
  channel_id      uuid references public.channels (id) on delete set null,
  customer_id     uuid references public.customers (id) on delete set null,
  source          public.channel_type,
  external_id     text,
  order_number    text,
  status          public.order_status not null default 'PENDING',
  currency        char(3) not null check (currency ~ '^[A-Z]{3}$'),

  -- Money breakdown. Kept as separate components rather than one total,
  -- because "why did margin fall" is usually answered by one of these
  -- moving — most often fee_total.
  subtotal        numeric(20,4) not null default 0,
  discount_total  numeric(20,4) not null default 0,
  tax_total       numeric(20,4) not null default 0,
  shipping_total  numeric(20,4) not null default 0,
  -- Marketplace commission, payment processing, fulfilment. This is the
  -- column that explains why Amazon revenue converts to less profit than
  -- the website, so it is first-class rather than lumped into expenses.
  fee_total       numeric(20,4) not null default 0,
  total           numeric(20,4) not null default 0,

  placed_at       timestamptz not null default now(),
  cancelled_at    timestamptz,
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now(),
  -- A unique index treats NULL as distinct, so an external_id with no
  -- source would defeat idempotent re-syncing. Require both together.
  constraint orders_external_needs_source
    check (external_id is null or source is not null)
);

comment on table public.orders is
  'A sale. The grain of nearly all revenue analytics.';

-- The workhorse index: almost every analytics query is "this business, this
-- date range", most recent first.
create index orders_business_placed_idx on public.orders (business_id, placed_at desc);
create index orders_channel_idx on public.orders (business_id, channel_id, placed_at desc);
create index orders_customer_idx on public.orders (customer_id, placed_at desc)
  where customer_id is not null;
create index orders_status_idx on public.orders (business_id, status);

create unique index orders_external_key
  on public.orders (business_id, source, external_id)
  where external_id is not null;

create unique index orders_number_key
  on public.orders (business_id, order_number)
  where order_number is not null;


create table public.order_items (
  id            uuid primary key default gen_random_uuid(),
  business_id   uuid not null references public.businesses (id) on delete cascade,
  order_id      uuid not null references public.orders (id) on delete cascade,
  variant_id    uuid references public.product_variants (id) on delete set null,
  product_id    uuid references public.products (id) on delete set null,

  -- Copied at time of sale. If a product is renamed or deleted later, the
  -- historical order must still read correctly.
  sku           text,
  name          text,

  quantity      numeric(20,4) not null check (quantity <> 0),
  unit_price    numeric(20,4) not null default 0,
  -- Cost AT THE TIME OF SALE, not today's cost. Using the current cost to
  -- calculate a past month's profit produces a wrong number that looks
  -- plausible, which is the most dangerous kind.
  unit_cost     numeric(20,4),
  discount      numeric(20,4) not null default 0,
  tax           numeric(20,4) not null default 0,
  line_total    numeric(20,4) not null default 0,
  created_at    timestamptz not null default now()
);

create index order_items_order_idx on public.order_items (order_id);
create index order_items_business_idx on public.order_items (business_id);
create index order_items_variant_idx on public.order_items (variant_id)
  where variant_id is not null;


-- ----------------------------------------------------------------------------
-- 7. payments
-- ----------------------------------------------------------------------------

create table public.payments (
  id           uuid primary key default gen_random_uuid(),
  business_id  uuid not null references public.businesses (id) on delete cascade,
  order_id     uuid references public.orders (id) on delete set null,
  source       public.channel_type,
  external_id  text,
  method       text,
  status       public.payment_status not null default 'PENDING',
  amount       numeric(20,4) not null default 0,
  -- Processor fee. Feeds true margin alongside orders.fee_total.
  fee          numeric(20,4) not null default 0,
  currency     char(3) not null check (currency ~ '^[A-Z]{3}$'),
  paid_at      timestamptz,
  created_at   timestamptz not null default now(),
  updated_at   timestamptz not null default now(),
  -- A unique index treats NULL as distinct, so an external_id with no
  -- source would defeat idempotent re-syncing. Require both together.
  constraint payments_external_needs_source
    check (external_id is null or source is not null)
);

create index payments_business_idx on public.payments (business_id, paid_at desc);
create index payments_order_idx on public.payments (order_id) where order_id is not null;

create unique index payments_external_key
  on public.payments (business_id, source, external_id)
  where external_id is not null;


-- ----------------------------------------------------------------------------
-- 8. returns
-- ----------------------------------------------------------------------------

create table public.returns (
  id            uuid primary key default gen_random_uuid(),
  business_id   uuid not null references public.businesses (id) on delete cascade,
  order_id      uuid references public.orders (id) on delete set null,
  source        public.channel_type,
  external_id   text,
  status        public.return_status not null default 'REQUESTED',
  reason        text,
  refund_amount numeric(20,4) not null default 0 check (refund_amount >= 0),
  currency      char(3) not null check (currency ~ '^[A-Z]{3}$'),
  restocked     boolean not null default false,
  occurred_at   timestamptz not null default now(),
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now(),
  -- A unique index treats NULL as distinct, so an external_id with no
  -- source would defeat idempotent re-syncing. Require both together.
  constraint returns_external_needs_source
    check (external_id is null or source is not null)
);

create index returns_business_idx on public.returns (business_id, occurred_at desc);
create index returns_order_idx on public.returns (order_id) where order_id is not null;

create unique index returns_external_key
  on public.returns (business_id, source, external_id)
  where external_id is not null;


-- ----------------------------------------------------------------------------
-- 9. expenses
-- ----------------------------------------------------------------------------
-- Operating costs. Net profit is gross profit minus these, so anomaly
-- detection on expenses is one of the earliest useful signals.

create table public.expenses (
  id          uuid primary key default gen_random_uuid(),
  business_id uuid not null references public.businesses (id) on delete cascade,
  category    text not null default 'Uncategorised',
  description text,
  vendor      text,
  amount      numeric(20,4) not null check (amount >= 0),
  currency    char(3) not null check (currency ~ '^[A-Z]{3}$'),
  is_recurring boolean not null default false,
  incurred_at timestamptz not null default now(),
  source      public.channel_type,
  external_id text,
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now(),
  -- A unique index treats NULL as distinct, so an external_id with no
  -- source would defeat idempotent re-syncing. Require both together.
  constraint expenses_external_needs_source
    check (external_id is null or source is not null)
);

create index expenses_business_idx on public.expenses (business_id, incurred_at desc);
create index expenses_category_idx on public.expenses (business_id, category, incurred_at desc);

create unique index expenses_external_key
  on public.expenses (business_id, source, external_id)
  where external_id is not null;


-- ----------------------------------------------------------------------------
-- 10. audit_logs
-- ----------------------------------------------------------------------------
-- Append-only. There are deliberately no UPDATE or DELETE policies: an audit
-- trail that can be edited is not an audit trail.

create table public.audit_logs (
  id          uuid primary key default gen_random_uuid(),
  business_id uuid not null references public.businesses (id) on delete cascade,
  actor_id    uuid references public.profiles (id) on delete set null,
  action      text not null,
  entity_type text not null,
  entity_id   uuid,
  before_data jsonb,
  after_data  jsonb,
  created_at  timestamptz not null default now()
);

comment on table public.audit_logs is
  'Append-only record of meaningful business changes. No update or delete '
  'policy exists, by design.';

create index audit_logs_business_idx on public.audit_logs (business_id, created_at desc);
create index audit_logs_entity_idx on public.audit_logs (business_id, entity_type, entity_id);


-- Written through this function so the actor is stamped from the session and
-- cannot be forged by the caller.
create or replace function public.write_audit_log(
  p_business_id uuid,
  p_action      text,
  p_entity_type text,
  p_entity_id   uuid default null,
  p_before      jsonb default null,
  p_after       jsonb default null
)
returns uuid
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_user_id uuid := (select auth.uid());
  v_id      uuid;
begin
  if v_user_id is null then
    raise exception 'Not authenticated.' using errcode = '28000';
  end if;

  -- Membership is re-checked here. Without it, a caller could write entries
  -- into another business's audit trail.
  if not exists (
    select 1
    from public.business_members bm
    where bm.business_id = p_business_id
      and bm.user_id = v_user_id
  ) then
    raise exception 'Not a member of this business.' using errcode = '42501';
  end if;

  insert into public.audit_logs
    (business_id, actor_id, action, entity_type, entity_id, before_data, after_data)
  values
    (p_business_id, v_user_id, p_action, p_entity_type, p_entity_id, p_before, p_after)
  returning id into v_id;

  return v_id;
end;
$$;


-- ----------------------------------------------------------------------------
-- 11. updated_at triggers
-- ----------------------------------------------------------------------------

do $$
declare
  t text;
begin
  foreach t in array array[
    'channels', 'customers', 'products', 'product_variants', 'inventory',
    'orders', 'payments', 'returns', 'expenses'
  ]
  loop
    execute format(
      'create trigger %I before update on public.%I
         for each row execute function public.set_updated_at()',
      t || '_set_updated_at', t
    );
  end loop;
end;
$$;


-- ----------------------------------------------------------------------------
-- 12. Row Level Security
-- ----------------------------------------------------------------------------
-- Generated in a loop rather than written out twelve times.
--
-- This is deliberate. Hand-writing forty near-identical policies invites a
-- typo — one wrong table name and a table silently has no protection. A loop
-- guarantees every table gets exactly the same treatment, and section 13
-- then verifies that it actually happened.
--
-- The permission model:
--   VIEWER              read only
--   STAFF, ADMIN, OWNER create and update operational records
--   ADMIN, OWNER        delete
--
-- Every policy scopes through current_user_business_ids(), so the database
-- refuses cross-tenant access even if application code asks for it.

do $$
declare
  t text;
begin
  foreach t in array array[
    'channels', 'customers', 'products', 'product_variants', 'inventory',
    'inventory_movements', 'orders', 'order_items', 'payments', 'returns',
    'expenses'
  ]
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


-- audit_logs is handled separately because it is append-only and more
-- sensitive than operational data.
alter table public.audit_logs enable row level security;
alter table public.audit_logs force row level security;

-- Only owners and admins may read the audit trail. Staff generate entries;
-- they do not get to review who did what.
create policy "audit_logs_select_admin"
  on public.audit_logs for select to authenticated
  using (public.current_user_has_role(
    business_id, array['OWNER','ADMIN']::public.business_role[]));

-- No INSERT policy: entries are written only by write_audit_log(), which
-- stamps the actor from the session so it cannot be forged.
-- No UPDATE or DELETE policies, ever. An editable audit trail is worthless.

revoke all on public.audit_logs from anon, authenticated;
grant select on public.audit_logs to authenticated;

revoke all on function public.write_audit_log(uuid, text, text, uuid, jsonb, jsonb)
  from anon, public;
grant execute on function public.write_audit_log(uuid, text, text, uuid, jsonb, jsonb)
  to authenticated;


-- ----------------------------------------------------------------------------
-- 13. Self-verification
-- ----------------------------------------------------------------------------
-- The migration checks its own work and refuses to commit if anything is
-- unprotected. A table that reaches production without RLS is a data leak,
-- so this is worth failing loudly over.

do $$
declare
  t            text;
  v_rls        boolean;
  v_policies   integer;
  v_expected   integer;
begin
  foreach t in array array[
    'channels', 'customers', 'products', 'product_variants', 'inventory',
    'inventory_movements', 'orders', 'order_items', 'payments', 'returns',
    'expenses', 'audit_logs'
  ]
  loop
    select c.relrowsecurity into v_rls
    from pg_class c
    join pg_namespace n on n.oid = c.relnamespace
    where n.nspname = 'public' and c.relname = t;

    if v_rls is not true then
      raise exception 'SECURITY: table public.% has RLS disabled', t;
    end if;

    select count(*) into v_policies
    from pg_policies
    where schemaname = 'public' and tablename = t;

    -- audit_logs intentionally has only a SELECT policy.
    v_expected := case when t = 'audit_logs' then 1 else 4 end;

    if v_policies <> v_expected then
      raise exception
        'SECURITY: table public.% has % policies, expected %',
        t, v_policies, v_expected;
    end if;
  end loop;

  raise notice 'Migration 0002 verified: 12 tables, RLS enabled, policies present.';
end;
$$;


commit;
