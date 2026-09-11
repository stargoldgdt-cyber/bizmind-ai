-- ============================================================================
-- 0019  New values for Google Sheets, on their own
-- ============================================================================
-- This migration only ADDS enum values and one new enum type. Nothing uses
-- them yet.
--
-- WHY IT IS SEPARATE FROM THE MIGRATIONS THAT USE THEM
-- ---------------------------------------------------
-- PostgreSQL allows `ALTER TYPE ... ADD VALUE` inside a transaction, but the
-- new value cannot be USED until that transaction commits -- a check, an index
-- predicate, a SQL-language function body or a cast that mentions it fails with
-- "unsafe use of new value". Putting the additions in their own migration means
-- 0020 and 0021 run against values that already exist.
--
-- WHAT IS ADDED
-- -------------
--   integration_provider  GOOGLE_SHEETS
--
--   integration_status    PAUSED                   the owner switched sync off
--                         REAUTH_REQUIRED          Google access expired or was
--                                                  revoked; nothing can sync
--                                                  until they reconnect
--                         MAPPING_REVIEW_REQUIRED  a mapped column was renamed
--                                                  or removed; writing stops
--                                                  rather than guessing
--
--   sync_trigger          INITIAL | AUTOMATIC | MANUAL | RECONCILIATION
--                         why a sync ran, so history can say so
--
-- "Syncing", "synced" and "partial" are deliberately NOT connection states. They
-- already exist as job and run states, and storing them twice would give the
-- screen two answers to the same question.
--
-- APPLY THIS IN THE SUPABASE SQL EDITOR, BEFORE 0020.
-- Clear the editor first: click in it, press Ctrl+A, then Delete.
-- ============================================================================

begin;

alter type public.integration_provider add value if not exists 'GOOGLE_SHEETS';

alter type public.integration_status add value if not exists 'PAUSED';
alter type public.integration_status add value if not exists 'REAUTH_REQUIRED';
alter type public.integration_status add value if not exists 'MAPPING_REVIEW_REQUIRED';

do $$
begin
  if not exists (
    select 1 from pg_type t join pg_namespace n on n.oid = t.typnamespace
    where n.nspname = 'public' and t.typname = 'sync_trigger'
  ) then
    create type public.sync_trigger as enum (
      'INITIAL',          -- the first import after connecting
      'AUTOMATIC',        -- Google said the file changed
      'MANUAL',           -- somebody pressed "Sync now"
      'RECONCILIATION'    -- the periodic safety check for a missed change
    );
  end if;
end;
$$;


-- ----------------------------------------------------------------------------
-- Self-verification
-- ----------------------------------------------------------------------------
-- Reads the catalogue by label. Comparing names in pg_enum is not a "use" of
-- the new values, so this is safe inside the same transaction.

do $$
declare
  v_missing text[];
begin
  select array_agg(v.type_name || '.' || v.label) into v_missing
  from (values
    ('integration_provider', 'GOOGLE_SHEETS'),
    ('integration_status',   'PAUSED'),
    ('integration_status',   'REAUTH_REQUIRED'),
    ('integration_status',   'MAPPING_REVIEW_REQUIRED'),
    ('sync_trigger',         'INITIAL'),
    ('sync_trigger',         'AUTOMATIC'),
    ('sync_trigger',         'MANUAL'),
    ('sync_trigger',         'RECONCILIATION')
  ) as v(type_name, label)
  where not exists (
    select 1
    from pg_enum e
    join pg_type t on t.oid = e.enumtypid
    join pg_namespace n on n.oid = t.typnamespace
    where n.nspname = 'public'
      and t.typname = v.type_name
      and e.enumlabel = v.label
  );

  if v_missing is not null then
    raise exception 'Migration 0019 is incomplete. Missing: %', v_missing;
  end if;

  raise notice
    'Migration 0019 verified: GOOGLE_SHEETS, three new connection states and '
    'sync triggers exist. Nothing uses them yet.';
end;
$$;

commit;
