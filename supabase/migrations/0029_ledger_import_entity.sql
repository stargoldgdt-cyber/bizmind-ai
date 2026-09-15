-- ============================================================================
-- 0029  A new kind of import: a ledger file
-- ============================================================================
-- Phase 1 of the GCC marketplace rebuild (ARCHITECTURE_BASELINE.md). This
-- migration ONLY adds one enum value. Nothing uses it yet.
--
-- WHY IT IS ON ITS OWN
-- --------------------
-- PostgreSQL allows `ALTER TYPE ... ADD VALUE` inside a transaction, but the
-- new value cannot be USED until that transaction commits. Migration 0030
-- writes ledger files with `entity = 'LEDGER'`, so the value must already
-- exist when 0030 runs. Same pattern as 0019.
--
-- WHAT IS ADDED
--   import_entity  LEDGER   a marketplace or bank file written to the new
--                           financial ledger by ledger_apply_file() (0030)
--
-- REVERSIBILITY
--   PostgreSQL cannot remove an enum value. An unused value is harmless; the
--   rollback script for 0030 leaves it in place and says so.
--
-- APPLY THIS IN THE SUPABASE SQL EDITOR, BEFORE 0030.
-- Clear the editor first: click in it, press Ctrl+A, then Delete.
-- ============================================================================

begin;

alter type public.import_entity add value if not exists 'LEDGER';

commit;

-- Self-verification runs after the commit, reading only the catalogue.
do $$
begin
  if not exists (
    select 1
    from pg_enum e
    join pg_type t on t.oid = e.enumtypid
    join pg_namespace n on n.oid = t.typnamespace
    where n.nspname = 'public'
      and t.typname = 'import_entity'
      and e.enumlabel = 'LEDGER'
  ) then
    raise exception 'Migration 0029 failed: import_entity has no LEDGER value.';
  end if;

  raise notice 'Migration 0029 verified: import_entity now includes LEDGER.';
end;
$$;
