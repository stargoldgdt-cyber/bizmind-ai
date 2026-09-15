-- ============================================================================
-- 0030  The marketplace ledger foundation
-- ============================================================================
-- Phase 1 of the GCC Marketplace Profit Intelligence rebuild. The approved
-- design is ARCHITECTURE_BASELINE.md; how to use what this builds is LEDGER.md.
--
-- WHAT THIS BUILDS
--   marketplaces            reference list: AMAZON, NOON, CARREFOUR
--   marketplace_accounts    one seller store on one marketplace in one country;
--                           the currency lives here, not on the business
--   tax_profiles            where VAT treatment WILL be configured; only
--                           UNCONFIGURED exists until an accountant confirms one
--   import_batches          gains dataset, source_kind, account, format,
--                           adapter version, SHA-256 fingerprint, stripped columns
--   source_rows             every parsed row of a ledger file, as text, immutable
--   ledger_mapping_rules    marketplace codes -> BizMind categories, as data
--   settlements             what a marketplace says it settled, immutable
--   payouts                 what a marketplace says it paid out, immutable
--   financial_transactions  THE LEDGER: one row per reported amount, immutable
--   ledger_lines / ledger_settlements / ledger_payouts
--                           the "counting" scope: active files only, money as text
--
-- THE RULES IT ENFORCES (in the database, not in application code)
--   1. Ledger rows are never updated or deleted. A correction is a new record
--      or a withdrawn source file. Only deleting the whole business removes them.
--   2. Exactly one writer: ledger_apply_file(). Even the service role cannot
--      insert a ledger row directly -- a trigger refuses it.
--   3. Every ledger row carries its source file AND source row, and composite
--      foreign keys make it impossible for either to belong to another business
--      or for the row to belong to another file.
--   4. A ledger row's currency must equal its marketplace account's currency.
--   5. Blank is unknown: optional money and dates stay NULL, never zero. A
--      blank AMOUNT cannot be a transaction at all -- it must be a row issue.
--   6. No customer data: a source row may not carry a buyer name, email, phone
--      or address column, and no stored text may contain an email address.
--   7. Withdrawing a ledger file removes its lines, settlements and payouts from
--      the counting scope without deleting a single row. Restore brings them back.
--
-- PERMISSIONS (decision B11, 2026-09-15)
--   create/update marketplace accounts, tax profiles   OWNER
--   import a ledger file                                OWNER, ADMIN, STAFF
--   withdraw / restore a ledger file                    OWNER, ADMIN
--   read                                                any member
--
-- ADDITIVE AND REVERSIBLE
--   No existing table, column, function or row is removed or changed in
--   meaning. Existing imports become dataset LEGACY by default. The rollback
--   script is supabase/rollback/0030_marketplace_ledger_foundation.rollback.sql.
--
-- Depends on 0029. APPLY THIS IN THE SUPABASE SQL EDITOR.
-- Clear the editor first: click in it, press Ctrl+A, then Delete.
-- ============================================================================

begin;

-- The counting views rely on security_invoker (PostgreSQL 15+). Without it a
-- view would bypass Row Level Security, so an older server is refused here,
-- plainly, before anything is created.
do $$
begin
  if current_setting('server_version_num')::integer < 150000 then
    raise exception 'Migration 0030 needs PostgreSQL 15 or later (this server is %).',
      current_setting('server_version');
  end if;
end;
$$;


-- ----------------------------------------------------------------------------
-- 1. Pure helper functions
-- ----------------------------------------------------------------------------
-- Used by CHECK constraints and by the writer. The two patterns below are
-- mirrored verbatim in src/services/marketplaces/customer-data.ts and
-- ledger-file.ts; a test fails if they drift apart.

create function public.ledger_writer_active()
returns boolean
language sql
stable
set search_path = ''
as $$
  select coalesce(current_setting('bizmind.ledger_writer', true), '') = 'on';
$$;

comment on function public.ledger_writer_active() is
  'True only inside ledger_apply_file(), ledger_file_withdraw() and '
  'ledger_file_restore(), which set a transaction-local flag. The guards on '
  'every ledger table refuse writes without it.';

create function public.ledger_is_customer_column(p_name text)
returns boolean
language sql
immutable
parallel safe
set search_path = ''
as $$
  select coalesce(
    p_name ~* '(buyer|customer|recipient|ship[-_ ]?to|bill[-_ ]?to|e-?mail|phone|mobile|telephone|whatsapp|address|street|post[-_ ]?code|postal|zip[-_ ]?code|first[-_ ]?name|last[-_ ]?name|full[-_ ]?name|contact)',
    false
  );
$$;

create function public.ledger_text_has_email(p_text text)
returns boolean
language sql
immutable
parallel safe
set search_path = ''
as $$
  select coalesce(p_text ~* '[a-z0-9._%+-]+@[a-z0-9.-]+\.[a-z]{2,}', false);
$$;

