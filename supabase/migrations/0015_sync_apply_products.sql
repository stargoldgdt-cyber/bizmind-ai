-- ============================================================================
-- 0015  Applying a synced product catalogue
-- ============================================================================
-- The orders equivalent of this shipped in 0012. This is its sibling, and it
-- exists for the same reason: a connector produces raw records and the
-- EXISTING ingestion pipeline writes them. `import_apply_products()` is the
-- same function the CSV importer uses, with the same validation and the same
-- idempotency on (business_id, source, external_id).
--
-- Like `sync_apply_orders()`, it takes a JOB id and never a business id. The
-- tenant is derived from the job, so a worker cannot be pointed at another.
--
-- APPLY THIS IN THE SUPABASE SQL EDITOR.
-- Clear the editor first: click in it, press Ctrl+A, then Delete.
-- ============================================================================

begin;

create or replace function public.sync_apply_products(
  p_job_id uuid,
  p_rows   jsonb
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_job      public.sync_jobs;
  v_provider public.integration_provider;
  v_source   public.channel_type;
  v_batch    uuid;
begin
  select * into v_job from public.sync_jobs where id = p_job_id;
  if v_job.id is null then
    raise exception 'No such sync job.' using errcode = 'P0002';
  end if;

  -- Only the provider, to pick a channel type. A record variable cannot share
  -- an INTO list with a scalar (42601), which 0012 learned the hard way.
  select a.provider into v_provider
  from public.integration_accounts a
  where a.id = v_job.integration_account_id;

  if v_provider is null then
    raise exception 'That sync job has no connected account.' using errcode = 'P0002';
  end if;

  v_source := case v_provider
                when 'SHOPIFY' then 'SHOPIFY'::public.channel_type
                when 'WOOCOMMERCE' then 'WOOCOMMERCE'::public.channel_type
                else 'OTHER'::public.channel_type
              end;

  insert into public.import_batches (
    business_id, entity, status, source, file_name, file_type,
    file_size_bytes, row_count
  )
  values (
    v_job.business_id, 'PRODUCTS', 'DRAFT', v_source,
    'sync:' || v_job.resource, 'api', 0,
    coalesce(jsonb_array_length(p_rows), 0)
  )
  returning id into v_batch;

  return public.import_apply_products(v_batch, p_rows)
         || jsonb_build_object('batch_id', v_batch);
end;
$$;

revoke all on function public.sync_apply_products(uuid, jsonb)
  from anon, authenticated, public;
grant execute on function public.sync_apply_products(uuid, jsonb) to service_role;


-- ----------------------------------------------------------------------------
-- Self-verification
-- ----------------------------------------------------------------------------

do $$
begin
  -- Session-less, so it must be unreachable by a signed-in user. If
  -- `authenticated` could call it, anyone with a login could write a product
  -- catalogue into any business by guessing a job id.
  if exists (
    select 1 from pg_proc p join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'public' and p.proname = 'sync_apply_products'
      and (has_function_privilege('authenticated', p.oid, 'EXECUTE')
           or has_function_privilege('anon', p.oid, 'EXECUTE'))
  ) then
    raise exception
      'SECURITY: sync_apply_products() is callable without service_role.';
  end if;

  if not exists (
    select 1 from pg_proc p join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'public' and p.proname = 'sync_apply_products'
      and has_function_privilege('service_role', p.oid, 'EXECUTE')
  ) then
    raise exception 'service_role cannot execute sync_apply_products().';
  end if;

  raise notice
    'Migration 0015 verified: product sync writes through the existing '
    'ingestion pipeline, and only service_role may invoke it.';
end;
$$;

commit;
