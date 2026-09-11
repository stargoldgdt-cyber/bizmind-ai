-- ============================================================================
-- 0022  One Google authorization per business
-- ============================================================================
-- Between "the owner signed in with Google" and "the owner picked a tab" there
-- is no connection row yet, so the Google refresh token needs somewhere to
-- live. The browser is not that place -- not even encrypted.
--
-- So it lives on the business's `integrations` row for GOOGLE_SHEETS: the
-- level the architecture already calls "the Google connection", above the
-- individual spreadsheets and tabs.
--
--   Business -> integrations (Google authorization) -> integration_accounts
--                                                      (one per sheet tab)
--
-- Consequences, both deliberate:
--   - Reconnecting Google once repairs every connected sheet: the reauthorise
--     function below flips every REAUTH_REQUIRED tab back to CONNECTED.
--   - A business connects ONE Google account in V1. Every sheet it syncs must
--     be one that account can open.
--
-- THE PRIVILEGE CHANGE IS THE DANGEROUS PART
-- ------------------------------------------
-- `integrations` was granted to `authenticated` at table level (0012). Adding a
-- secret column to a table-level grant would make it readable at once -- and in
-- PostgreSQL a column-level REVOKE cannot take a table-level GRANT back. 0012
-- learned that twice. So every privilege is revoked first, and granted back
-- column by column with the secret left out. The self-check at the end refuses
-- to install if the column is readable.
--
-- The worker reads the authorization through sync_job_context(), which now
-- falls back from the tab's own credentials to the business's. WooCommerce
-- keeps its credentials on the tab and is unaffected.
--
-- Depends on 0019-0021. APPLY THIS IN THE SUPABASE SQL EDITOR.
-- Clear the editor first: click in it, press Ctrl+A, then Delete.
-- ============================================================================

begin;


-- ----------------------------------------------------------------------------
-- 1. Columns
-- ----------------------------------------------------------------------------

alter table public.integrations
  add column credentials_encrypted text,
  add column authorized_by uuid references public.profiles (id) on delete set null,
  add column authorized_at timestamptz;

comment on column public.integrations.credentials_encrypted is
  'A provider authorization shared by every connection under this integration '
  '-- for GOOGLE_SHEETS, the sealed refresh token. AES-256-GCM, bound to the '
  'business. Never selectable by a signed-in user.';


-- ----------------------------------------------------------------------------
-- 2. Privileges: column by column, secret excluded
-- ----------------------------------------------------------------------------
-- Every non-secret column is listed. Adding a column to this table means adding
-- it here, and forgetting to makes it invisible rather than exposed -- the safe
-- direction to fail in.

revoke all on public.integrations from anon, authenticated;

grant select (
  id, business_id, provider, status, created_by, created_at, updated_at,
  authorized_by, authorized_at
) on public.integrations to authenticated;

grant insert (
  id, business_id, provider, status, created_by, created_at, updated_at,
  authorized_by, authorized_at
) on public.integrations to authenticated;

grant update (
  id, business_id, provider, status, created_by, created_at, updated_at,
  authorized_by, authorized_at
) on public.integrations to authenticated;

grant delete on public.integrations to authenticated;

grant select, insert, update, delete on public.integrations to service_role;


-- ----------------------------------------------------------------------------
-- 3. The worker reads the tab's credentials, or the business's
-- ----------------------------------------------------------------------------
-- Same return columns as 0012, so it is replaced in place. A tab with its own
-- credentials (WooCommerce) uses them; a Google Sheets tab has none and uses
-- the business's authorization. Both were sealed with the same business and
-- purpose, so the worker decrypts them the same way.

create or replace function public.sync_job_context(p_job_id uuid)
returns table (
  job_id            uuid,
  resolved_business_id uuid,
  account_id        uuid,
  provider          public.integration_provider,
  external_account_id text,
  credentials_encrypted text,
  metadata          jsonb,
  resource          text,
  mode              public.sync_mode,
  cursor_value      text,
  account_status    public.integration_status
)
language sql
security definer
set search_path = ''
as $$
  select
    j.id, j.business_id, a.id, i.provider, a.external_account_id,
    coalesce(a.credentials_encrypted, i.credentials_encrypted),
    a.metadata, j.resource, j.mode, j.cursor, a.status
  from public.sync_jobs j
  join public.integration_accounts a on a.id = j.integration_account_id
  join public.integrations i on i.id = a.integration_id
  where j.id = p_job_id;
$$;


-- ----------------------------------------------------------------------------
-- 4. Recording a Google authorization
-- ----------------------------------------------------------------------------