create function public.ledger_raw_is_clean(p_raw jsonb)
returns boolean
language sql
immutable
parallel safe
set search_path = ''
as $$
  select jsonb_typeof(p_raw) = 'object'
     and not exists (
       select 1
       from jsonb_each(p_raw) e
       where jsonb_typeof(e.value) not in ('string', 'null')
          or public.ledger_is_customer_column(e.key)
          or (jsonb_typeof(e.value) = 'string'
              and public.ledger_text_has_email(e.value #>> '{}'))
     );
$$;

comment on function public.ledger_raw_is_clean(jsonb) is
  'A source row is an object of text-or-null values, with no customer-data '
  'column and no email address anywhere in it.';

create function public.ledger_category_valid(p_side text, p_category text)
returns boolean
language sql
immutable
parallel safe
set search_path = ''
as $$
  select case p_side
    when 'PNL'  then p_category in ('REVENUE', 'REFUND', 'MARKETPLACE_FEE', 'FULFILMENT',
                                    'PROMOTION', 'SUBSIDY', 'ADVERTISING', 'REIMBURSEMENT',
                                    'OTHER_INCOME', 'OTHER_COST')
    when 'CASH' then p_category in ('PAYOUT', 'RESERVE_HOLD', 'RESERVE_RELEASE',
                                    'BALANCE_CARRIED', 'TRANSFER')
    when 'TAX'  then p_category in ('OUTPUT_VAT', 'FEE_VAT', 'OTHER_TAX')
    when 'MEMO' then p_category in ('SETTLEMENT_TOTAL', 'INFORMATIONAL')
    else false
  end;
$$;

create function public.ledger_json_is_money(p jsonb)
returns boolean
language sql
immutable
parallel safe
set search_path = ''
as $$
  select coalesce(
    jsonb_typeof(p) = 'string'
      and (p #>> '{}') ~ '^-?[0-9]{1,16}(\.[0-9]{1,4})?$',
    false
  );
$$;

create function public.ledger_json_is_instant(p jsonb)
returns boolean
language sql
immutable
parallel safe
set search_path = ''
as $$
  select coalesce(
    jsonb_typeof(p) = 'string'
      and (p #>> '{}') ~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}(:[0-9]{2}(\.[0-9]{1,6})?)?(Z|[+-][0-9]{2}:[0-9]{2})$',
    false
  );
$$;

create function public.ledger_json_is_absent(p jsonb)
returns boolean
language sql
immutable
parallel safe
set search_path = ''
as $$
  select p is null or jsonb_typeof(p) = 'null';
$$;

create function public.ledger_json_is_optional_text(p jsonb, p_max integer)
returns boolean
language sql
immutable
parallel safe
set search_path = ''
as $$
  select p is null
      or jsonb_typeof(p) = 'null'
      or (jsonb_typeof(p) = 'string'
          and length(p #>> '{}') <= p_max
          and not public.ledger_text_has_email(p #>> '{}'));
$$;


-- ----------------------------------------------------------------------------
-- 2. Marketplaces (reference data)
-- ----------------------------------------------------------------------------

create table public.marketplaces (
  code           text primary key check (code ~ '^[A-Z][A-Z0-9_]{1,31}$'),
  name           text not null check (length(trim(name)) between 1 and 80),
  adapter_status text not null
    check (adapter_status in ('AVAILABLE', 'SAMPLES_REQUIRED', 'CONTRACT_ONLY')),
  created_at     timestamptz not null default now()
);

comment on table public.marketplaces is
  'Marketplaces BizMind knows, and how far each adapter has got. Platform '
  'reference data: no business data, written by migrations only.';

insert into public.marketplaces (code, name, adapter_status) values
  ('AMAZON',    'Amazon',    'CONTRACT_ONLY'),
  ('NOON',      'noon',      'SAMPLES_REQUIRED'),
  ('CARREFOUR', 'Carrefour', 'CONTRACT_ONLY');


-- ----------------------------------------------------------------------------
-- 3. Marketplace accounts and tax profiles
-- ----------------------------------------------------------------------------

create table public.marketplace_accounts (
  id                  uuid primary key default gen_random_uuid(),
  business_id         uuid not null references public.businesses (id) on delete cascade,
  marketplace_code    text not null references public.marketplaces (code),
  label               text not null check (length(trim(label)) between 1 and 80),
  country             char(2) not null check (country ~ '^[A-Z]{2}$'),
  currency            char(3) not null check (currency ~ '^[A-Z]{3}$'),
  external_seller_ref text check (
    external_seller_ref is null
    or (length(trim(external_seller_ref)) between 1 and 120
        and not public.ledger_text_has_email(external_seller_ref))
  ),
  status              text not null default 'ACTIVE' check (status in ('ACTIVE', 'ARCHIVED')),
  created_by          uuid references public.profiles (id) on delete set null,
  created_at          timestamptz not null default now(),
  updated_at          timestamptz not null default now(),
  constraint marketplace_accounts_business_id_id_key unique (business_id, id)
);

comment on table public.marketplace_accounts is
  'One seller store on one marketplace in one country. Every ledger figure, '
  'currency and reconciliation belongs to an account (decision A12).';

create index marketplace_accounts_business_idx on public.marketplace_accounts (business_id);

-- One account per store: a blank seller reference counts as one value, so two
-- accounts with no reference for the same marketplace and country collide.
create unique index marketplace_accounts_identity_key
  on public.marketplace_accounts (business_id, marketplace_code, country, coalesce(external_seller_ref, ''));

create trigger marketplace_accounts_set_updated_at
  before update on public.marketplace_accounts
  for each row execute function public.set_updated_at();

create table public.tax_profiles (
  id                     uuid primary key default gen_random_uuid(),
  business_id            uuid not null references public.businesses (id) on delete cascade,
  marketplace_account_id uuid not null,
  vat_registration       text not null default 'UNKNOWN'
    check (vat_registration in ('UNKNOWN', 'REGISTERED', 'NOT_REGISTERED')),
  -- Only UNCONFIGURED exists. Real treatments are added by a later migration
  -- once an accountant confirms them (decisions A11, B1) -- never by a form.
  treatment              text not null default 'UNCONFIGURED'
    check (treatment in ('UNCONFIGURED')),
  note                   text check (
    note is null or (length(note) <= 500 and not public.ledger_text_has_email(note))
  ),
  updated_by             uuid references public.profiles (id) on delete set null,
  created_at             timestamptz not null default now(),
  updated_at             timestamptz not null default now(),
  constraint tax_profiles_account_key unique (marketplace_account_id),
  constraint tax_profiles_account_fkey
    foreign key (business_id, marketplace_account_id)
    references public.marketplace_accounts (business_id, id) on delete cascade
);

comment on table public.tax_profiles is
  'Where VAT treatment will be configured for an account. UNCONFIGURED until '
  'an accountant confirms a treatment; changing it never alters a ledger row.';

create trigger tax_profiles_set_updated_at
  before update on public.tax_profiles
  for each row execute function public.set_updated_at();


-- ----------------------------------------------------------------------------
-- 4. import_batches becomes the source-file record
-- ----------------------------------------------------------------------------
-- The table keeps its name so Data Sources, lineage and withdrawal (0024-0028)
-- keep working. Every existing row becomes dataset LEGACY and nothing else
-- about it changes.

alter table public.import_batches
  add column dataset text not null default 'LEGACY'
    check (dataset in ('LEGACY', 'LEDGER')),
  add column source_kind text
    check (source_kind is null or source_kind in ('UPLOAD', 'GOOGLE_SHEETS', 'API', 'NATIVE')),
  add column marketplace_account_id uuid,
  add column format_id text check (format_id is null or length(format_id) between 1 and 120),
  add column adapter_version text
    check (adapter_version is null or length(adapter_version) between 1 and 40),
  add column file_sha256 char(64) check (file_sha256 is null or file_sha256 ~ '^[0-9a-f]{64}$'),
  add column stripped_columns text[] not null default '{}';

alter table public.import_batches
  add constraint import_batches_business_id_id_key unique (business_id, id),
  add constraint import_batches_marketplace_account_fkey
    foreign key (business_id, marketplace_account_id)
    references public.marketplace_accounts (business_id, id) on delete cascade,
  add constraint import_batches_ledger_identity_check check (
    dataset <> 'LEDGER'
    or (source_kind is not null
        and marketplace_account_id is not null
        and format_id is not null
        and adapter_version is not null
        and file_sha256 is not null)
  );

comment on column public.import_batches.dataset is
  'LEGACY: an order/product/expense import or sync (phases 5-12). LEDGER: a '
  'marketplace file written to the financial ledger by ledger_apply_file().';
comment on column public.import_batches.file_sha256 is
  'Fingerprint of the uploaded file (decision B6). The original bytes are not '
  'kept; the parsed rows in source_rows are the evidence.';
comment on column public.import_batches.stripped_columns is
  'Columns removed before storage: not part of the format, or customer data.';

-- The same file for the same account counts at most once. A withdrawn copy
-- does not count, so a file can be re-applied after its old copy is withdrawn.
create unique index import_batches_ledger_file_once
  on public.import_batches (marketplace_account_id, file_sha256)
  where dataset = 'LEDGER' and withdrawn_at is null;

create index import_batches_marketplace_account_idx
  on public.import_batches (marketplace_account_id)
  where marketplace_account_id is not null;


-- ----------------------------------------------------------------------------
-- 5. Source rows
-- ----------------------------------------------------------------------------

create table public.source_rows (
  id             bigint generated always as identity primary key,
  business_id    uuid not null references public.businesses (id) on delete cascade,
  source_file_id uuid not null,
  row_number     integer not null check (row_number >= 1),
  raw            jsonb not null check (public.ledger_raw_is_clean(raw)),
  row_hash       char(64) not null check (row_hash ~ '^[0-9a-f]{64}$'),
  created_at     timestamptz not null default now(),
  constraint source_rows_file_fkey
    foreign key (business_id, source_file_id)
    references public.import_batches (business_id, id) on delete cascade,
  constraint source_rows_file_row_key unique (source_file_id, row_number),
  constraint source_rows_lineage_key unique (business_id, source_file_id, id)
);

comment on table public.source_rows is
  'Every parsed row of a ledger file, as the text that was read. Blank cells '
  'are JSON null. Immutable; removed only when the business is deleted.';


-- ----------------------------------------------------------------------------
-- 6. Mapping rules
-- ----------------------------------------------------------------------------

create table public.ledger_mapping_rules (
  id               uuid primary key default gen_random_uuid(),
  scope            text not null default 'GLOBAL' check (scope in ('GLOBAL', 'BUSINESS')),
  business_id      uuid references public.businesses (id) on delete cascade,
  marketplace_code text not null references public.marketplaces (code),
  format_id        text not null check (length(format_id) between 1 and 120),
  match_key        text not null check (length(match_key) between 1 and 300),
  match            jsonb not null check (jsonb_typeof(match) = 'object'),
  side             text not null check (side in ('PNL', 'CASH', 'TAX', 'MEMO')),
  category         text not null,
  subcategory      text check (subcategory is null or length(subcategory) between 1 and 80),
  sign_rule        text not null default 'AS_REPORTED' check (sign_rule in ('AS_REPORTED', 'NEGATE')),
  quantity_rule    text not null default 'NONE'
    check (quantity_rule in ('NONE', 'REPORTED', 'COUNT_LINE')),
  attribution      text not null check (attribution in ('ORDER_LINE', 'ORDER', 'MARKETPLACE')),
  confidence       text not null
    check (confidence in ('SAMPLE_VERIFIED', 'SELLER_ANALYSIS', 'DOCUMENTED', 'PROVISIONAL')),
  evidence         text not null check (length(trim(evidence)) between 1 and 1000),
  version          integer not null default 1 check (version >= 1),
  supersedes_id    uuid references public.ledger_mapping_rules (id),
  status           text not null default 'ACTIVE' check (status in ('ACTIVE', 'RETIRED')),
  created_at       timestamptz not null default now(),
  constraint ledger_mapping_rules_scope_business_check check ((scope = 'GLOBAL') = (business_id is null)),
  constraint ledger_mapping_rules_category_check check (public.ledger_category_valid(side, category))
);

comment on table public.ledger_mapping_rules is
  'Marketplace codes to BizMind categories, as versioned data. Never edited: '
  'a change is a new version and the old one is RETIRED. There is no "ignore" '
  'side -- nothing a source reports is discarded.';

create unique index ledger_mapping_rules_version_key
  on public.ledger_mapping_rules (
    coalesce(business_id, '00000000-0000-0000-0000-000000000000'::uuid),
    marketplace_code, format_id, match_key, version);

create unique index ledger_mapping_rules_one_active
  on public.ledger_mapping_rules (
    coalesce(business_id, '00000000-0000-0000-0000-000000000000'::uuid),
    marketplace_code, format_id, match_key)
  where status = 'ACTIVE';


-- ----------------------------------------------------------------------------
-- 7. Settlements and payouts
-- ----------------------------------------------------------------------------

create table public.settlements (
  id                     uuid primary key default gen_random_uuid(),
  business_id            uuid not null references public.businesses (id) on delete cascade,
  marketplace_account_id uuid not null,
  source_file_id         uuid not null,
  source_row_id          bigint not null,
  external_settlement_id text not null check (
    length(external_settlement_id) between 1 and 200
    and not public.ledger_text_has_email(external_settlement_id)
  ),
  period_start           timestamptz,
  period_end             timestamptz,
  reported_total         numeric(20,4),
  reported_deposit_date  timestamptz,
  currency               char(3) not null check (currency ~ '^[A-Z]{3}$'),
  created_at             timestamptz not null default now(),
  constraint settlements_business_id_id_key unique (business_id, id),
  constraint settlements_file_external_key unique (source_file_id, external_settlement_id),
  constraint settlements_account_fkey
    foreign key (business_id, marketplace_account_id)
    references public.marketplace_accounts (business_id, id) on delete cascade,
  constraint settlements_source_row_fkey
    foreign key (business_id, source_file_id, source_row_id)
    references public.source_rows (business_id, source_file_id, id) on delete cascade
);

comment on table public.settlements is
  'What a marketplace reports it settled for a period. Not a bank deposit '
  '(decision A9). Immutable.';

create index settlements_account_external_idx
  on public.settlements (marketplace_account_id, external_settlement_id);

create table public.payouts (
  id                     uuid primary key default gen_random_uuid(),
  business_id            uuid not null references public.businesses (id) on delete cascade,
  marketplace_account_id uuid not null,
  origin                 text not null check (origin in ('SOURCE_FILE', 'MANUAL')),
  source_file_id         uuid,
  source_row_id          bigint,
  settlement_id          uuid,
  external_ref           text check (
    external_ref is null
    or (length(external_ref) between 1 and 200 and not public.ledger_text_has_email(external_ref))
  ),
  amount                 numeric(20,4) not null,
  currency               char(3) not null check (currency ~ '^[A-Z]{3}$'),
  paid_at                timestamptz,
  created_by             uuid references public.profiles (id) on delete set null,
  voided_at              timestamptz,
  void_reason            text check (void_reason is null or length(void_reason) between 1 and 500),
  created_at             timestamptz not null default now(),
  constraint payouts_business_id_id_key unique (business_id, id),
  constraint payouts_origin_source_check check (
    (origin = 'SOURCE_FILE') = (source_file_id is not null and source_row_id is not null)
  ),
  constraint payouts_void_check check (
    (voided_at is null) = (void_reason is null) and (origin = 'MANUAL' or voided_at is null)
  ),
  constraint payouts_account_fkey
    foreign key (business_id, marketplace_account_id)
    references public.marketplace_accounts (business_id, id) on delete cascade,
  constraint payouts_source_row_fkey
    foreign key (business_id, source_file_id, source_row_id)
    references public.source_rows (business_id, source_file_id, id) on delete cascade,
  constraint payouts_settlement_fkey
    foreign key (business_id, settlement_id)
    references public.settlements (business_id, id) on delete cascade
);

comment on table public.payouts is
  'What a marketplace reports it paid the seller. Never revenue (decision A9). '
  'SOURCE_FILE payouts are immutable; a MANUAL payout (Phase 6) can only be voided.';


-- ----------------------------------------------------------------------------
-- 8. The ledger
-- ----------------------------------------------------------------------------

create table public.financial_transactions (
  id                     bigint generated always as identity primary key,
  business_id            uuid not null references public.businesses (id) on delete cascade,
  marketplace_account_id uuid not null,
  source_file_id         uuid not null,
  source_row_id          bigint not null,
  line_index             smallint not null default 0 check (line_index >= 0),
  mapping_rule_id        uuid references public.ledger_mapping_rules (id),
  side                   text,
  category               text not null,
  subcategory            text check (subcategory is null or length(subcategory) between 1 and 80),
  source_type            text check (source_type is null or length(source_type) <= 200),
  source_subtype         text check (source_subtype is null or length(source_subtype) <= 200),
  source_description     text check (source_description is null or length(source_description) <= 500),
  amount                 numeric(20,4) not null,
  currency               char(3) not null check (currency ~ '^[A-Z]{3}$'),
  posted_at              timestamptz not null,
  order_ref              text check (order_ref is null or length(order_ref) <= 200),
  order_line_ref         text check (order_line_ref is null or length(order_line_ref) <= 200),
  raw_sku                text check (raw_sku is null or length(raw_sku) <= 200),
  quantity               numeric(20,4),
  quantity_basis         text check (quantity_basis is null or quantity_basis in ('REPORTED', 'DERIVED_LINE_COUNT')),
  attribution            text not null check (attribution in ('ORDER_LINE', 'ORDER', 'MARKETPLACE')),
  settlement_id          uuid,
  payout_id              uuid,
  created_at             timestamptz not null default now(),
  constraint financial_transactions_business_id_id_key unique (business_id, id),
  constraint financial_transactions_row_line_key unique (source_row_id, line_index),
  constraint financial_transactions_classification_check check (
    (category = 'UNMAPPED' and side is null and subcategory is null and mapping_rule_id is null)
    or (category <> 'UNMAPPED' and mapping_rule_id is not null
        and public.ledger_category_valid(side, category))
  ),
  constraint financial_transactions_quantity_check check ((quantity is null) = (quantity_basis is null)),
  constraint financial_transactions_no_email_check check (
    not public.ledger_text_has_email(
      concat_ws(' ', source_type, source_subtype, source_description,
                order_ref, order_line_ref, raw_sku, subcategory))
  ),
  constraint financial_transactions_account_fkey
    foreign key (business_id, marketplace_account_id)
    references public.marketplace_accounts (business_id, id) on delete cascade,
  constraint financial_transactions_source_row_fkey
    foreign key (business_id, source_file_id, source_row_id)
    references public.source_rows (business_id, source_file_id, id) on delete cascade,
  constraint financial_transactions_settlement_fkey
    foreign key (business_id, settlement_id)
    references public.settlements (business_id, id) on delete cascade,
  constraint financial_transactions_payout_fkey
    foreign key (business_id, payout_id)
    references public.payouts (business_id, id) on delete cascade
);

comment on table public.financial_transactions is
  'THE LEDGER. One row per amount a source reported, signed from the seller''s '
  'view. Written only by ledger_apply_file(); never updated or deleted. A '
  'product is resolved at read time (Phase 4), never stored here.';

create index financial_transactions_account_posted_idx
  on public.financial_transactions (business_id, marketplace_account_id, posted_at);
create index financial_transactions_file_idx on public.financial_transactions (source_file_id);
create index financial_transactions_settlement_idx
  on public.financial_transactions (settlement_id) where settlement_id is not null;
create index financial_transactions_sku_idx
  on public.financial_transactions (business_id, raw_sku) where raw_sku is not null;
create index financial_transactions_order_idx
  on public.financial_transactions (business_id, order_ref) where order_ref is not null;


-- ----------------------------------------------------------------------------
-- 9. Guards
-- ----------------------------------------------------------------------------

/** Ledger facts: one writer, never changed, removed only with the business. */
create function public.ledger_immutable_guard()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if tg_op = 'INSERT' then
    if not public.ledger_writer_active() then
      raise exception '% rows are written only by ledger_apply_file().', tg_table_name
        using errcode = '42501';
    end if;
    return new;
  end if;

  if tg_op = 'UPDATE' then
    raise exception '% rows cannot be changed. Correct a figure with a new record, or withdraw its source file.', tg_table_name
      using errcode = '42501';
  end if;

  -- DELETE. Allowed only as part of deleting the business itself: the parent
  -- row is already gone by the time the cascade reaches this row (0006).
  if not exists (select 1 from public.businesses b where b.id = old.business_id) then
    return old;
  end if;

  raise exception '% rows cannot be deleted. Withdraw the source file instead.', tg_table_name
    using errcode = '42501';
end;
$$;

create function public.ledger_truncate_guard()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  raise exception '% cannot be truncated.', tg_table_name using errcode = '42501';
end;
$$;

/** Payouts: as immutable as the ledger, except a MANUAL payout may be voided. */
create function public.payout_guard()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if tg_op = 'INSERT' then
    if not public.ledger_writer_active() then
      raise exception 'payouts rows are written only by BizMind''s ledger functions.'
        using errcode = '42501';
    end if;
    return new;
  end if;

  if tg_op = 'UPDATE' then
    -- The profile that created a manual payout was deleted (ON DELETE SET NULL).
    if (to_jsonb(new) - 'created_by') = (to_jsonb(old) - 'created_by')
       and new.created_by is null then
      return new;
    end if;

    if public.ledger_writer_active()
       and old.origin = 'MANUAL'
       and old.voided_at is null
       and new.voided_at is not null
       and (to_jsonb(new) - array['voided_at', 'void_reason'])
           = (to_jsonb(old) - array['voided_at', 'void_reason']) then
      return new;
    end if;

    raise exception 'payouts rows cannot be changed. A manual payout can only be voided.'
      using errcode = '42501';
  end if;

  if not exists (select 1 from public.businesses b where b.id = old.business_id) then
    return old;
  end if;

  raise exception 'payouts rows cannot be deleted.' using errcode = '42501';
end;
$$;

/** Accounts: the business never changes; currency and marketplace lock once data exists. */
create function public.marketplace_account_guard()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if new.business_id is distinct from old.business_id then
    raise exception 'A marketplace account cannot move to another business.'
      using errcode = '42501';
  end if;

  if (new.currency is distinct from old.currency
      or new.marketplace_code is distinct from old.marketplace_code)
     and exists (
       select 1 from public.import_batches b where b.marketplace_account_id = old.id
     ) then
    raise exception 'This account''s currency and marketplace are locked because data has been recorded against it.'
      using errcode = '42501';
  end if;

  return new;
end;
$$;

/** Rules: never edited. The only permitted change is ACTIVE -> RETIRED. */
create function public.ledger_mapping_rule_guard()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if old.status = 'ACTIVE'
     and new.status = 'RETIRED'
     and (to_jsonb(new) - 'status') = (to_jsonb(old) - 'status') then
    return new;
  end if;

  raise exception 'A mapping rule cannot be edited. Add a new version and retire this one.'
    using errcode = '42501';
end;
$$;

/** Source files: ledger files are created, withdrawn and restored only by the ledger functions. */
create function public.import_batch_ledger_guard()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_changeable constant text[] :=
    array['withdrawn_at', 'withdrawn_by', 'withdrawal_reason', 'updated_at', 'created_by'];
begin
  if tg_op = 'INSERT' then
    if new.dataset <> 'LEGACY' and not public.ledger_writer_active() then
      raise exception 'Ledger files are created only by ledger_apply_file().'
        using errcode = '42501';
    end if;

    if new.dataset = 'LEGACY'
       and (new.source_kind is not null
            or new.marketplace_account_id is not null
            or new.format_id is not null
            or new.adapter_version is not null
            or new.file_sha256 is not null
            or cardinality(new.stripped_columns) > 0) then
      raise exception 'Ledger fields belong to ledger files only.' using errcode = '42501';
    end if;

    return new;
  end if;

  if tg_op = 'UPDATE' then
    if new.dataset is distinct from old.dataset
       or new.source_kind is distinct from old.source_kind
       or new.marketplace_account_id is distinct from old.marketplace_account_id
       or new.format_id is distinct from old.format_id
       or new.adapter_version is distinct from old.adapter_version
       or new.file_sha256 is distinct from old.file_sha256
       or new.stripped_columns is distinct from old.stripped_columns then
      raise exception 'A source file''s identity cannot change.' using errcode = '42501';
    end if;

    if old.dataset = 'LEDGER' then
      if (to_jsonb(new) - v_changeable) is distinct from (to_jsonb(old) - v_changeable) then
        raise exception 'A ledger file cannot be edited. Withdraw it and apply a corrected file.'
          using errcode = '42501';
      end if;

      if new.created_by is distinct from old.created_by and new.created_by is not null then
        raise exception 'A ledger file cannot be edited.' using errcode = '42501';
      end if;

      if (new.withdrawn_at is distinct from old.withdrawn_at
          or new.withdrawal_reason is distinct from old.withdrawal_reason
          or (new.withdrawn_by is distinct from old.withdrawn_by and new.withdrawn_by is not null))
         and not public.ledger_writer_active() then
        raise exception 'Ledger files are withdrawn and restored only with ledger_file_withdraw() and ledger_file_restore().'
          using errcode = '42501';
      end if;
    end if;

    return new;
  end if;

  if old.dataset = 'LEDGER'
     and exists (select 1 from public.businesses b where b.id = old.business_id) then
    raise exception 'A ledger file cannot be deleted. Withdraw it instead.' using errcode = '42501';
  end if;

  return old;
end;
$$;

/** Row problems of a ledger file are evidence: written once, by the writer. */
create function public.import_issue_ledger_guard()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_is_ledger boolean;
begin
  select exists (
    select 1 from public.import_batches b
    where b.dataset = 'LEDGER'
      and b.id in (
        case when tg_op in ('UPDATE', 'DELETE') then old.batch_id end,
        case when tg_op in ('INSERT', 'UPDATE') then new.batch_id end
      )
  ) into v_is_ledger;

  if not v_is_ledger then
    return case when tg_op = 'DELETE' then old else new end;
  end if;

  if tg_op = 'INSERT' then
    if not public.ledger_writer_active() then
      raise exception 'Row issues of a ledger file are written only by ledger_apply_file().'
        using errcode = '42501';
    end if;
    return new;
  end if;

  if tg_op = 'UPDATE' then
    raise exception 'Row issues of a ledger file cannot be changed.' using errcode = '42501';
  end if;

  if not exists (select 1 from public.businesses b where b.id = old.business_id) then
    return old;
  end if;

  raise exception 'Row issues of a ledger file cannot be deleted.' using errcode = '42501';
end;
$$;

create trigger source_rows_immutable
  before insert or update or delete on public.source_rows
  for each row execute function public.ledger_immutable_guard();
create trigger source_rows_no_truncate
  before truncate on public.source_rows
  for each statement execute function public.ledger_truncate_guard();

create trigger settlements_immutable
  before insert or update or delete on public.settlements
  for each row execute function public.ledger_immutable_guard();
create trigger settlements_no_truncate
  before truncate on public.settlements
  for each statement execute function public.ledger_truncate_guard();

create trigger financial_transactions_immutable
  before insert or update or delete on public.financial_transactions
  for each row execute function public.ledger_immutable_guard();
create trigger financial_transactions_no_truncate
  before truncate on public.financial_transactions
  for each statement execute function public.ledger_truncate_guard();

create trigger payouts_guard
  before insert or update or delete on public.payouts
  for each row execute function public.payout_guard();
create trigger payouts_no_truncate
  before truncate on public.payouts
  for each statement execute function public.ledger_truncate_guard();

create trigger marketplace_accounts_guard
  before update on public.marketplace_accounts
  for each row execute function public.marketplace_account_guard();

create trigger ledger_mapping_rules_guard
  before update on public.ledger_mapping_rules
  for each row execute function public.ledger_mapping_rule_guard();

create trigger import_batches_ledger_guard
  before insert or update or delete on public.import_batches
  for each row execute function public.import_batch_ledger_guard();

create trigger import_issues_ledger_guard
  before insert or update or delete on public.import_issues
  for each row execute function public.import_issue_ledger_guard();


-- ----------------------------------------------------------------------------
-- 10. Row Level Security
-- ----------------------------------------------------------------------------

alter table public.marketplaces           enable row level security;
alter table public.marketplaces           force row level security;
alter table public.marketplace_accounts   enable row level security;
alter table public.marketplace_accounts   force row level security;
alter table public.tax_profiles           enable row level security;
alter table public.tax_profiles           force row level security;
alter table public.source_rows            enable row level security;
alter table public.source_rows            force row level security;
alter table public.ledger_mapping_rules   enable row level security;
alter table public.ledger_mapping_rules   force row level security;
alter table public.settlements            enable row level security;
alter table public.settlements            force row level security;
alter table public.payouts                enable row level security;
alter table public.payouts                force row level security;
alter table public.financial_transactions enable row level security;
alter table public.financial_transactions force row level security;

create policy marketplaces_select_all
  on public.marketplaces for select to authenticated using (true);

create policy ledger_mapping_rules_select
  on public.ledger_mapping_rules for select to authenticated
  using (business_id is null or business_id in (select public.current_user_business_ids()));

do $$
declare
  t text;
begin
  foreach t in array array[
    'marketplace_accounts', 'tax_profiles', 'source_rows',
    'settlements', 'payouts', 'financial_transactions'
  ]
  loop
    execute format($f$
      create policy %I on public.%I for select to authenticated
      using (business_id in (select public.current_user_business_ids()))
    $f$, t || '_select_member', t);
  end loop;
end;
$$;


-- ----------------------------------------------------------------------------
-- 11. Account and tax profile functions (OWNER)
-- ----------------------------------------------------------------------------

create function public.marketplace_account_create(
  p_business_id         uuid,
  p_marketplace_code    text,
  p_label               text,
  p_country             text,
  p_currency            text,
  p_external_seller_ref text default null
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

  if p_business_id is null
     or p_business_id not in (select public.current_user_business_ids()) then
    raise exception 'That business could not be found.' using errcode = 'P0002';
  end if;

  if not public.current_user_has_role(p_business_id, array['OWNER']::public.business_role[]) then
    raise exception 'Only an owner can add a marketplace account.' using errcode = '42501';
  end if;

  if not exists (select 1 from public.marketplaces m where m.code = p_marketplace_code) then
    raise exception 'That marketplace is not one BizMind supports.' using errcode = '22023';
  end if;

  begin
    insert into public.marketplace_accounts (
      business_id, marketplace_code, label, country, currency, external_seller_ref, created_by
    )
    values (
      p_business_id, p_marketplace_code, trim(p_label), upper(trim(p_country)),
      upper(trim(p_currency)), nullif(trim(coalesce(p_external_seller_ref, '')), ''),
      (select auth.uid())
    )
    returning id into v_id;
  exception
    when unique_violation then
      raise exception 'This marketplace account already exists.' using errcode = '23505';
    when check_violation then
      raise exception 'The label, country or currency is not valid.' using errcode = '23514';
  end;

  insert into public.tax_profiles (business_id, marketplace_account_id, updated_by)
  values (p_business_id, v_id, (select auth.uid()));

  perform public.write_audit_log(
    p_business_id, 'marketplace_account.created', 'marketplace_accounts', v_id, null,
    (select jsonb_build_object(
       'marketplace_code', a.marketplace_code, 'label', a.label, 'country', a.country,
       'currency', a.currency, 'external_seller_ref', a.external_seller_ref)
     from public.marketplace_accounts a where a.id = v_id)
  );

  return v_id;
end;
$$;

create function public.marketplace_account_update(
  p_account_id          uuid,
  p_label               text default null,
  p_external_seller_ref text default null,
  p_currency            text default null,
  p_status              text default null
)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_before public.marketplace_accounts;
  v_after  public.marketplace_accounts;
begin
  if (select auth.uid()) is null then
    raise exception 'Not authenticated.' using errcode = '28000';
  end if;

  select * into v_before from public.marketplace_accounts a where a.id = p_account_id;

  if v_before.id is null
     or v_before.business_id not in (select public.current_user_business_ids()) then
    raise exception 'That marketplace account could not be found.' using errcode = 'P0002';
  end if;

  if not public.current_user_has_role(v_before.business_id, array['OWNER']::public.business_role[]) then
    raise exception 'Only an owner can change a marketplace account.' using errcode = '42501';
  end if;

  update public.marketplace_accounts a
  set label               = coalesce(nullif(trim(coalesce(p_label, '')), ''), a.label),
      external_seller_ref = coalesce(nullif(trim(coalesce(p_external_seller_ref, '')), ''), a.external_seller_ref),
      currency            = coalesce(upper(nullif(trim(coalesce(p_currency, '')), '')), a.currency),
      status              = coalesce(nullif(trim(coalesce(p_status, '')), ''), a.status)
  where a.id = p_account_id
  returning * into v_after;

  perform public.write_audit_log(
    v_before.business_id, 'marketplace_account.updated', 'marketplace_accounts', p_account_id,
    jsonb_build_object('label', v_before.label, 'external_seller_ref', v_before.external_seller_ref,
                       'currency', v_before.currency, 'status', v_before.status),
    jsonb_build_object('label', v_after.label, 'external_seller_ref', v_after.external_seller_ref,
                       'currency', v_after.currency, 'status', v_after.status)
  );
end;
$$;

create function public.tax_profile_update(
  p_account_id       uuid,
  p_vat_registration text,
  p_note             text default null
)
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

  update public.tax_profiles t
  set vat_registration = p_vat_registration,
      note             = nullif(trim(coalesce(p_note, '')), ''),
      updated_by       = (select auth.uid())
  where t.id = v_before.id;

  perform public.write_audit_log(
    v_before.business_id, 'tax_profile.updated', 'tax_profiles', v_before.id,
    jsonb_build_object('vat_registration', v_before.vat_registration, 'note', v_before.note),
    jsonb_build_object('vat_registration', p_vat_registration,
                       'note', nullif(trim(coalesce(p_note, '')), ''),
                       'treatment', v_before.treatment)
  );
end;
$$;


-- ----------------------------------------------------------------------------
-- 12. The one writer: ledger_apply_file()
-- ----------------------------------------------------------------------------
-- Takes the adapter's output for ONE file and writes it atomically: the file
-- record, every source row, settlements, payouts, transactions and row issues.
-- The payload contract is documented in LEDGER.md and built by
-- src/services/marketplaces/ledger-file.ts.
--
-- It validates everything itself. The TypeScript builder checks the same rules
-- first so an owner sees a readable problem, but nothing here trusts that.

create function public.ledger_apply_file(p_file jsonb)
returns table (
  source_file_id       uuid,
  duplicate            boolean,
  rows_written         integer,
  transactions_written integer,
  settlements_written  integer,
  payouts_written      integer,
  issues_written       integer,
  unmapped_written     integer
)
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_uid         uuid := (select auth.uid());
  v_account_id  uuid;
  v_business_id uuid;
  v_account     public.marketplace_accounts;
  v_existing    uuid;
  v_file_id     uuid;
  v_format      text;
  v_version     text;
  v_sha         text;
  v_file_name   text;
  v_file_type   text;
  v_size        bigint;
  v_source_kind text;
  v_stripped    text[];
  v_problem     text;
  v_key         text;
  v_payout      record;
  v_payout_id   uuid;
  v_rows        integer;
  v_failed      integer;
  v_tx          integer;
  v_st          integer;
  v_po          integer;
  v_is          integer;
  v_unmapped    integer;
begin
  if v_uid is null then
    raise exception 'Not authenticated.' using errcode = '28000';
  end if;

  if p_file is null or jsonb_typeof(p_file) <> 'object' then
    raise exception 'The ledger file is not readable.' using errcode = '22023';
  end if;

  -- ---- the account, tenant and role ----------------------------------------
  if coalesce(p_file ->> 'marketplace_account_id', '')
       ~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' then
    v_account_id := (p_file ->> 'marketplace_account_id')::uuid;
  end if;

  select a.business_id into v_business_id
  from public.marketplace_accounts a where a.id = v_account_id;

  if v_business_id is null
     or v_business_id not in (select public.current_user_business_ids()) then
    raise exception 'That marketplace account could not be found.' using errcode = 'P0002';
  end if;

  if not public.current_user_has_role(
       v_business_id, array['OWNER', 'ADMIN', 'STAFF']::public.business_role[]) then
    raise exception 'A viewer cannot import data.' using errcode = '42501';
  end if;

  -- Serialises applies (and restores) per account, so the duplicate and
  -- settlement checks below cannot race.
  select * into v_account from public.marketplace_accounts a where a.id = v_account_id for update;

  if v_account.status <> 'ACTIVE' then
    raise exception 'This marketplace account is archived, so nothing more can be imported into it.'
      using errcode = 'P0001';
  end if;

  -- ---- the file record -----------------------------------------------------
  v_format      := nullif(trim(coalesce(p_file ->> 'format_id', '')), '');
  v_version     := nullif(trim(coalesce(p_file ->> 'adapter_version', '')), '');
  v_sha         := p_file ->> 'file_sha256';
  v_file_name   := nullif(trim(coalesce(p_file ->> 'file_name', '')), '');
  v_file_type   := p_file ->> 'file_type';
  v_source_kind := coalesce(nullif(p_file ->> 'source_kind', ''), 'UPLOAD');

  if v_format is null or length(v_format) > 120 then
    raise exception 'format_id is required.' using errcode = '22023';
  end if;
  if v_version is null or length(v_version) > 40 then
    raise exception 'adapter_version is required.' using errcode = '22023';
  end if;
  if coalesce(v_sha, '') !~ '^[0-9a-f]{64}$' then
    raise exception 'file_sha256 must be a lowercase SHA-256 hex digest.' using errcode = '22023';
  end if;
  if v_file_name is null or length(v_file_name) > 255 or public.ledger_text_has_email(v_file_name) then
    raise exception 'file_name is required, at most 255 characters, and may not contain an email address.'
      using errcode = '22023';
  end if;
  if coalesce(v_file_type, '') not in ('csv', 'xlsx') then
    raise exception 'file_type must be csv or xlsx.' using errcode = '22023';
  end if;
  if coalesce(p_file ->> 'file_size_bytes', '') !~ '^[0-9]{1,12}$' then
    raise exception 'file_size_bytes must be a whole number.' using errcode = '22023';
  end if;
  v_size := (p_file ->> 'file_size_bytes')::bigint;
  if v_source_kind not in ('UPLOAD', 'API') then
    raise exception 'source_kind must be UPLOAD or API.' using errcode = '22023';
  end if;

  foreach v_key in array array['columns', 'stripped_columns', 'settlements', 'payouts', 'transactions', 'issues']
  loop
    if p_file ? v_key and jsonb_typeof(p_file -> v_key) <> 'array' then
      raise exception '% must be an array.', v_key using errcode = '22023';
    end if;
  end loop;

  if exists (
    select 1
    from jsonb_array_elements(coalesce(p_file -> 'columns', '[]') || coalesce(p_file -> 'stripped_columns', '[]')) e
    where jsonb_typeof(e) <> 'string' or length(e #>> '{}') > 300
       or public.ledger_text_has_email(e #>> '{}')
  ) then
    raise exception 'columns and stripped_columns must be lists of column names.' using errcode = '22023';
  end if;

  v_stripped := array(select jsonb_array_elements_text(coalesce(p_file -> 'stripped_columns', '[]')));

  -- ---- the same file again is a no-op --------------------------------------
  select b.id into v_existing
  from public.import_batches b
  where b.dataset = 'LEDGER'
    and b.marketplace_account_id = v_account.id
    and b.file_sha256 = v_sha
    and b.withdrawn_at is null;

  if v_existing is not null then
    return query select v_existing, true, 0, 0, 0, 0, 0, 0;
    return;
  end if;

  -- ---- stage the payload ---------------------------------------------------
  if jsonb_typeof(p_file -> 'rows') is distinct from 'array'
     or jsonb_array_length(p_file -> 'rows') = 0 then
    raise exception 'A ledger file needs at least one source row.' using errcode = '22023';
  end if;
  if jsonb_array_length(p_file -> 'rows') > 50000 then
    raise exception 'A ledger file may hold at most 50,000 rows. Split it and apply each part.'
      using errcode = '22023';
  end if;

  drop table if exists pg_temp.ledger_in_rows;
  drop table if exists pg_temp.ledger_rows;
  drop table if exists pg_temp.ledger_in_settlements;
  drop table if exists pg_temp.ledger_in_payouts;
  drop table if exists pg_temp.ledger_in_transactions;
  drop table if exists pg_temp.ledger_in_issues;
  drop table if exists pg_temp.ledger_payout_ids;

  create temporary table ledger_in_rows on commit drop as
    select e.ordinality::integer as position, e.value as v
    from jsonb_array_elements(p_file -> 'rows') with ordinality e;

  -- ---- source rows ---------------------------------------------------------
  select format('Source row %s is not readable: it needs a row_number and an object of raw values.', r.position)
  into v_problem
  from pg_temp.ledger_in_rows r
  where jsonb_typeof(r.v) <> 'object'
     or coalesce(r.v ->> 'row_number', '') !~ '^[1-9][0-9]{0,6}$'
     or jsonb_typeof(r.v -> 'raw') is distinct from 'object'
  order by r.position
  limit 1;
  if v_problem is not null then raise exception '%', v_problem using errcode = '22023'; end if;

  select format('Row number %s appears more than once.', r.v ->> 'row_number')
  into v_problem
  from pg_temp.ledger_in_rows r
  group by r.v ->> 'row_number'
  having count(*) > 1
  limit 1;
  if v_problem is not null then raise exception '%', v_problem using errcode = '22023'; end if;

  select format('Row %s contains the customer-data column "%s". Customer details are never stored.',
                r.v ->> 'row_number', e.key)
  into v_problem
  from pg_temp.ledger_in_rows r
  cross join lateral jsonb_each(r.v -> 'raw') e
  where public.ledger_is_customer_column(e.key)
  order by r.position
  limit 1;
  if v_problem is not null then raise exception '%', v_problem using errcode = '22023'; end if;

  select format('Row %s, column "%s", contains an email address. Customer details are never stored.',
                r.v ->> 'row_number', e.key)
  into v_problem
  from pg_temp.ledger_in_rows r
  cross join lateral jsonb_each(r.v -> 'raw') e
  where jsonb_typeof(e.value) = 'string' and public.ledger_text_has_email(e.value #>> '{}')
  order by r.position
  limit 1;
  if v_problem is not null then raise exception '%', v_problem using errcode = '22023'; end if;

  select format('Row %s, column "%s", is not text. Source values are stored exactly as read, as text or blank.',
                r.v ->> 'row_number', e.key)
  into v_problem
  from pg_temp.ledger_in_rows r
  cross join lateral jsonb_each(r.v -> 'raw') e
  where jsonb_typeof(e.value) not in ('string', 'null')
  order by r.position
  limit 1;
  if v_problem is not null then raise exception '%', v_problem using errcode = '22023'; end if;

  create temporary table ledger_rows on commit drop as
    select (r.v ->> 'row_number')::integer as row_number, r.v -> 'raw' as raw
    from pg_temp.ledger_in_rows r;
  create unique index on pg_temp.ledger_rows (row_number);

  create temporary table ledger_in_settlements on commit drop as
    select e.ordinality::integer as position, e.value as v,
           case when e.value ->> 'source_row_number' ~ '^[1-9][0-9]{0,6}$'
                then (e.value ->> 'source_row_number')::integer end as row_no
    from jsonb_array_elements(coalesce(p_file -> 'settlements', '[]')) with ordinality e;

  create temporary table ledger_in_payouts on commit drop as
    select e.ordinality::integer as position, e.value as v,
           case when e.value ->> 'source_row_number' ~ '^[1-9][0-9]{0,6}$'
                then (e.value ->> 'source_row_number')::integer end as row_no
    from jsonb_array_elements(coalesce(p_file -> 'payouts', '[]')) with ordinality e;

  create temporary table ledger_in_transactions on commit drop as
    select e.ordinality::integer as position, e.value as v,
           case when e.value ->> 'source_row_number' ~ '^[1-9][0-9]{0,6}$'
                then (e.value ->> 'source_row_number')::integer end as row_no
    from jsonb_array_elements(coalesce(p_file -> 'transactions', '[]')) with ordinality e;
  create index on pg_temp.ledger_in_transactions (row_no);

  create temporary table ledger_in_issues on commit drop as
    select e.ordinality::integer as position, e.value as v,
           case when e.value ->> 'row_number' ~ '^[1-9][0-9]{0,6}$'
                then (e.value ->> 'row_number')::integer end as row_no
    from jsonb_array_elements(coalesce(p_file -> 'issues', '[]')) with ordinality e;

  -- ---- settlements ---------------------------------------------------------
  select format('Settlement %s: %s', s.position, x.problem)
  into v_problem
  from pg_temp.ledger_in_settlements s
  cross join lateral (
    select case
      when jsonb_typeof(s.v) <> 'object' then 'it is not readable'
      when jsonb_typeof(s.v -> 'external_settlement_id') is distinct from 'string'
           or length(s.v ->> 'external_settlement_id') not between 1 and 200
           or public.ledger_text_has_email(s.v ->> 'external_settlement_id')
        then 'external_settlement_id is required'
      when not exists (select 1 from pg_temp.ledger_rows r where r.row_number = s.row_no)
        then 'its source_row_number matches no source row, so it would have no lineage'
      when coalesce(s.v ->> 'currency', '') <> v_account.currency
        then format('its currency %s does not match the account currency %s',
                    coalesce(s.v ->> 'currency', '(blank)'), v_account.currency)
      when not (public.ledger_json_is_absent(s.v -> 'reported_total')
                or public.ledger_json_is_money(s.v -> 'reported_total'))
        then 'reported_total must be exact decimal text or blank'
      when not (public.ledger_json_is_absent(s.v -> 'period_start') or public.ledger_json_is_instant(s.v -> 'period_start'))
        or not (public.ledger_json_is_absent(s.v -> 'period_end') or public.ledger_json_is_instant(s.v -> 'period_end'))
        or not (public.ledger_json_is_absent(s.v -> 'reported_deposit_date') or public.ledger_json_is_instant(s.v -> 'reported_deposit_date'))
        then 'its dates must be timestamps with a time zone, or blank'
    end as problem
  ) x
  where x.problem is not null
  order by s.position
  limit 1;
  if v_problem is not null then raise exception '%', v_problem using errcode = '22023'; end if;

  select format('Settlement %s appears more than once in this file.', s.v ->> 'external_settlement_id')
  into v_problem
  from pg_temp.ledger_in_settlements s
  group by s.v ->> 'external_settlement_id'
  having count(*) > 1
  limit 1;
  if v_problem is not null then raise exception '%', v_problem using errcode = '22023'; end if;

  -- Decision B8: the same settlement may count once. A different file carrying
  -- it is refused, with the file already counting it named.
  select format('Settlement %s is already counted from the file "%s". Withdraw that file first if this one replaces it.',
                s.v ->> 'external_settlement_id', b.file_name)
  into v_problem
  from pg_temp.ledger_in_settlements s
  join public.settlements st
    on st.marketplace_account_id = v_account.id
   and st.external_settlement_id = s.v ->> 'external_settlement_id'
  join public.import_batches b on b.id = st.source_file_id and b.withdrawn_at is null
  order by s.position
  limit 1;
  if v_problem is not null then raise exception '%', v_problem using errcode = 'P0001'; end if;

  -- ---- payouts -------------------------------------------------------------
  select format('Payout %s: %s', p.position, x.problem)
  into v_problem
  from pg_temp.ledger_in_payouts p
  cross join lateral (
    select case
      when jsonb_typeof(p.v) <> 'object' then 'it is not readable'
      when jsonb_typeof(p.v -> 'key') is distinct from 'string'
           or length(p.v ->> 'key') not between 1 and 80
        then 'key is required'
      when not exists (select 1 from pg_temp.ledger_rows r where r.row_number = p.row_no)
        then 'its source_row_number matches no source row, so it would have no lineage'
      when public.ledger_json_is_absent(p.v -> 'amount')
        then 'its amount is blank. A payout without an amount is a row issue, not a payout'
      when not public.ledger_json_is_money(p.v -> 'amount')
        then 'its amount must be exact decimal text with at most 4 decimal places'
      when coalesce(p.v ->> 'currency', '') <> v_account.currency
        then format('its currency %s does not match the account currency %s',
                    coalesce(p.v ->> 'currency', '(blank)'), v_account.currency)
      when not (public.ledger_json_is_absent(p.v -> 'paid_at') or public.ledger_json_is_instant(p.v -> 'paid_at'))
        then 'paid_at must be a timestamp with a time zone, or blank'
      when not public.ledger_json_is_optional_text(p.v -> 'external_ref', 200)
        then 'external_ref is too long or contains an email address'
      when coalesce(p.v ->> 'settlement_ref', '') <> ''
           and not exists (select 1 from pg_temp.ledger_in_settlements s
                           where s.v ->> 'external_settlement_id' = p.v ->> 'settlement_ref')
        then 'its settlement_ref names no settlement in this file'
    end as problem
  ) x
  where x.problem is not null
  order by p.position
  limit 1;
  if v_problem is not null then raise exception '%', v_problem using errcode = '22023'; end if;

  select format('Payout key %s appears more than once.', p.v ->> 'key')
  into v_problem
  from pg_temp.ledger_in_payouts p
  group by p.v ->> 'key'
  having count(*) > 1
  limit 1;
  if v_problem is not null then raise exception '%', v_problem using errcode = '22023'; end if;

  -- ---- transactions --------------------------------------------------------
  select format('Transaction %s: %s', t.position, x.problem)
  into v_problem
  from pg_temp.ledger_in_transactions t
  left join public.ledger_mapping_rules mr
    on mr.id = case
                 when coalesce(t.v ->> 'mapping_rule_id', '')
                      ~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
                 then (t.v ->> 'mapping_rule_id')::uuid
               end
  cross join lateral (
    select case
      when jsonb_typeof(t.v) <> 'object' then 'it is not readable'
      when not exists (select 1 from pg_temp.ledger_rows r where r.row_number = t.row_no)
        then 'its source_row_number matches no source row, so it would have no lineage'
      when coalesce(t.v ->> 'line_index', '0') !~ '^[0-9]{1,4}$'
        then 'line_index must be a whole number'
      when coalesce(t.v ->> 'attribution', '') not in ('ORDER_LINE', 'ORDER', 'MARKETPLACE')
        then 'attribution must be ORDER_LINE, ORDER or MARKETPLACE'
      when public.ledger_json_is_absent(t.v -> 'amount')
        then 'its amount is blank. A blank amount is recorded as a row issue, never as a transaction'
      when not public.ledger_json_is_money(t.v -> 'amount')
        then 'its amount must be exact decimal text with at most 4 decimal places'
      when coalesce(t.v ->> 'currency', '') <> v_account.currency
        then format('its currency %s does not match the account currency %s',
                    coalesce(t.v ->> 'currency', '(blank)'), v_account.currency)
      when not public.ledger_json_is_instant(t.v -> 'posted_at')
        then 'posted_at must be a timestamp with a time zone'
      when not public.ledger_json_is_optional_text(t.v -> 'source_type', 200)
        or not public.ledger_json_is_optional_text(t.v -> 'source_subtype', 200)
        or not public.ledger_json_is_optional_text(t.v -> 'source_description', 500)
        or not public.ledger_json_is_optional_text(t.v -> 'order_ref', 200)
        or not public.ledger_json_is_optional_text(t.v -> 'order_line_ref', 200)
        or not public.ledger_json_is_optional_text(t.v -> 'raw_sku', 200)
        or not public.ledger_json_is_optional_text(t.v -> 'subcategory', 80)
        then 'a text field is too long or contains an email address'
      when not (public.ledger_json_is_absent(t.v -> 'quantity') or public.ledger_json_is_money(t.v -> 'quantity'))
        then 'quantity must be exact decimal text, or blank'
      when public.ledger_json_is_absent(t.v -> 'quantity') <> (coalesce(t.v ->> 'quantity_basis', '') = '')
        then 'quantity and quantity_basis must be given together'
      when coalesce(t.v ->> 'quantity_basis', '') not in ('', 'REPORTED', 'DERIVED_LINE_COUNT')
        then 'quantity_basis must be REPORTED or DERIVED_LINE_COUNT'
      when coalesce(t.v ->> 'settlement_ref', '') <> ''
           and not exists (select 1 from pg_temp.ledger_in_settlements s
                           where s.v ->> 'external_settlement_id' = t.v ->> 'settlement_ref')
        then 'its settlement_ref names no settlement in this file'
      when coalesce(t.v ->> 'payout_ref', '') <> ''
           and not exists (select 1 from pg_temp.ledger_in_payouts p where p.v ->> 'key' = t.v ->> 'payout_ref')
        then 'its payout_ref names no payout in this file'
      when coalesce(t.v ->> 'mapping_rule_id', '') = '' then
        case
          when t.v ->> 'category' is distinct from 'UNMAPPED'
            then 'a transaction without a mapping rule must be UNMAPPED'
          when coalesce(t.v ->> 'side', '') <> '' or coalesce(t.v ->> 'subcategory', '') <> ''
            then 'an UNMAPPED transaction has no side and no subcategory'
        end
      when mr.id is null then 'its mapping rule does not exist'
      when mr.status <> 'ACTIVE' then 'its mapping rule is retired'
      when mr.marketplace_code <> v_account.marketplace_code or mr.format_id <> v_format
        then 'its mapping rule belongs to a different marketplace or format'
      when mr.scope = 'BUSINESS' and mr.business_id is distinct from v_account.business_id
        then 'its mapping rule belongs to a different business'
      when t.v ->> 'side' is distinct from mr.side
        or t.v ->> 'category' is distinct from mr.category
        or coalesce(t.v ->> 'subcategory', '') <> coalesce(mr.subcategory, '')
        or t.v ->> 'attribution' is distinct from mr.attribution
        then 'its side, category, subcategory or attribution differ from its mapping rule'
      when mr.quantity_rule = 'NONE' and coalesce(t.v ->> 'quantity_basis', '') <> ''
        then 'its mapping rule records no quantity'
      when mr.quantity_rule = 'REPORTED' and coalesce(t.v ->> 'quantity_basis', 'REPORTED') <> 'REPORTED'
        then 'its mapping rule takes the quantity as reported'
      when mr.quantity_rule = 'COUNT_LINE' and t.v ->> 'quantity_basis' is distinct from 'DERIVED_LINE_COUNT'
        then 'its mapping rule counts the line as one unit, so quantity_basis must be DERIVED_LINE_COUNT'
    end as problem
  ) x
  where x.problem is not null
  order by t.position
  limit 1;
  if v_problem is not null then raise exception '%', v_problem using errcode = '22023'; end if;

  select format('Row %s has more than one transaction with line_index %s.',
                t.row_no, coalesce(t.v ->> 'line_index', '0'))
  into v_problem
  from pg_temp.ledger_in_transactions t
  group by t.row_no, coalesce(t.v ->> 'line_index', '0')
  having count(*) > 1
  limit 1;
  if v_problem is not null then raise exception '%', v_problem using errcode = '22023'; end if;

  -- ---- issues --------------------------------------------------------------
  select format('Row issue %s: %s', i.position, x.problem)
  into v_problem
  from pg_temp.ledger_in_issues i
  cross join lateral (
    select case
      when jsonb_typeof(i.v) <> 'object' then 'it is not readable'
      when not exists (select 1 from pg_temp.ledger_rows r where r.row_number = i.row_no)
        then 'its row_number matches no source row'
      when coalesce(i.v ->> 'severity', '') not in ('ERROR', 'WARNING')
        then 'severity must be ERROR or WARNING'
      when jsonb_typeof(i.v -> 'message') is distinct from 'string'
           or length(i.v ->> 'message') not between 1 and 500
           or public.ledger_text_has_email(i.v ->> 'message')
        then 'message is required and may not contain an email address'
      when not public.ledger_json_is_optional_text(i.v -> 'field', 120)
        or not public.ledger_json_is_optional_text(i.v -> 'raw_value', 500)
        then 'field or raw_value is too long or contains an email address'
    end as problem
  ) x
  where x.problem is not null
  order by i.position
  limit 1;
  if v_problem is not null then raise exception '%', v_problem using errcode = '22023'; end if;

  -- ---- nothing is silently dropped ------------------------------------------
  select format('Source row %s is not used by any transaction, settlement, payout or row issue. Every row must be accounted for.',
                r.row_number)
  into v_problem
  from pg_temp.ledger_rows r
  where not exists (select 1 from pg_temp.ledger_in_transactions t where t.row_no = r.row_number)
    and not exists (select 1 from pg_temp.ledger_in_settlements s where s.row_no = r.row_number)
    and not exists (select 1 from pg_temp.ledger_in_payouts p where p.row_no = r.row_number)
    and not exists (select 1 from pg_temp.ledger_in_issues i where i.row_no = r.row_number)
  order by r.row_number
  limit 1;
  if v_problem is not null then raise exception '%', v_problem using errcode = '22023'; end if;

  -- ---- write ---------------------------------------------------------------
  perform set_config('bizmind.ledger_writer', 'on', true);

  select count(*) into v_rows from pg_temp.ledger_rows;
  select count(distinct i.row_no) into v_failed
  from pg_temp.ledger_in_issues i where i.v ->> 'severity' = 'ERROR';
  select count(*) into v_tx from pg_temp.ledger_in_transactions;

  insert into public.import_batches (
    business_id, created_by, entity, status, file_name, file_type, file_size_bytes,
    columns, raw_rows, row_count, rows_valid, rows_failed, created_count, updated_count,
    committed_at, dataset, source_kind, marketplace_account_id, format_id, adapter_version,
    file_sha256, stripped_columns
  )
  values (
    v_account.business_id, v_uid, 'LEDGER', 'COMPLETED', v_file_name, v_file_type, v_size,
    coalesce(p_file -> 'columns', '[]'), '[]', v_rows, v_rows - v_failed, v_failed, v_tx, 0,
    now(), 'LEDGER', v_source_kind, v_account.id, v_format, v_version,
    v_sha, v_stripped
  )
  returning id into v_file_id;

  insert into public.source_rows (business_id, source_file_id, row_number, raw, row_hash)
  select v_account.business_id, v_file_id, r.row_number, r.raw,
         encode(sha256(convert_to(r.raw::text, 'UTF8')), 'hex')
  from pg_temp.ledger_rows r
  order by r.row_number;

  insert into public.settlements (
    business_id, marketplace_account_id, source_file_id, source_row_id, external_settlement_id,
    period_start, period_end, reported_total, reported_deposit_date, currency
  )
  select v_account.business_id, v_account.id, v_file_id, sr.id, s.v ->> 'external_settlement_id',
         (s.v ->> 'period_start')::timestamptz, (s.v ->> 'period_end')::timestamptz,
         (s.v ->> 'reported_total')::numeric, (s.v ->> 'reported_deposit_date')::timestamptz,
         v_account.currency
  from pg_temp.ledger_in_settlements s
  join public.source_rows sr on sr.source_file_id = v_file_id and sr.row_number = s.row_no
  order by s.position;
  get diagnostics v_st = row_count;

  create temporary table ledger_payout_ids (key text primary key, id uuid not null) on commit drop;

  v_po := 0;
  for v_payout in
    select p.v, sr.id as source_row_id, st.id as settlement_id
    from pg_temp.ledger_in_payouts p
    join public.source_rows sr on sr.source_file_id = v_file_id and sr.row_number = p.row_no
    left join public.settlements st
      on st.source_file_id = v_file_id and st.external_settlement_id = p.v ->> 'settlement_ref'
    order by p.position
  loop
    insert into public.payouts (
      business_id, marketplace_account_id, origin, source_file_id, source_row_id, settlement_id,
      external_ref, amount, currency, paid_at
    )
    values (
      v_account.business_id, v_account.id, 'SOURCE_FILE', v_file_id, v_payout.source_row_id,
      v_payout.settlement_id, v_payout.v ->> 'external_ref', (v_payout.v ->> 'amount')::numeric,
      v_account.currency, (v_payout.v ->> 'paid_at')::timestamptz
    )
    returning id into v_payout_id;

    insert into pg_temp.ledger_payout_ids (key, id) values (v_payout.v ->> 'key', v_payout_id);
    v_po := v_po + 1;
  end loop;

  insert into public.financial_transactions (
    business_id, marketplace_account_id, source_file_id, source_row_id, line_index,
    mapping_rule_id, side, category, subcategory, source_type, source_subtype, source_description,
    amount, currency, posted_at, order_ref, order_line_ref, raw_sku, quantity, quantity_basis,
    attribution, settlement_id, payout_id
  )
  select v_account.business_id, v_account.id, v_file_id, sr.id,
         coalesce((t.v ->> 'line_index')::smallint, 0),
         nullif(t.v ->> 'mapping_rule_id', '')::uuid,
         nullif(t.v ->> 'side', ''), t.v ->> 'category', nullif(t.v ->> 'subcategory', ''),
         t.v ->> 'source_type', t.v ->> 'source_subtype', t.v ->> 'source_description',
         (t.v ->> 'amount')::numeric, v_account.currency, (t.v ->> 'posted_at')::timestamptz,
         t.v ->> 'order_ref', t.v ->> 'order_line_ref', t.v ->> 'raw_sku',
         (t.v ->> 'quantity')::numeric, nullif(t.v ->> 'quantity_basis', ''),
         t.v ->> 'attribution', st.id, po.id
  from pg_temp.ledger_in_transactions t
  join public.source_rows sr on sr.source_file_id = v_file_id and sr.row_number = t.row_no
  left join public.settlements st
    on st.source_file_id = v_file_id and st.external_settlement_id = t.v ->> 'settlement_ref'
  left join pg_temp.ledger_payout_ids po on po.key = t.v ->> 'payout_ref'
  order by t.position;

  insert into public.import_issues (business_id, batch_id, row_number, severity, field, message, raw_value)
  select v_account.business_id, v_file_id, i.row_no, i.v ->> 'severity', i.v ->> 'field',
         i.v ->> 'message', i.v ->> 'raw_value'
  from pg_temp.ledger_in_issues i
  order by i.position;
  get diagnostics v_is = row_count;

  select count(*) into v_unmapped
  from public.financial_transactions ft
  where ft.source_file_id = v_file_id and ft.category = 'UNMAPPED';

  perform public.write_audit_log(
    v_account.business_id, 'ledger.file_applied', 'import_batches', v_file_id, null,
    jsonb_build_object(
      'file_name', v_file_name,
      'format_id', v_format,
      'adapter_version', v_version,
      'file_sha256', v_sha,
      'marketplace_account_id', v_account.id,
      'rows', v_rows,
      'transactions', v_tx,
      'settlements', v_st,
      'payouts', v_po,
      'issues', v_is,
      'unmapped', v_unmapped,
      'stripped_columns', to_jsonb(v_stripped),
      'totals', (
        select coalesce(jsonb_object_agg(x.k, x.total), '{}')
        from (
          select coalesce(ft.side, 'UNMAPPED') || '.' || ft.category as k, sum(ft.amount)::text as total
          from public.financial_transactions ft
          where ft.source_file_id = v_file_id
          group by 1
        ) x
      )
    )
  );

  return query select v_file_id, false, v_rows, v_tx, v_st, v_po, v_is, v_unmapped;
end;
$$;

comment on function public.ledger_apply_file(jsonb) is
  'The only way a ledger row is written. Validates lineage, currency, money '
  'text, mapping rules and customer data, then writes one file atomically.';


-- ----------------------------------------------------------------------------
-- 13. Withdraw and restore a ledger file (OWNER, ADMIN)
-- ----------------------------------------------------------------------------

create function public.ledger_file_withdraw(p_source_file_id uuid, p_reason text default null)
returns table (
  transactions_withdrawn bigint,
  settlements_withdrawn  bigint,
  payouts_withdrawn      bigint
)
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_file   public.import_batches;
  v_reason text := nullif(trim(coalesce(p_reason, '')), '');
  v_tx     bigint;
  v_st     bigint;
  v_po     bigint;
begin
  if (select auth.uid()) is null then
    raise exception 'Not authenticated.' using errcode = '28000';
  end if;

  select * into v_file from public.import_batches b where b.id = p_source_file_id;

  -- Another business's file is indistinguishable from one that does not exist.
  if v_file.id is null
     or v_file.business_id not in (select public.current_user_business_ids()) then
    raise exception 'That file could not be found.' using errcode = 'P0002';
  end if;

  if v_file.dataset <> 'LEDGER' then
    raise exception 'This is not a ledger file. Withdraw it from Data Sources.' using errcode = 'P0001';
  end if;

  if not public.current_user_has_role(v_file.business_id, array['OWNER', 'ADMIN']::public.business_role[]) then
    raise exception 'Only an owner or admin can withdraw a file.' using errcode = '42501';
  end if;

  select * into v_file from public.import_batches b where b.id = p_source_file_id for update;

  if v_file.withdrawn_at is not null then
    raise exception 'This file has already been withdrawn.' using errcode = 'P0001';
  end if;

  if v_reason is not null and (length(v_reason) > 500 or public.ledger_text_has_email(v_reason)) then
    raise exception 'The reason must be at most 500 characters and may not contain an email address.'
      using errcode = '22023';
  end if;

  perform set_config('bizmind.ledger_writer', 'on', true);
  perform set_config('bizmind.lineage_writer', 'on', true);

  update public.import_batches b
  set withdrawn_at = now(), withdrawn_by = (select auth.uid()), withdrawal_reason = v_reason
  where b.id = v_file.id;

  select count(*) into v_tx from public.financial_transactions ft where ft.source_file_id = v_file.id;
  select count(*) into v_st from public.settlements st where st.source_file_id = v_file.id;
  select count(*) into v_po from public.payouts po where po.source_file_id = v_file.id;

  perform public.write_audit_log(
    v_file.business_id, 'ledger.file_withdrawn', 'import_batches', v_file.id,
    jsonb_build_object('file_name', v_file.file_name, 'file_sha256', v_file.file_sha256),
    jsonb_build_object(
      'transactions', v_tx, 'settlements', v_st, 'payouts', v_po, 'reason', v_reason,
      'totals', (
        select coalesce(jsonb_object_agg(x.k, x.total), '{}')
        from (
          select coalesce(ft.side, 'UNMAPPED') || '.' || ft.category as k, sum(ft.amount)::text as total
          from public.financial_transactions ft
          where ft.source_file_id = v_file.id
          group by 1
        ) x
      )
    )
  );

  return query select v_tx, v_st, v_po;
end;
$$;

create function public.ledger_file_restore(p_source_file_id uuid)
returns table (
  transactions_restored bigint,
  settlements_restored  bigint,
  payouts_restored      bigint
)
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_file    public.import_batches;
  v_problem text;
  v_tx      bigint;
  v_st      bigint;
  v_po      bigint;
begin
  if (select auth.uid()) is null then
    raise exception 'Not authenticated.' using errcode = '28000';
  end if;

  select * into v_file from public.import_batches b where b.id = p_source_file_id;

  if v_file.id is null
     or v_file.business_id not in (select public.current_user_business_ids()) then
    raise exception 'That file could not be found.' using errcode = 'P0002';
  end if;

  if v_file.dataset <> 'LEDGER' then
    raise exception 'This is not a ledger file. Restore it from Data Sources.' using errcode = 'P0001';
  end if;

  if not public.current_user_has_role(v_file.business_id, array['OWNER', 'ADMIN']::public.business_role[]) then
    raise exception 'Only an owner or admin can restore a file.' using errcode = '42501';
  end if;

  -- Same lock order as ledger_apply_file: the account, then the file.
  perform 1 from public.marketplace_accounts a where a.id = v_file.marketplace_account_id for update;
  select * into v_file from public.import_batches b where b.id = p_source_file_id for update;

  if v_file.withdrawn_at is null then
    raise exception 'This file is not withdrawn.' using errcode = 'P0001';
  end if;

  select format('An identical file ("%s") is already counting. Withdraw it before restoring this one.', b.file_name)
  into v_problem
  from public.import_batches b
  where b.dataset = 'LEDGER'
    and b.marketplace_account_id = v_file.marketplace_account_id
    and b.file_sha256 = v_file.file_sha256
    and b.withdrawn_at is null
    and b.id <> v_file.id
  limit 1;
  if v_problem is not null then raise exception '%', v_problem using errcode = 'P0001'; end if;

  select format('Settlement %s is already counted from the file "%s". Withdraw that file before restoring this one.',
                mine.external_settlement_id, b.file_name)
  into v_problem
  from public.settlements mine
  join public.settlements other
    on other.marketplace_account_id = mine.marketplace_account_id
   and other.external_settlement_id = mine.external_settlement_id
   and other.source_file_id <> mine.source_file_id
  join public.import_batches b on b.id = other.source_file_id and b.withdrawn_at is null
  where mine.source_file_id = v_file.id
  limit 1;
  if v_problem is not null then raise exception '%', v_problem using errcode = 'P0001'; end if;

  perform set_config('bizmind.ledger_writer', 'on', true);
  perform set_config('bizmind.lineage_writer', 'on', true);

  update public.import_batches b
  set withdrawn_at = null, withdrawn_by = null, withdrawal_reason = null
  where b.id = v_file.id;

  select count(*) into v_tx from public.financial_transactions ft where ft.source_file_id = v_file.id;
  select count(*) into v_st from public.settlements st where st.source_file_id = v_file.id;
  select count(*) into v_po from public.payouts po where po.source_file_id = v_file.id;

  perform public.write_audit_log(
    v_file.business_id, 'ledger.file_restored', 'import_batches', v_file.id,
    jsonb_build_object('withdrawn_at', v_file.withdrawn_at, 'reason', v_file.withdrawal_reason),
    jsonb_build_object('transactions', v_tx, 'settlements', v_st, 'payouts', v_po)
  );

  return query select v_tx, v_st, v_po;
end;
$$;


-- ----------------------------------------------------------------------------
-- 14. The counting scope (read views)
-- ----------------------------------------------------------------------------
-- security_invoker: RLS on the underlying tables decides what a caller sees.
-- Money is cast to text while still exact (MONEY.md).

create view public.ledger_lines
with (security_invoker = true)
as
select
  ft.id,
  ft.business_id,
  ft.marketplace_account_id,
  a.marketplace_code,
  ft.source_file_id,
  ft.source_row_id,
  ft.line_index,
  ft.mapping_rule_id,
  ft.side,
  ft.category,
  ft.subcategory,
  ft.source_type,
  ft.source_subtype,
  ft.source_description,
  ft.amount::text   as amount,
  ft.currency,
  ft.posted_at,
  ft.order_ref,
  ft.order_line_ref,
  ft.raw_sku,
  ft.quantity::text as quantity,
  ft.quantity_basis,
  ft.attribution,
  ft.settlement_id,
  ft.payout_id,
  ft.created_at
from public.financial_transactions ft
join public.import_batches b on b.id = ft.source_file_id and b.withdrawn_at is null
join public.marketplace_accounts a on a.id = ft.marketplace_account_id;

comment on view public.ledger_lines is
  'Ledger rows that currently count: their source file is not withdrawn. '
  'Money as exact text. A product_id column is added in Phase 4.';

create view public.ledger_settlements
with (security_invoker = true)
as
select
  st.id,
  st.business_id,
  st.marketplace_account_id,
  st.source_file_id,
  st.source_row_id,
  st.external_settlement_id,
  st.period_start,
  st.period_end,
  st.reported_total::text as reported_total,
  st.reported_deposit_date,
  st.currency,
  st.created_at
from public.settlements st
join public.import_batches b on b.id = st.source_file_id and b.withdrawn_at is null;

create view public.ledger_payouts
with (security_invoker = true)
as
select
  po.id,
  po.business_id,
  po.marketplace_account_id,
  po.origin,
  po.source_file_id,
  po.source_row_id,
  po.settlement_id,
  po.external_ref,
  po.amount::text as amount,
  po.currency,
  po.paid_at,
  po.created_at
from public.payouts po
left join public.import_batches b on b.id = po.source_file_id
where po.voided_at is null
  and (po.origin = 'MANUAL' or b.withdrawn_at is null);


-- ----------------------------------------------------------------------------
-- 15. Privileges
-- ----------------------------------------------------------------------------
-- Supabase grants every new table and function to anon, authenticated and
-- service_role by default. Everything is revoked and then granted back
-- deliberately.

do $$
declare
  t text;
  f text;
begin
  foreach t in array array[
    'marketplaces', 'marketplace_accounts', 'tax_profiles', 'source_rows',
    'ledger_mapping_rules', 'settlements', 'payouts', 'financial_transactions'
  ]
  loop
    execute format('revoke all on table public.%I from anon, authenticated, public', t);
    execute format('grant select on table public.%I to authenticated', t);
  end loop;

  -- The service role keeps its default row privileges (the confined trusted
  -- path and the live tests use it), but the triggers still refuse every
  -- ledger write outside ledger_apply_file(), and nobody may truncate.
  foreach t in array array['source_rows', 'settlements', 'payouts', 'financial_transactions']
  loop
    execute format('revoke truncate on table public.%I from service_role', t);
  end loop;

  foreach t in array array['ledger_lines', 'ledger_settlements', 'ledger_payouts']
  loop
    execute format('revoke all on table public.%I from anon, authenticated, public', t);
    execute format('grant select on table public.%I to authenticated', t);
  end loop;

  foreach f in array array[
    'public.marketplace_account_create(uuid, text, text, text, text, text)',
    'public.marketplace_account_update(uuid, text, text, text, text)',
    'public.tax_profile_update(uuid, text, text)',
    'public.ledger_apply_file(jsonb)',
    'public.ledger_file_withdraw(uuid, text)',
    'public.ledger_file_restore(uuid)'
  ]
  loop
    execute format('revoke all on function %s from anon, public', f);
    execute format('grant execute on function %s to authenticated', f);
  end loop;

  foreach f in array array[
    'public.ledger_is_customer_column(text)',
    'public.ledger_text_has_email(text)',
    'public.ledger_raw_is_clean(jsonb)',
    'public.ledger_category_valid(text, text)',
    'public.ledger_json_is_money(jsonb)',
    'public.ledger_json_is_instant(jsonb)',
    'public.ledger_json_is_absent(jsonb)',
    'public.ledger_json_is_optional_text(jsonb, integer)'
  ]
  loop
    execute format('revoke all on function %s from anon, public', f);
    execute format('grant execute on function %s to authenticated, service_role', f);
  end loop;

  foreach f in array array[
    'public.ledger_writer_active()',
    'public.ledger_immutable_guard()',
    'public.ledger_truncate_guard()',
    'public.payout_guard()',
    'public.marketplace_account_guard()',
    'public.ledger_mapping_rule_guard()',
    'public.import_batch_ledger_guard()',
    'public.import_issue_ledger_guard()'
  ]
  loop
    execute format('revoke all on function %s from anon, authenticated, public', f);
  end loop;
end;
$$;


-- ----------------------------------------------------------------------------
-- 16. Self-verification
-- ----------------------------------------------------------------------------

do $$
declare
  t   text;
  f   text;
  v_n integer;
begin
  -- RLS enabled AND forced on every new table.
  foreach t in array array[
    'marketplaces', 'marketplace_accounts', 'tax_profiles', 'source_rows',
    'ledger_mapping_rules', 'settlements', 'payouts', 'financial_transactions'
  ]
  loop
    if not exists (
      select 1 from pg_class c join pg_namespace n on n.oid = c.relnamespace
      where n.nspname = 'public' and c.relname = t
        and c.relrowsecurity and c.relforcerowsecurity
    ) then
      raise exception 'SECURITY: RLS is not enabled and forced on public.%.', t;
    end if;

    if has_table_privilege('authenticated', format('public.%I', t), 'INSERT')
       or has_table_privilege('authenticated', format('public.%I', t), 'UPDATE')
       or has_table_privilege('authenticated', format('public.%I', t), 'DELETE')
       or has_table_privilege('authenticated', format('public.%I', t), 'TRUNCATE') then
      raise exception 'SECURITY: authenticated can write public.% directly.', t;
    end if;

    if has_table_privilege('anon', format('public.%I', t), 'SELECT') then
      raise exception 'SECURITY: anon can read public.%.', t;
    end if;

    if not has_table_privilege('authenticated', format('public.%I', t), 'SELECT') then
      raise exception 'authenticated cannot read public.%.', t;
    end if;
  end loop;

  -- The views are invoker views, so RLS applies through them.
  foreach t in array array['ledger_lines', 'ledger_settlements', 'ledger_payouts']
  loop
    if not exists (
      select 1 from pg_class c join pg_namespace n on n.oid = c.relnamespace
      where n.nspname = 'public' and c.relname = t
        and coalesce(c.reloptions, '{}') @> array['security_invoker=true']
    ) then
      raise exception 'SECURITY: public.% is not a security_invoker view.', t;
    end if;
    if has_table_privilege('anon', format('public.%I', t), 'SELECT') then
      raise exception 'SECURITY: anon can read public.%.', t;
    end if;
  end loop;

  -- The guards are in place.
  foreach t in array array[
    'source_rows_immutable', 'source_rows_no_truncate',
    'settlements_immutable', 'settlements_no_truncate',
    'financial_transactions_immutable', 'financial_transactions_no_truncate',
    'payouts_guard', 'payouts_no_truncate',
    'marketplace_accounts_guard', 'ledger_mapping_rules_guard',
    'import_batches_ledger_guard', 'import_issues_ledger_guard'
  ]
  loop
    if not exists (select 1 from pg_trigger where tgname = t and not tgisinternal) then
      raise exception 'Guard trigger % is missing.', t;
    end if;
  end loop;

  -- Composite foreign keys: a ledger row cannot point into another business,
  -- and its source row must belong to its source file.
  select count(*) into v_n
  from pg_constraint
  where conrelid = 'public.financial_transactions'::regclass and contype = 'f'
    and conname in ('financial_transactions_account_fkey', 'financial_transactions_source_row_fkey',
                    'financial_transactions_settlement_fkey', 'financial_transactions_payout_fkey');
  if v_n <> 4 then
    raise exception 'Expected 4 composite foreign keys on financial_transactions, found %.', v_n;
  end if;

  -- Every data-changing function checks the caller.
  foreach f in array array[
    'marketplace_account_create', 'marketplace_account_update', 'tax_profile_update',
    'ledger_apply_file', 'ledger_file_withdraw', 'ledger_file_restore'
  ]
  loop
    if not exists (
      select 1 from pg_proc p join pg_namespace n on n.oid = p.pronamespace
      where n.nspname = 'public' and p.proname = f
        and p.prosecdef
        and position('current_user_has_role' in p.prosrc) > 0
        and position('current_user_business_ids' in p.prosrc) > 0
    ) then
      raise exception 'SECURITY: %() does not check the caller''s membership and role.', f;
    end if;

    if exists (
      select 1 from pg_proc p join pg_namespace n on n.oid = p.pronamespace
      where n.nspname = 'public' and p.proname = f
        and has_function_privilege('anon', p.oid, 'EXECUTE')
    ) then
      raise exception 'SECURITY: anon can execute %().', f;
    end if;
  end loop;

  -- The writer rule is behavioural, so prove it: without the writer flag, even
  -- this migration's own role cannot insert a ledger row.
  foreach t in array array['source_rows', 'settlements', 'payouts', 'financial_transactions']
  loop
    begin
      execute format('insert into public.%I (business_id) values (gen_random_uuid())', t);
      raise exception 'SELF-CHECK: a % row was inserted without the writer.', t;
    exception when others then
      if sqlerrm not like '%ledger_apply_file%' and sqlerrm not like '%ledger functions%' then
        raise exception 'SELF-CHECK failed for %: %', t, sqlerrm;
      end if;
    end;
  end loop;

  begin
    insert into public.import_batches (business_id, entity, file_name, file_type, file_size_bytes, dataset)
    values (gen_random_uuid(), 'ORDERS', 'x.csv', 'csv', 0, 'LEDGER');
    raise exception 'SELF-CHECK: a ledger file was created without the writer.';
  exception when others then
    if sqlerrm not like '%ledger_apply_file%' then
      raise exception 'SELF-CHECK failed for import_batches: %', sqlerrm;
    end if;
  end;

  -- The customer-data rules behave as intended.
  if not public.ledger_is_customer_column('buyer-email')
     or not public.ledger_is_customer_column('Customer Name')
     or not public.ledger_is_customer_column('ship-to-address')
     or public.ledger_is_customer_column('sku')
     or public.ledger_is_customer_column('posted-date-time')
     or public.ledger_is_customer_column('shipment-id')
     or public.ledger_is_customer_column('amount-description') then
    raise exception 'SELF-CHECK: the customer-column rule does not behave as intended.';
  end if;

  if not public.ledger_text_has_email('Refund for ali@example.com')
     or public.ledger_text_has_email('403-1234567-1234567') then
    raise exception 'SELF-CHECK: the email rule does not behave as intended.';
  end if;

  -- Existing imports are untouched.
  if exists (select 1 from public.import_batches where dataset <> 'LEGACY') then
    raise exception 'Existing imports should all be LEGACY after this migration.';
  end if;

  select count(*) into v_n from public.marketplaces;
  if v_n <> 3 then
    raise exception 'Expected 3 marketplaces, found %.', v_n;
  end if;

  raise notice
    'Migration 0030 verified: the ledger is immutable, has one writer, is '
    'tenant-isolated by RLS and composite keys, refuses customer data, and '
    'leaves every existing import untouched.';
end;
$$;


commit;
