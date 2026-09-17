-- ============================================================================
-- 0038  Fix: a product or cost sync batch carries no ledger fields
-- ============================================================================
-- GCC Phase 7. Migration 0037's sync_dataset_batch() marked its import batch
-- with source_kind = 'GOOGLE_SHEETS'. Since 0030 that column belongs to ledger
-- files only, and the import_batches guard refuses it on any other batch
-- ("Ledger fields belong to ledger files only."), so every product-master and
-- product-cost sync failed. Nothing was written by those syncs.
--
-- The function is replaced with the same body minus that one column. A sync
-- batch is already identified by integration_account_id and sync_run_id, as
-- every other Google Sheets batch is. Same signature, so its privileges
-- (service_role only) are kept.
--
-- APPLY THIS IN THE SUPABASE SQL EDITOR, AFTER 0037.
-- Clear the editor first: click in it, press Ctrl+A, then Delete.
-- ============================================================================

begin;

create or replace function public.sync_dataset_batch(p_job_id uuid, p_resource text, p_rows jsonb)
returns public.import_batches
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_job   public.sync_jobs;
  v_run   uuid;
  v_batch public.import_batches;
begin
  select * into v_job from public.sync_jobs where id = p_job_id;
  if v_job.id is null then
    raise exception 'No such sync job.' using errcode = 'P0002';
  end if;
  if v_job.resource <> p_resource then
    raise exception 'This sync job does not hold that kind of data.' using errcode = 'P0001';
  end if;
  if jsonb_typeof(coalesce(p_rows, '[]'::jsonb)) <> 'array' then
    raise exception 'Rows must be a list.' using errcode = '22023';
  end if;

  select r.id into v_run
  from public.sync_runs r
  where r.job_id = p_job_id and r.status = 'RUNNING'
  order by r.started_at desc
  limit 1;

  insert into public.import_batches (
    business_id, entity, status, source, channel_id, file_name, file_type,
    file_size_bytes, row_count, integration_account_id, sync_run_id, committed_at
  )
  values (
    v_job.business_id, p_resource::public.import_entity, 'COMPLETED', 'OTHER', null,
    'sync:' || p_resource, 'api', 0, jsonb_array_length(coalesce(p_rows, '[]'::jsonb)),
    v_job.integration_account_id, v_run, now()
  )
  returning * into v_batch;

  return v_batch;
end;
$$;

do $$
begin
  if exists (
    select 1 from pg_proc p join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'public' and p.proname = 'sync_dataset_batch'
      and (position('source_kind' in p.prosrc) > 0
           or has_function_privilege('authenticated', p.oid, 'EXECUTE'))
  ) then
    raise exception 'Migration 0038 failed: sync_dataset_batch still sets source_kind, or is open to signed-in users.';
  end if;
  raise notice 'Migration 0038 verified: product and cost syncs record a plain sync batch.';
end;
$$;

commit;