/**
 * Called by the OAuth callback AS THE SIGNED-IN OWNER, after Google has
 * returned a refresh token and before it is stored.
 *
 * SECURITY DEFINER with its own role check -- that check IS the tenant
 * boundary, as in integration_account_connect(). It creates or refreshes the
 * business's GOOGLE_SHEETS integration row and returns it WITHOUT the
 * credential; the sealed token is then written onto the row by the confined
 * server-side writer, so the ciphertext never passes through a function a
 * signed-in user can call.
 *
 * Reconnecting also clears REAUTH_REQUIRED on every Google Sheets tab of this
 * business. If storing the new token then failed, the next sync would fail
 * and the worker would set REAUTH_REQUIRED again -- the state heals itself
 * rather than leaving a tab stuck.
 */
create or replace function public.integration_google_authorize(p_business_id uuid)
returns public.integrations
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_user        uuid := (select auth.uid());
  v_integration public.integrations;
  v_reactivated integer;
begin
  if v_user is null then
    raise exception 'Not authenticated.' using errcode = '28000';
  end if;

  if not public.current_user_has_role(
       p_business_id, array['OWNER','ADMIN']::public.business_role[]) then
    raise exception 'Only an owner or admin can connect Google.'
      using errcode = '42501';
  end if;

  insert into public.integrations (
    business_id, provider, status, created_by, authorized_by, authorized_at
  )
  values (
    p_business_id, 'GOOGLE_SHEETS', 'CONNECTED', v_user, v_user, now()
  )
  on conflict (business_id, provider) do update set
    status        = 'CONNECTED',
    authorized_by = excluded.authorized_by,
    authorized_at = now(),
    updated_at    = now()
  returning * into v_integration;

  update public.integration_accounts
  set status = 'CONNECTED', last_error = null
  where business_id = p_business_id
    and provider = 'GOOGLE_SHEETS'
    and status = 'REAUTH_REQUIRED';

  get diagnostics v_reactivated = row_count;

  perform public.write_audit_log(
    p_business_id, 'integration.google.authorized', 'integrations',
    v_integration.id, null,
    jsonb_build_object('sheets_reactivated', v_reactivated)
  );

  -- The full row is the return type; the sealed credential must not travel.
  v_integration.credentials_encrypted := null;

  return v_integration;
end;
$$;


-- ----------------------------------------------------------------------------
-- 5. Function privileges
-- ----------------------------------------------------------------------------

revoke all on function public.integration_google_authorize(uuid) from anon, public;
grant execute on function public.integration_google_authorize(uuid) to authenticated;

revoke all on function public.sync_job_context(uuid) from anon, authenticated, public;
grant execute on function public.sync_job_context(uuid) to service_role;


-- ----------------------------------------------------------------------------
-- 6. Self-verification
-- ----------------------------------------------------------------------------

do $$
begin
  if has_column_privilege('authenticated', 'public.integrations',
       'credentials_encrypted', 'SELECT') then
    raise exception
      'SECURITY: authenticated can read integrations.credentials_encrypted';
  end if;

  if has_column_privilege('authenticated', 'public.integrations',
       'credentials_encrypted', 'UPDATE')
     or has_column_privilege('authenticated', 'public.integrations',
       'credentials_encrypted', 'INSERT') then
    raise exception
      'SECURITY: authenticated can write integrations.credentials_encrypted';
  end if;

  if has_table_privilege('anon', 'public.integrations', 'SELECT') then
    raise exception 'SECURITY: anon can read public.integrations';
  end if;

  -- The rest of the row must stay readable, or the Integrations page breaks.
  if not has_column_privilege('authenticated', 'public.integrations', 'status', 'SELECT')
     or not has_column_privilege('authenticated', 'public.integrations', 'provider', 'SELECT') then
    raise exception 'Members can no longer read their own integrations.';
  end if;

  if exists (
    select 1 from pg_proc p join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'public' and p.proname = 'sync_job_context'
      and (has_function_privilege('authenticated', p.oid, 'EXECUTE')
           or has_function_privilege('anon', p.oid, 'EXECUTE'))
  ) then
    raise exception 'SECURITY: sync_job_context() is callable without service_role.';
  end if;

  if exists (
    select 1 from pg_proc p join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'public' and p.proname = 'integration_google_authorize'
      and has_function_privilege('anon', p.oid, 'EXECUTE')
  ) then
    raise exception 'SECURITY: anon can execute integration_google_authorize().';
  end if;

  raise notice
    'Migration 0022 verified: one Google authorization per business, its '
    'token unreadable and unwritable by signed-in users, and the worker falls '
    'back to it for Google Sheets tabs.';
end;
$$;


commit;
