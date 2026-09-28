-- ============================================================================
-- 0058  Fix: import_batches also needs 'pdf' (migration 0057 missed a spot)
-- ============================================================================
-- Migration 0057 taught ledger_apply_file() to accept file_type 'pdf', but
-- missed that file_type is checked in TWO places (0031's own comment says so
-- explicitly): the function's inline check, AND a separate CHECK constraint
-- directly on import_batches. Found by actually uploading the owner's real
-- tax invoice through the live production path after 0057 was applied --
-- every document was recognised and normalised correctly, but the INSERT
-- into import_batches itself failed: "violates check constraint
-- import_batches_file_type_check". The ledger is immutable and nothing was
-- half-written (the whole apply is one transaction), so this is purely
-- additive: widen the constraint, nothing to repair.
--
-- APPLY THIS IN THE SUPABASE SQL EDITOR.
-- Clear the editor first: click in it, press Ctrl+A, then Delete.
-- ============================================================================

begin;

alter table public.import_batches
  drop constraint import_batches_file_type_check;

alter table public.import_batches
  add constraint import_batches_file_type_check
  check (file_type in ('csv', 'xlsx', 'api', 'txt', 'pdf'));

do $$
declare
  v_def text;
begin
  select pg_get_constraintdef(c.oid) into v_def
  from pg_constraint c
  where c.conrelid = 'public.import_batches'::regclass and c.conname = 'import_batches_file_type_check';

  if v_def is null or v_def not ilike '%pdf%' then
    raise exception 'SELF-CHECK: import_batches_file_type_check does not allow pdf: %', v_def;
  end if;
  if v_def not ilike '%csv%' or v_def not ilike '%xlsx%' or v_def not ilike '%api%' or v_def not ilike '%txt%' then
    raise exception 'SELF-CHECK: import_batches_file_type_check lost an existing file type: %', v_def;
  end if;

  raise notice 'Migration 0058 verified: import_batches accepts pdf alongside csv, xlsx, api and txt.';
end;
$$;

commit;
