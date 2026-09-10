-- ============================================================================
-- 0014  One store, one business -- and an enum cast that was never there
-- ============================================================================
-- Two faults, both found by the live suite rather than by reading the code.
-- 0012 and 0013 are already applied; this changes only what is named below.
--
-- ---------------------------------------------------------------------------
-- FAULT 1: the global store-uniqueness rule did not exist
-- ---------------------------------------------------------------------------
-- 0012 claimed that "a live store belongs to exactly one BizMind business" and
-- backed it with:
--
--     create unique index ... on integration_accounts
--       (integration_id, external_account_id) where status <> 'DISCONNECTED';
--
-- That index is per-business, not global. `integrations` is unique on
-- (business_id, provider), so business A's FIXTURE row and business B's
-- FIXTURE row have DIFFERENT integration_id values -- and the same store
-- connected by both produces two rows that do not collide.
--
-- The test caught it: "A CANNOT CONNECT A STORE ALREADY LIVE ON ANOTHER
-- BUSINESS" returned 200.
--
-- WHY IT MATTERS MORE THAN A DUPLICATE ROW. `webhook_account_lookup()`
-- resolves a delivery with
--
--     where i.provider = ... and a.external_account_id = ... limit 1
--
-- With two matching rows that `limit 1` picks one ARBITRARILY. A delivery for
-- a shop connected by two customers would land in whichever tenant the planner
-- happened to return first: a cross-tenant write, silent, and unreproducible.
--
-- The fix denormalises `provider` onto integration_accounts so the index can
-- be global. The copy is not trusted to stay correct -- a composite foreign
-- key onto integrations(id, provider) makes a mismatch impossible rather than
-- merely unlikely. It is the same trick migration 0009 used to keep a mapping
-- pointed at a sourced metric.
--
-- ---------------------------------------------------------------------------
-- FAULT 2: a CASE of bare literals is text, not an enum
-- ---------------------------------------------------------------------------
--     case when p_signature_valid then 'RECEIVED' else 'REJECTED' end
--
--     42804 column "status" is of type public.webhook_event_status
--           but expression is of type text
--
-- Untyped string literals in a CASE resolve to text, and PostgreSQL will not
-- implicitly cast text into an enum on INSERT. Every webhook delivery failed
-- on it -- which is why the whole trusted-path section failed at once while
-- "unknown store" passed: that branch returns before the insert.
--
-- APPLY THIS IN THE SUPABASE SQL EDITOR.
-- Clear the editor first: click in it, press Ctrl+A, then Delete.
-- ============================================================================

begin;


-- ----------------------------------------------------------------------------
-- 1. Denormalise the provider, provably
-- ----------------------------------------------------------------------------

alter table public.integrations
  add constraint integrations_id_provider_key unique (id, provider);

alter table public.integration_accounts
  add column provider public.integration_provider;

update public.integration_accounts a
set provider = i.provider
from public.integrations i
where i.id = a.integration_id;

alter table public.integration_accounts
  alter column provider set not null;

/**
 * The copy cannot drift.
 *
 * Without this the denormalised column would be an assertion maintained by
 * whoever remembers to; with it, a row whose provider disagrees with its
 * integration cannot exist.
 */
alter table public.integration_accounts
  add constraint integration_accounts_provider_matches
  foreign key (integration_id, provider)
  references public.integrations (id, provider);

comment on column public.integration_accounts.provider is
  'Copied from the parent integration and held there by a composite foreign '
  'key. Exists so store uniqueness can be enforced ACROSS businesses.';


-- ----------------------------------------------------------------------------
-- 2. The uniqueness rule 0012 meant to write
-- ----------------------------------------------------------------------------

drop index if exists public.integration_accounts_live_external_key;

create unique index integration_accounts_live_external_key
  on public.integration_accounts (provider, external_account_id)
  where status <> 'DISCONNECTED';

comment on index public.integration_accounts_live_external_key is
  'One LIVE store belongs to exactly one business. Partial, so a store can be '
  'disconnected and later connected by someone else.';

-- The new column is ordinary, not secret, so it joins the granted list. The
-- credential columns are still absent from every one of these, which is the
-- whole reason these grants are written out column by column.
grant select (provider), insert (provider), update (provider)
  on public.integration_accounts to authenticated;


-- ----------------------------------------------------------------------------
-- 3. Refuse the second connection with a sentence, not a constraint name
-- ----------------------------------------------------------------------------

create or replace function public.integration_account_connect(
  p_business_id       uuid,
  p_provider          public.integration_provider,
  p_external_account_id text,
  p_display_name      text,
  p_channel_type      public.channel_type,
  p_metadata          jsonb default '{}'::jsonb
)
returns public.integration_accounts
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_user        uuid := (select auth.uid());
  v_integration public.integrations;
  v_account     public.integration_accounts;
  v_channel     uuid;
  v_before      jsonb;
