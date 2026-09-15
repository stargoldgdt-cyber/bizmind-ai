-- ============================================================================
-- 0031  Amazon Flat File V2 settlements
-- ============================================================================
-- GCC Phase 2. The Amazon adapter (src/services/marketplaces/amazon/) reads the
-- settlement report; this migration gives the ledger what it needs to accept
-- it. Built and verified against four real Amazon.ae settlements (AMAZON.md).
--
-- WHAT CHANGES
--   1. Ledger files may be .txt (Amazon's tab-separated report).
--      import_batches file_type check + ledger_apply_file() -- the function is
--      copied verbatim from 0030 with only that one line changed.
--   2. 21 GLOBAL mapping rules for format amazon.settlement.flat_file_v2, as
--      approved by the owner on 2026-09-15 (decisions B2, B3):
--        SP 360 "Premium Services Fee"  marketplace fee, marketplace level
--        "Tax on fee"                   TAX . FEE_VAT (separate VAT line)
--        COD charge                     OTHER_INCOME (not sales)
--        refunded units                 one per Principal refund line (derived)
--   3. marketplaces.AMAZON becomes AVAILABLE.
--   4. Data Sources understands ledger files:
--        import_batch_overview()         + dataset, format, account, counts
--        import_batch_withdrawal_preview() refuses a ledger file
--        ledger_file_summary()           lines and exact totals per category
--        ledger_file_settlements()       each settlement: Amazon's total, the
--                                        sum of its lines, and its payout
--
-- Nothing is removed. Depends on 0030. APPLY THIS IN THE SUPABASE SQL EDITOR.
-- Clear the editor first: click in it, press Ctrl+A, then Delete.
-- ============================================================================

begin;


-- ----------------------------------------------------------------------------
-- 1. .txt ledger files
-- ----------------------------------------------------------------------------

do $$
declare
  v_name text;
begin
  for v_name in
    select c.conname
    from pg_constraint c
    where c.conrelid = 'public.import_batches'::regclass
      and c.contype = 'c'
      and pg_get_constraintdef(c.oid) ilike '%file_type%'
  loop
    execute format('alter table public.import_batches drop constraint %I', v_name);
  end loop;
end;
$$;

alter table public.import_batches
  add constraint import_batches_file_type_check
  check (file_type in ('csv', 'xlsx', 'api', 'txt'));

create or replace function public.ledger_apply_file(p_file jsonb)
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
  if coalesce(v_file_type, '') not in ('csv', 'xlsx', 'txt') then
    raise exception 'file_type must be csv, xlsx or txt.' using errcode = '22023';
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


-- ----------------------------------------------------------------------------
-- 2. Amazon Flat File V2 mapping rules (owner-approved, 2026-09-15)
-- ----------------------------------------------------------------------------

insert into public.ledger_mapping_rules (
  scope, business_id, marketplace_code, format_id, match_key, match, side, category, subcategory,
  sign_rule, quantity_rule, attribution, confidence, evidence, version, status
)
select 'GLOBAL', null, 'AMAZON', 'amazon.settlement.flat_file_v2', r.match_key, r.match, r.side, r.category,
       r.subcategory, 'AS_REPORTED', r.quantity_rule, r.attribution, 'SAMPLE_VERIFIED', r.evidence, 1, 'ACTIVE'
from (values
  ('Order|ItemPrice|Principal', '{"transaction-type": "Order", "amount-type": "ItemPrice", "amount-description": "Principal"}'::jsonb, 'PNL', 'REVENUE', 'principal', 'REPORTED', 'ORDER_LINE', 'Verified on four Amazon.ae Flat File V2 settlements (18 Jun - 13 Aug 2026) supplied by the owner; every settlement reconciled to its reported total. Classification approved by the owner on 2026-09-15. Product sales. Carries the units sold.'),
  ('Order|ItemPrice|Shipping', '{"transaction-type": "Order", "amount-type": "ItemPrice", "amount-description": "Shipping"}'::jsonb, 'PNL', 'REVENUE', 'shipping_charged', 'NONE', 'ORDER_LINE', 'Verified on four Amazon.ae Flat File V2 settlements (18 Jun - 13 Aug 2026) supplied by the owner; every settlement reconciled to its reported total. Classification approved by the owner on 2026-09-15. Shipping charged to the buyer. Part of gross with Principal.'),
  ('Order|ItemPrice|COD', '{"transaction-type": "Order", "amount-type": "ItemPrice", "amount-description": "COD"}'::jsonb, 'PNL', 'OTHER_INCOME', 'cod_charge', 'NONE', 'ORDER_LINE', 'Verified on four Amazon.ae Flat File V2 settlements (18 Jun - 13 Aug 2026) supplied by the owner; every settlement reconciled to its reported total. Classification approved by the owner on 2026-09-15. Cash-on-delivery charge collected. Owner decision: other income, not sales; offset by the COD fee.'),
  ('Order|ItemFees|CODFee', '{"transaction-type": "Order", "amount-type": "ItemFees", "amount-description": "CODFee"}'::jsonb, 'PNL', 'MARKETPLACE_FEE', 'cod', 'NONE', 'ORDER_LINE', 'Verified on four Amazon.ae Flat File V2 settlements (18 Jun - 13 Aug 2026) supplied by the owner; every settlement reconciled to its reported total. Classification approved by the owner on 2026-09-15. Cash-on-delivery fee.'),
  ('Order|ItemFees|Commission', '{"transaction-type": "Order", "amount-type": "ItemFees", "amount-description": "Commission"}'::jsonb, 'PNL', 'MARKETPLACE_FEE', 'referral', 'NONE', 'ORDER_LINE', 'Verified on four Amazon.ae Flat File V2 settlements (18 Jun - 13 Aug 2026) supplied by the owner; every settlement reconciled to its reported total. Classification approved by the owner on 2026-09-15. Referral commission.'),
  ('Order|ItemFees|FBAPerUnitFulfillmentFee', '{"transaction-type": "Order", "amount-type": "ItemFees", "amount-description": "FBAPerUnitFulfillmentFee"}'::jsonb, 'PNL', 'FULFILMENT', 'fba_per_unit', 'NONE', 'ORDER_LINE', 'Verified on four Amazon.ae Flat File V2 settlements (18 Jun - 13 Aug 2026) supplied by the owner; every settlement reconciled to its reported total. Classification approved by the owner on 2026-09-15. FBA fulfilment fee per unit.'),
  ('Order|ItemFees|ShippingChargeback', '{"transaction-type": "Order", "amount-type": "ItemFees", "amount-description": "ShippingChargeback"}'::jsonb, 'PNL', 'FULFILMENT', 'shipping_chargeback', 'NONE', 'ORDER_LINE', 'Verified on four Amazon.ae Flat File V2 settlements (18 Jun - 13 Aug 2026) supplied by the owner; every settlement reconciled to its reported total. Classification approved by the owner on 2026-09-15. Shipping cost charged back to the seller.'),
  ('Order|ItemFees|VariableClosingFee', '{"transaction-type": "Order", "amount-type": "ItemFees", "amount-description": "VariableClosingFee"}'::jsonb, 'PNL', 'MARKETPLACE_FEE', 'closing', 'NONE', 'ORDER_LINE', 'Verified on four Amazon.ae Flat File V2 settlements (18 Jun - 13 Aug 2026) supplied by the owner; every settlement reconciled to its reported total. Classification approved by the owner on 2026-09-15. Variable closing fee.'),
  ('Order|Promotion|Shipping', '{"transaction-type": "Order", "amount-type": "Promotion", "amount-description": "Shipping"}'::jsonb, 'PNL', 'PROMOTION', 'shipping', 'NONE', 'ORDER_LINE', 'Verified on four Amazon.ae Flat File V2 settlements (18 Jun - 13 Aug 2026) supplied by the owner; every settlement reconciled to its reported total. Classification approved by the owner on 2026-09-15. Shipping promotion.'),
  ('Refund|ItemPrice|Principal', '{"transaction-type": "Refund", "amount-type": "ItemPrice", "amount-description": "Principal"}'::jsonb, 'PNL', 'REFUND', 'principal', 'COUNT_LINE', 'ORDER_LINE', 'Verified on four Amazon.ae Flat File V2 settlements (18 Jun - 13 Aug 2026) supplied by the owner; every settlement reconciled to its reported total. Classification approved by the owner on 2026-09-15. Refunded sales. Refund lines carry no quantity; each line counts as one refunded unit (derived).'),
  ('Refund|ItemPrice|Shipping', '{"transaction-type": "Refund", "amount-type": "ItemPrice", "amount-description": "Shipping"}'::jsonb, 'PNL', 'REFUND', 'shipping_charged', 'NONE', 'ORDER_LINE', 'Verified on four Amazon.ae Flat File V2 settlements (18 Jun - 13 Aug 2026) supplied by the owner; every settlement reconciled to its reported total. Classification approved by the owner on 2026-09-15. Refunded shipping charge.'),
  ('Refund|ItemPrice|COD', '{"transaction-type": "Refund", "amount-type": "ItemPrice", "amount-description": "COD"}'::jsonb, 'PNL', 'OTHER_INCOME', 'cod_charge', 'NONE', 'ORDER_LINE', 'Verified on four Amazon.ae Flat File V2 settlements (18 Jun - 13 Aug 2026) supplied by the owner; every settlement reconciled to its reported total. Classification approved by the owner on 2026-09-15. Refunded cash-on-delivery charge.'),
  ('Refund|ItemFees|CODFee', '{"transaction-type": "Refund", "amount-type": "ItemFees", "amount-description": "CODFee"}'::jsonb, 'PNL', 'MARKETPLACE_FEE', 'cod', 'NONE', 'ORDER_LINE', 'Verified on four Amazon.ae Flat File V2 settlements (18 Jun - 13 Aug 2026) supplied by the owner; every settlement reconciled to its reported total. Classification approved by the owner on 2026-09-15. Cash-on-delivery fee returned on a refund.'),
  ('Refund|ItemFees|Commission', '{"transaction-type": "Refund", "amount-type": "ItemFees", "amount-description": "Commission"}'::jsonb, 'PNL', 'MARKETPLACE_FEE', 'referral', 'NONE', 'ORDER_LINE', 'Verified on four Amazon.ae Flat File V2 settlements (18 Jun - 13 Aug 2026) supplied by the owner; every settlement reconciled to its reported total. Classification approved by the owner on 2026-09-15. Referral commission returned on a refund; nets against commission.'),
  ('Refund|ItemFees|RefundCommission', '{"transaction-type": "Refund", "amount-type": "ItemFees", "amount-description": "RefundCommission"}'::jsonb, 'PNL', 'MARKETPLACE_FEE', 'refund_administration', 'NONE', 'ORDER_LINE', 'Verified on four Amazon.ae Flat File V2 settlements (18 Jun - 13 Aug 2026) supplied by the owner; every settlement reconciled to its reported total. Classification approved by the owner on 2026-09-15. Refund administration fee Amazon keeps.'),
  ('Refund|ItemFees|ShippingChargeback', '{"transaction-type": "Refund", "amount-type": "ItemFees", "amount-description": "ShippingChargeback"}'::jsonb, 'PNL', 'FULFILMENT', 'shipping_chargeback', 'NONE', 'ORDER_LINE', 'Verified on four Amazon.ae Flat File V2 settlements (18 Jun - 13 Aug 2026) supplied by the owner; every settlement reconciled to its reported total. Classification approved by the owner on 2026-09-15. Shipping chargeback returned on a refund.'),
  ('Refund|Promotion|Shipping', '{"transaction-type": "Refund", "amount-type": "Promotion", "amount-description": "Shipping"}'::jsonb, 'PNL', 'PROMOTION', 'shipping', 'NONE', 'ORDER_LINE', 'Verified on four Amazon.ae Flat File V2 settlements (18 Jun - 13 Aug 2026) supplied by the owner; every settlement reconciled to its reported total. Classification approved by the owner on 2026-09-15. Shipping promotion reversed on a refund.'),
  ('ServiceFee|Cost of Advertising|TransactionTotalAmount', '{"transaction-type": "ServiceFee", "amount-type": "Cost of Advertising", "amount-description": "TransactionTotalAmount"}'::jsonb, 'PNL', 'ADVERTISING', 'sponsored_ads', 'NONE', 'MARKETPLACE', 'Verified on four Amazon.ae Flat File V2 settlements (18 Jun - 13 Aug 2026) supplied by the owner; every settlement reconciled to its reported total. Classification approved by the owner on 2026-09-15. Sponsored ads spend. No SKU; stays at marketplace level (A7).'),
  ('AmazonFees|Premium Services Fee|Base fee', '{"transaction-type": "AmazonFees", "amount-type": "Premium Services Fee", "amount-description": "Base fee"}'::jsonb, 'PNL', 'MARKETPLACE_FEE', 'premium_services', 'NONE', 'MARKETPLACE', 'Verified on four Amazon.ae Flat File V2 settlements (18 Jun - 13 Aug 2026) supplied by the owner; every settlement reconciled to its reported total. Classification approved by the owner on 2026-09-15. Amazon Selling Partner 360 (SP 360) service fee, confirmed by the owner. A marketplace fee, not advertising.'),
  ('AmazonFees|Premium Services Fee|Tax on fee', '{"transaction-type": "AmazonFees", "amount-type": "Premium Services Fee", "amount-description": "Tax on fee"}'::jsonb, 'TAX', 'FEE_VAT', 'premium_services', 'NONE', 'MARKETPLACE', 'Verified on four Amazon.ae Flat File V2 settlements (18 Jun - 13 Aug 2026) supplied by the owner; every settlement reconciled to its reported total. Classification approved by the owner on 2026-09-15. 5% VAT on the SP 360 fee. Owner decision: a separate VAT line; whether it counts in profit is decision B1.'),
  ('FBAFees|FBA Inventory Storage Fee|Base fee', '{"transaction-type": "FBAFees", "amount-type": "FBA Inventory Storage Fee", "amount-description": "Base fee"}'::jsonb, 'PNL', 'FULFILMENT', 'storage', 'NONE', 'MARKETPLACE', 'Verified on four Amazon.ae Flat File V2 settlements (18 Jun - 13 Aug 2026) supplied by the owner; every settlement reconciled to its reported total. Classification approved by the owner on 2026-09-15. FBA storage fee. A reported 0.00 is a recorded zero, not a blank.')
) as r (match_key, match, side, category, subcategory, quantity_rule, attribution, evidence)
where not exists (
  select 1 from public.ledger_mapping_rules existing
  where existing.business_id is null
    and existing.marketplace_code = 'AMAZON'
    and existing.format_id = 'amazon.settlement.flat_file_v2'
    and existing.match_key = r.match_key
);


-- ----------------------------------------------------------------------------
-- 3. Amazon is available
-- ----------------------------------------------------------------------------

update public.marketplaces set adapter_status = 'AVAILABLE' where code = 'AMAZON';


-- ----------------------------------------------------------------------------
-- 4. Data Sources
-- ----------------------------------------------------------------------------

-- The return type grows, so the function is dropped and created again.
drop function public.import_batch_overview(integer, integer);

create function public.import_batch_overview(
  p_limit  integer default 50,
  p_offset integer default 0
)
returns table (
  batch_id          uuid,
  business_id       uuid,
  entity            public.import_entity,
  status            public.import_status,
  source            public.channel_type,
  file_name         text,
  file_type         text,
  created_at        timestamptz,
  committed_at      timestamptz,
  row_count         integer,
  rows_valid        integer,
  rows_failed       integer,
  created_count     integer,
  updated_count     integer,
  errors_count      bigint,
  warnings_count    bigint,
  lineage_status    text,
  records_written   bigint,
  records_withdrawn bigint,
  withdrawn_at      timestamptz,
  withdrawal_reason text,
  connection_name   text,
  matched_count     bigint,
  -- Migration 0031: what a ledger (marketplace) file holds.
  dataset                text,
  format_id              text,
  marketplace_account_id uuid,
  marketplace_label      text,
  marketplace_code       text,
  transactions_count     bigint,
  settlements_count      bigint,
  payouts_count          bigint,
  unmapped_count         bigint
)
language sql
stable
security invoker
set search_path = ''
as $$
with visible as (
  select b.* from public.import_batches b
),
counted as (select count(*) as total from visible)
select
  b.id,
  b.business_id,
  b.entity,
  b.status,
  b.source,
  b.file_name,
  b.file_type,
  b.created_at,
  b.committed_at,
  b.row_count,
  b.rows_valid,
  b.rows_failed,
  b.created_count,
  b.updated_count,
  (select count(*) from public.import_issues i
    where i.batch_id = b.id and i.severity = 'ERROR')                as errors_count,
  (select count(*) from public.import_issues i
    where i.batch_id = b.id and i.severity = 'WARNING')              as warnings_count,
  b.lineage_status,
  case when b.dataset = 'LEDGER'
       then (select count(*) from public.financial_transactions ft where ft.source_file_id = b.id)
       else (select count(*) from public.record_lineage l where l.batch_id = b.id)
  end                                                                as records_written,
  case when b.dataset = 'LEDGER'
       then case when b.withdrawn_at is null then 0
                 else (select count(*) from public.financial_transactions ft where ft.source_file_id = b.id) end
       else (select count(*) from public.orders o where o.withdrawn_by_batch = b.id)
          + (select count(*) from public.products p where p.withdrawn_by_batch = b.id)
          + (select count(*) from public.expenses e where e.withdrawn_by_batch = b.id)
  end                                                                as records_withdrawn,
  b.withdrawn_at,
  b.withdrawal_reason,
  a.display_name                                                     as connection_name,
  (select total from counted)                                        as matched_count,
  b.dataset,
  b.format_id,
  b.marketplace_account_id,
  ma.label                                                           as marketplace_label,
  ma.marketplace_code,
  (select count(*) from public.financial_transactions ft where ft.source_file_id = b.id) as transactions_count,
  (select count(*) from public.settlements st where st.source_file_id = b.id)            as settlements_count,
  (select count(*) from public.payouts po where po.source_file_id = b.id)                as payouts_count,
  (select count(*) from public.financial_transactions ft
    where ft.source_file_id = b.id and ft.category = 'UNMAPPED')                         as unmapped_count
from visible b
left join public.integration_accounts a on a.id = b.integration_account_id
left join public.marketplace_accounts ma on ma.id = b.marketplace_account_id
order by b.created_at desc
limit greatest(p_limit, 1)
offset greatest(p_offset, 0);
$$;

create or replace function public.import_batch_withdrawal_preview(p_batch_id uuid)
returns table (
  batch_id           uuid,
  file_name          text,
  entity             public.import_entity,
  lineage_status     text,
  already_withdrawn  boolean,
  can_withdraw       boolean,
  blocked_reason     text,
  records_written    bigint,
  records_created    bigint,
  records_updated    bigint,
  /** Written ONLY by this import: these stop counting. */
  records_exclusive  bigint,
  /** Also written by something else: these stay exactly as they are. */
  records_shared     bigint,
  orders_exclusive   bigint,
  products_exclusive bigint,
  expenses_exclusive bigint,
  /** Who else wrote the shared ones, in the owner's language. */
  shared_with        text[]
)
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_batch public.import_batches;
begin
  select * into v_batch from public.import_batches where id = p_batch_id;

  -- SECURITY DEFINER, so this select saw every business. An import in a
  -- business the caller does not belong to must be indistinguishable from one
  -- that does not exist: a different message would confirm that this id is
  -- real, which is a fact about someone else's business.
  if v_batch.id is null
     or v_batch.business_id not in (select public.current_user_business_ids()) then
    raise exception 'That import could not be found.' using errcode = 'P0002';
  end if;

  -- A ledger file has its own withdrawal, which never touches order records.
  if v_batch.dataset = 'LEDGER' then
    raise exception 'This is a marketplace file. Withdraw it with ledger_file_withdraw().'
      using errcode = 'P0001';
  end if;

  if not public.current_user_has_role(
       v_batch.business_id, array['OWNER','ADMIN']::public.business_role[]) then
    raise exception 'Only an owner or admin can withdraw an import.'
      using errcode = '42501';
  end if;

  return query
  with mine as (
    select l.entity, l.record_id, l.how
    from public.record_lineage l
    where l.batch_id = p_batch_id
  ),
  judged as (
    select
      m.entity,
      m.record_id,
      m.how,
      exists (
        select 1
        from public.record_lineage o
        left join public.import_batches b on b.id = o.batch_id
        where o.entity = m.entity
          and o.record_id = m.record_id
          and o.batch_id is distinct from p_batch_id
          -- A writer that cannot be withdrawn (a direct edit, an origin that
          -- could not be traced) or an import still in force.
          and (o.batch_id is null or b.withdrawn_at is null)
      ) as shared
    from mine m
  ),
  others as (
    select distinct coalesce(
             b.file_name,
             case o.how
               when 'DIRECT'   then 'an edit made in BizMind'
               when 'UNTRACED' then 'a source that could not be traced'
               else 'another import'
             end) as label
    from judged j
    join public.record_lineage o
      on o.entity = j.entity and o.record_id = j.record_id
     and o.batch_id is distinct from p_batch_id
    left join public.import_batches b on b.id = o.batch_id
    where j.shared
      and (o.batch_id is null or b.withdrawn_at is null)
    limit 5
  )
  select
    v_batch.id,
    v_batch.file_name,
    v_batch.entity,
    v_batch.lineage_status,
    (v_batch.withdrawn_at is not null),
    (v_batch.withdrawn_at is null
      and v_batch.lineage_status in ('RECORDED', 'RECOVERED')),
    case
      when v_batch.withdrawn_at is not null then 'This import has already been withdrawn.'
      when v_batch.lineage_status = 'NONE' then
        'BizMind cannot tell which records this import wrote, because it kept no rows to rebuild from. Withdrawing it could remove data another source owns, so it is not offered.'
      when v_batch.lineage_status = 'INCOMPLETE' then
        'Some of what this import wrote cannot be identified -- rows with no reference of their own. Withdrawing it would leave those behind, so it is not offered.'
    end,
    (select count(*) from judged),
    (select count(*) from judged where judged.how = 'CREATED'),
    (select count(*) from judged where judged.how in ('UPDATED', 'RECOVERED')),
    (select count(*) from judged where not judged.shared),
    (select count(*) from judged where judged.shared),
    -- QUALIFIED: `entity` alone is also this function's output column.
    (select count(*) from judged where not judged.shared and judged.entity = 'ORDER'),
    (select count(*) from judged where not judged.shared and judged.entity = 'PRODUCT'),
    (select count(*) from judged where not judged.shared and judged.entity = 'EXPENSE'),
    (select coalesce(array_agg(others.label), '{}') from others);
end;
$$;

/** One ledger file's lines per category, with exact totals. RLS decides visibility. */
create function public.ledger_file_summary(p_source_file_id uuid)
returns table (
  side        text,
  category    text,
  subcategory text,
  lines       bigint,
  total       text,
  currency    char(3)
)
language sql
stable
security invoker
set search_path = ''
as $$
  select ft.side, ft.category, ft.subcategory, count(*), sum(ft.amount)::text, ft.currency
  from public.financial_transactions ft
  where ft.source_file_id = p_source_file_id
  group by ft.side, ft.category, ft.subcategory, ft.currency
  order by case ft.side when 'PNL' then 1 when 'CASH' then 2 when 'TAX' then 3 when 'MEMO' then 4 else 5 end,
           ft.category, ft.subcategory;
$$;

/**
 * Each settlement in a ledger file: what Amazon reported, what its lines add up
 * to, and the payout it reported. The comparison is made here, in SQL.
 */
create function public.ledger_file_settlements(p_source_file_id uuid)
returns table (
  settlement_id          uuid,
  external_settlement_id text,
  period_start           timestamptz,
  period_end             timestamptz,
  reported_total         text,
  lines_total            text,
  reconciles             boolean,
  reported_deposit_date  timestamptz,
  payout_amount          text,
  currency               char(3)
)
language sql
stable
security invoker
set search_path = ''
as $$
  select
    st.id,
    st.external_settlement_id,
    st.period_start,
    st.period_end,
    st.reported_total::text,
    coalesce(sum(ft.amount), 0)::text,
    st.reported_total is not null and st.reported_total = coalesce(sum(ft.amount), 0),
    st.reported_deposit_date,
    (select po.amount::text from public.payouts po where po.settlement_id = st.id and po.voided_at is null limit 1),
    st.currency
  from public.settlements st
  left join public.financial_transactions ft on ft.settlement_id = st.id
  where st.source_file_id = p_source_file_id
  group by st.id
  order by st.period_start nulls last, st.external_settlement_id;
$$;


-- ----------------------------------------------------------------------------
-- 5. Privileges
-- ----------------------------------------------------------------------------

do $$
declare
  f text;
begin
  foreach f in array array[
    'public.import_batch_overview(integer, integer)',
    'public.ledger_file_summary(uuid)',
    'public.ledger_file_settlements(uuid)'
  ]
  loop
    execute format('revoke all on function %s from anon, public', f);
    execute format('grant execute on function %s to authenticated', f);
  end loop;
end;
$$;


-- ----------------------------------------------------------------------------
-- 6. Self-verification
-- ----------------------------------------------------------------------------

do $$
declare
  v_n integer;
  f   text;
begin
  select count(*) into v_n
  from public.ledger_mapping_rules
  where business_id is null and marketplace_code = 'AMAZON'
    and format_id = 'amazon.settlement.flat_file_v2' and status = 'ACTIVE';
  if v_n <> 21 then
    raise exception 'Expected 21 active Amazon Flat File V2 rules, found %.', v_n;
  end if;

  if not exists (select 1 from public.marketplaces where code = 'AMAZON' and adapter_status = 'AVAILABLE') then
    raise exception 'AMAZON is not marked AVAILABLE.';
  end if;

  if not exists (
    select 1 from pg_constraint c
    where c.conrelid = 'public.import_batches'::regclass and c.conname = 'import_batches_file_type_check'
      and pg_get_constraintdef(c.oid) ilike '%txt%' and pg_get_constraintdef(c.oid) ilike '%api%'
  ) then
    raise exception 'The import_batches file_type check does not allow txt and api.';
  end if;

  if position('''txt''' in (select p.prosrc from pg_proc p join pg_namespace n on n.oid = p.pronamespace
                            where n.nspname = 'public' and p.proname = 'ledger_apply_file')) = 0 then
    raise exception 'ledger_apply_file does not accept txt.';
  end if;

  if position('LEDGER' in (select p.prosrc from pg_proc p join pg_namespace n on n.oid = p.pronamespace
                           where n.nspname = 'public' and p.proname = 'import_batch_withdrawal_preview')) = 0 then
    raise exception 'The legacy withdrawal preview does not refuse ledger files.';
  end if;

  foreach f in array array['import_batch_overview', 'ledger_file_summary', 'ledger_file_settlements',
                           'ledger_apply_file', 'import_batch_withdrawal_preview']
  loop
    if exists (
      select 1 from pg_proc p join pg_namespace n on n.oid = p.pronamespace
      where n.nspname = 'public' and p.proname = f and has_function_privilege('anon', p.oid, 'EXECUTE')
    ) then
      raise exception 'SECURITY: anon can execute %().', f;
    end if;
    if not exists (
      select 1 from pg_proc p join pg_namespace n on n.oid = p.pronamespace
      where n.nspname = 'public' and p.proname = f and has_function_privilege('authenticated', p.oid, 'EXECUTE')
    ) then
      raise exception 'authenticated cannot execute %().', f;
    end if;
  end loop;

  -- The two new readers must not bypass RLS.
  if exists (
    select 1 from pg_proc p join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'public' and p.proname in ('ledger_file_summary', 'ledger_file_settlements', 'import_batch_overview')
      and p.prosecdef
  ) then
    raise exception 'SECURITY: a Data Sources reader is SECURITY DEFINER.';
  end if;

  raise notice 'Migration 0031 verified: Amazon Flat File V2 rules, .txt ledger files, and ledger-aware Data Sources.';
end;
$$;


commit;
