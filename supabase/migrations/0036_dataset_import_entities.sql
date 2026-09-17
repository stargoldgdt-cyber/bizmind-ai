-- ============================================================================
-- 0036  Two new kinds of synced data: the product master and product costs
-- ============================================================================
-- GCC Phase 7. This migration ONLY adds two enum values. Nothing uses them
-- until 0037.
--
-- WHY IT IS ON ITS OWN
-- --------------------
-- PostgreSQL allows `ALTER TYPE ... ADD VALUE` inside a transaction, but the
-- new value cannot be USED until that transaction commits. Migration 0037
-- records Google Sheets syncs of these datasets with the new values, so they
-- must already exist when 0037 runs. Same pattern as 0019 and 0029.
--
-- WHAT IS ADDED
--   import_entity  CATALOG        a synced product-master tab (catalog_products)
--   import_entity  PRODUCT_COSTS  a synced product-cost tab (product_costs)
--
-- REVERSIBILITY
--   PostgreSQL cannot remove an enum value. An unused value is harmless.
--
-- APPLY THIS IN THE SUPABASE SQL EDITOR, BEFORE 0037.
-- Clear the editor first: click in it, press Ctrl+A, then Delete.
-- ============================================================================

begin;

alter type public.import_entity add value if not exists 'CATALOG';
alter type public.import_entity add value if not exists 'PRODUCT_COSTS';

commit;

-- Self-verification runs after the commit, reading only the catalogue.
do $$
begin
  if (
    select count(*)
    from pg_enum e
    join pg_type t on t.oid = e.enumtypid
    join pg_namespace n on n.oid = t.typnamespace
    where n.nspname = 'public'
      and t.typname = 'import_entity'
      and e.enumlabel in ('CATALOG', 'PRODUCT_COSTS')
  ) <> 2 then
    raise exception 'Migration 0036 failed: import_entity lacks CATALOG or PRODUCT_COSTS.';
  end if;

  raise notice 'Migration 0036 verified: import_entity now includes CATALOG and PRODUCT_COSTS.';
end;
$$;