begin
  if v_user is null then
    raise exception 'Not authenticated.' using errcode = '28000';
  end if;

  -- SECURITY DEFINER, so this check IS the tenant boundary rather than a
  -- friendlier error in front of one.
  if not public.current_user_has_role(
       p_business_id, array['OWNER','ADMIN']::public.business_role[]) then
    raise exception 'Only an owner or admin can connect an integration.'
      using errcode = '42501';
  end if;

  -- The unique index would refuse this anyway, but with a constraint name an
  -- owner cannot act on. Said plainly instead, and said BEFORE anything is
  -- written so a failed attempt leaves nothing behind.
  if exists (
    select 1
    from public.integration_accounts a
    where a.provider = p_provider
      and a.external_account_id = p_external_account_id
      and a.status <> 'DISCONNECTED'
      and a.business_id <> p_business_id
  ) then
    raise exception
      'That store is already connected to a different BizMind business. '
      'Disconnect it there first.'
      using errcode = 'P0001';
  end if;

  insert into public.integrations (business_id, provider, created_by)
  values (p_business_id, p_provider, v_user)
  on conflict (business_id, provider) do update
    set status = 'CONNECTED', updated_at = now()
  returning * into v_integration;

  -- The audit "before" snapshot must not carry ciphertext into a table an
  -- admin can read.
  select to_jsonb(a) - 'credentials_encrypted' - 'webhook_secret_encrypted'
    into v_before
  from public.integration_accounts a
  where a.business_id = p_business_id
    and a.integration_id = v_integration.id
    and a.external_account_id = p_external_account_id;

  -- Reuse the existing channel if this store has been connected before.
  select a.channel_id into v_channel
  from public.integration_accounts a
  where a.business_id = p_business_id
    and a.integration_id = v_integration.id
    and a.external_account_id = p_external_account_id;

  if v_channel is null then
    insert into public.channels (business_id, name, type)
    values (p_business_id, coalesce(p_display_name, p_external_account_id), p_channel_type)
    on conflict (business_id, name) do update set is_active = true
    returning id into v_channel;
  end if;

  insert into public.integration_accounts (
    business_id, integration_id, provider, external_account_id, display_name,
    status, channel_id, metadata, connected_by, connected_at, revoked_at
  )
  values (
    p_business_id, v_integration.id, p_provider, p_external_account_id,
    p_display_name, 'CONNECTED', v_channel, coalesce(p_metadata, '{}'::jsonb),
    v_user, now(), null
  )
  on conflict (business_id, integration_id, external_account_id) do update set
    display_name = excluded.display_name,
    status       = 'CONNECTED',
    metadata     = excluded.metadata,
    revoked_at   = null,
    last_error   = null,
    connected_at = now()
  returning * into v_account;

  perform public.write_audit_log(
    p_business_id,
    case when v_before is null
         then 'integration.connection.created'
         else 'integration.connection.reconnected' end,
    'integration_accounts', v_account.id, v_before,
    jsonb_build_object(
      'provider', p_provider,
      'external_account_id', p_external_account_id,
      'channel_id', v_channel
    )
  );

  -- The return type is the full row, so the sealed secrets would travel back
  -- to the browser on a RECONNECT, when they already exist. Blanked here.
  v_account.credentials_encrypted := null;
  v_account.webhook_secret_encrypted := null;

  return v_account;
end;
$$;


-- ----------------------------------------------------------------------------
-- 4. The enum cast
-- ----------------------------------------------------------------------------

create or replace function public.webhook_event_ingest(
  p_provider          public.integration_provider,
  p_external_account_id text,
  p_external_event_id text,
  p_event_type        text,
  p_raw_body          text,
  p_signature_valid   boolean
)
returns table (
  outcome    text,   -- ACCEPTED | DUPLICATE | REJECTED | UNKNOWN_ACCOUNT
  event_id   uuid,
  /**
   * Named `resolved_` rather than `business_id` deliberately: an OUT parameter
   * is a variable in scope, and one sharing a name with a column makes
   * `on conflict (business_id, ...)` ambiguous.
   */
  resolved_business_id uuid
)
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_account  public.integration_accounts;
  v_key      text := p_provider::text || ':' || p_external_event_id;
  v_event_id uuid;
