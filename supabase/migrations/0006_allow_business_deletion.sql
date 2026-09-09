-- ============================================================================
-- BizMind AI -- Migration 0006: Allow a business to actually be deleted
-- ============================================================================
--
-- FIXES A BUG FROM MIGRATION 0001.
--
-- `businesses` has a DELETE policy for owners, but deleting one always failed:
--
--     A business must always have at least one owner.
--
-- Deleting a business cascades to `business_members`, and the
-- `prevent_last_owner_removal()` trigger correctly refused to remove the final
-- OWNER row -- without knowing that the business it belonged to was itself
-- being deleted. The guard was doing its job in a situation it was never
-- meant to cover.
--
-- The effect: the delete policy existed but could never succeed. Nobody
-- noticed because the Phase 2 tests verified that the POLICY was present
-- rather than that a deletion actually worked. Found when a regression test
-- tried to clean up after itself.
--
-- THE FIX
-- -------
-- A cascade from `businesses` is implemented as an internal AFTER DELETE
-- action: the business row is removed first, then its members. So by the time
-- this trigger runs during a cascade, the parent business is already gone from
-- the transaction's view. Checking for it distinguishes the two cases exactly:
--
--   business still exists  ->  someone is removing a member. Protect them.
--   business already gone  ->  the whole workspace is being deleted. Allow it.
--
-- The protection itself is unchanged: an owner still cannot demote or remove
-- themselves while the business exists.
-- ============================================================================

begin;


create or replace function public.prevent_last_owner_removal()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_owner_count integer;
begin
  -- A cascade from a business being deleted must not be blocked. The parent
  -- row is removed before its members, so its absence is what tells us this
  -- is a workspace deletion rather than someone leaving.
  if tg_op = 'DELETE'
     and not exists (
       select 1 from public.businesses b where b.id = old.business_id
     ) then
    return old;
  end if;

  if (tg_op = 'DELETE' and old.role = 'OWNER')
     or (tg_op = 'UPDATE' and old.role = 'OWNER' and new.role <> 'OWNER') then

    select count(*) into v_owner_count
    from public.business_members
    where business_id = old.business_id
      and role = 'OWNER';

    if v_owner_count <= 1 then
      raise exception 'A business must always have at least one owner.'
        using errcode = 'P0001';
    end if;
  end if;

  if tg_op = 'DELETE' then
    return old;
  end if;
  return new;
end;
$$;

comment on function public.prevent_last_owner_removal() is
  'Stops an owner locking everyone out of a live business, while still '
  'allowing the business itself to be deleted.';


-- ----------------------------------------------------------------------------
-- Self-verification
-- ----------------------------------------------------------------------------
-- Proves both halves of the behaviour on a temporary business, which the
-- second half then deletes -- so the check cleans up after itself by being
-- the very thing it is testing.

do $$
declare
  v_user     uuid;
  v_business uuid;
  v_blocked  boolean := false;
begin
  select id into v_user from public.profiles limit 1;

  if v_user is null then
    raise notice 'No profiles yet; skipping the behavioural check.';
    return;
  end if;

  insert into public.businesses (name, slug, currency, created_by)
  values ('Migration 0006 self-test', 'migration-0006-self-test-' || gen_random_uuid(), 'BDT', v_user)
  returning id into v_business;

  insert into public.business_members (business_id, user_id, role)
  values (v_business, v_user, 'OWNER');

  -- The guard must still fire for an ordinary member removal.
  begin
    delete from public.business_members
    where business_id = v_business and user_id = v_user;
  exception when sqlstate 'P0001' then
    v_blocked := true;
  end;

  if not v_blocked then
    raise exception
      'SAFETY: the last owner of a LIVE business could be removed. The guard is broken.';
  end if;

  -- Deleting the whole business must now succeed.
  delete from public.businesses where id = v_business;

  if exists (select 1 from public.businesses where id = v_business) then
    raise exception 'Business deletion is still blocked.';
  end if;

  raise notice
    'Migration 0006 verified: owners still protected in a live business, and a business can now be deleted.';
end;
$$;


commit;