begin
  -- TRUSTED BUSINESS RESOLUTION. The only source of truth for the tenant.
  select a.* into v_account
  from public.integration_accounts a
  where a.provider = p_provider
    and a.external_account_id = p_external_account_id
    and a.status <> 'DISCONNECTED'
  limit 1;

  if v_account.id is null then
    -- Nothing is written. An unknown store is not a tenant, and inventing one
    -- is how a forged delivery becomes somebody's data.
    return query select 'UNKNOWN_ACCOUNT'::text, null::uuid, null::uuid;
    return;
  end if;

  -- A rejected delivery is still recorded: a burst of them is an attack, and
  -- an attack nobody can see is worse than one that fills a table.
  --
  -- Both CASE expressions are cast explicitly. Bare literals in a CASE resolve
  -- to `text`, and PostgreSQL will not implicitly cast text into an enum --
  -- 42804, which is what every delivery failed on before this migration.
  insert into public.webhook_events (
    business_id, integration_account_id, provider, event_type,
    external_event_id, idempotency_key, raw_body, signature_valid,
    status, next_run_at
  )
  values (
    v_account.business_id, v_account.id, p_provider, p_event_type,
    p_external_event_id, v_key, p_raw_body, p_signature_valid,
    (case when p_signature_valid then 'RECEIVED' else 'REJECTED' end)
      ::public.webhook_event_status,
    (case when p_signature_valid then now() end)::timestamptz
  )
  on conflict (business_id, idempotency_key) do nothing
  returning id into v_event_id;

  if v_event_id is null then
    -- The unique constraint refused it. This is the redelivery path and it is
    -- the normal case: every provider retries.
    select e.id into v_event_id
    from public.webhook_events e
    where e.business_id = v_account.business_id and e.idempotency_key = v_key;

    return query select 'DUPLICATE'::text, v_event_id, v_account.business_id;
    return;
  end if;

  -- Audited here rather than through write_audit_log(), which requires a
  -- session this path does not have.
  insert into public.audit_logs
    (business_id, actor_id, action, entity_type, entity_id, after_data)
  values (
    v_account.business_id, null,
    case when p_signature_valid
         then 'integration.webhook.received'
         else 'integration.webhook.rejected' end,
    'webhook_events', v_event_id,
    jsonb_build_object(
      'provider', p_provider,
      'event_type', p_event_type,
      'external_event_id', p_external_event_id,
      'signature_valid', p_signature_valid
    )
  );

  return query select
    (case when p_signature_valid then 'ACCEPTED' else 'REJECTED' end)::text,
    v_event_id,
    v_account.business_id;
end;
$$;


-- ----------------------------------------------------------------------------
-- 5. Privileges the replacements need reissued
-- ----------------------------------------------------------------------------

revoke all on function public.integration_account_connect(
  uuid, public.integration_provider, text, text, public.channel_type, jsonb)
  from anon, public;
grant execute on function public.integration_account_connect(
  uuid, public.integration_provider, text, text, public.channel_type, jsonb)
  to authenticated;

revoke all on function public.webhook_event_ingest(
  public.integration_provider, text, text, text, text, boolean)
  from anon, authenticated, public;
grant execute on function public.webhook_event_ingest(
  public.integration_provider, text, text, text, text, boolean) to service_role;


-- ----------------------------------------------------------------------------
-- 6. Self-verification
-- ----------------------------------------------------------------------------

do $$
declare
  v_index_def text;
begin
  -- The index must now be global, not per-integration.
  select indexdef into v_index_def
  from pg_indexes
  where schemaname = 'public'
    and indexname = 'integration_accounts_live_external_key';

  if v_index_def is null then
    raise exception 'The store-uniqueness index is missing.';
  end if;

  if position('integration_id' in v_index_def) > 0 then
    raise exception
      'SECURITY: store uniqueness is still keyed on integration_id, which is '
      'per-business. Two businesses could connect the same store and a webhook '
      'would resolve to whichever row the planner returned first.';
  end if;

  if position('provider' in v_index_def) = 0 then
    raise exception 'The store-uniqueness index does not key on provider.';
  end if;

  -- The denormalised column must be held in place, not merely populated.
  if not exists (
    select 1 from pg_constraint
    where conname = 'integration_accounts_provider_matches'
      and contype = 'f'
  ) then
    raise exception
      'integration_accounts.provider is not tied to its integration, so the '
      'copy could drift and uniqueness would be enforced on a stale value.';
  end if;

  -- And the credentials must still be unreadable after all of that.
  if has_column_privilege(
       'authenticated', 'public.integration_accounts',
       'credentials_encrypted', 'SELECT') then
    raise exception
      'SECURITY: authenticated can read integration_accounts.credentials_encrypted';
  end if;

  if not has_column_privilege(
       'authenticated', 'public.integration_accounts', 'provider', 'SELECT') then
    raise exception 'authenticated cannot read integration_accounts.provider';
  end if;

  raise notice
    'Migration 0014 verified: one live store belongs to one business, the '
    'provider copy cannot drift, and webhook status casts to its enum.';
end;
$$;


commit;
