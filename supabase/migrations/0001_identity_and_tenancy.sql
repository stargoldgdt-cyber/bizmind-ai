-- ============================================================================
-- BizMind AI — Migration 0001: Identity and tenancy
-- ============================================================================
--
-- Creates the multi-tenant security foundation:
--
--   auth.users (managed by Supabase)
--        │
--        ▼
--   profiles ──────► business_members ──────► businesses
--                    (role: OWNER/ADMIN/       (the tenant)
--                     STAFF/VIEWER)
--
-- Every business-owned table added later carries a business_id and is
-- protected by Row Level Security policies built on the helper functions
-- defined here.
--
-- SECURITY MODEL
-- --------------
-- Tenant isolation is enforced by the DATABASE, not by application code. Even
-- if a query in the app forgets its WHERE clause, PostgreSQL refuses to return
-- another business's rows.
--
-- The helper functions below are SECURITY DEFINER on purpose. An RLS policy on
-- business_members that itself queries business_members causes infinite
-- recursion; running the lookup in a definer function breaks that cycle. They
-- are safe because each one only ever reveals facts about the CALLER's own
-- memberships.
--
-- Every function sets `search_path = ''` so a malicious schema on the caller's
-- search path cannot shadow the tables referenced here. That is why every
-- object below is fully qualified.
-- ============================================================================


-- ----------------------------------------------------------------------------
-- 1. Roles
-- ----------------------------------------------------------------------------
-- Ordered least to most privileged. More granular permissions can be layered
-- on later without changing this enum.

create type public.business_role as enum ('VIEWER', 'STAFF', 'ADMIN', 'OWNER');


-- ----------------------------------------------------------------------------
-- 2. Shared trigger helper
-- ----------------------------------------------------------------------------

create or replace function public.set_updated_at()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  new.updated_at = now();
  return new;
end;
$$;


-- ----------------------------------------------------------------------------
-- 3. profiles
-- ----------------------------------------------------------------------------
-- Application-visible mirror of auth.users. Supabase owns the auth schema; we
-- never write to it directly, so anything the product needs about a person
-- lives here.

create table public.profiles (
  id          uuid primary key references auth.users (id) on delete cascade,
  email       text not null,
  full_name   text check (full_name is null or length(trim(full_name)) between 1 and 120),
  avatar_url  text,
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now()
);

comment on table public.profiles is
  'Application profile for each authenticated user. Mirrors auth.users.';

create trigger profiles_set_updated_at
  before update on public.profiles
  for each row execute function public.set_updated_at();


-- Create the profile automatically when someone signs up. Runs as definer
-- because a brand-new user has no rows and no privileges yet.
create or replace function public.handle_new_user()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  insert into public.profiles (id, email, full_name)
  values (
    new.id,
    new.email,
    nullif(trim(new.raw_user_meta_data ->> 'full_name'), '')
  )
  on conflict (id) do nothing;
  return new;
end;
$$;

create trigger on_auth_user_created
  after insert on auth.users
  for each row execute function public.handle_new_user();


-- ----------------------------------------------------------------------------
-- 4. businesses  (the tenant)
-- ----------------------------------------------------------------------------

create table public.businesses (
  id          uuid primary key default gen_random_uuid(),
  name        text not null check (length(trim(name)) between 1 and 120),
  slug        text not null unique
                check (slug ~ '^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$'),
  currency    char(3) not null default 'BDT' check (currency ~ '^[A-Z]{3}$'),
  timezone    text not null default 'UTC',
  created_by  uuid not null references public.profiles (id) on delete restrict,
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now()
);

comment on table public.businesses is
  'A tenant. Every business-owned table references this via business_id.';
comment on column public.businesses.currency is
  'ISO 4217 code. Financial figures for this business are reported in it.';

create index businesses_created_by_idx on public.businesses (created_by);

create trigger businesses_set_updated_at
  before update on public.businesses
  for each row execute function public.set_updated_at();


-- ----------------------------------------------------------------------------
-- 5. business_members  (who may see which tenant, and with what power)
-- ----------------------------------------------------------------------------

create table public.business_members (
  id           uuid primary key default gen_random_uuid(),
  business_id  uuid not null references public.businesses (id) on delete cascade,
  user_id      uuid not null references public.profiles (id) on delete cascade,
  role         public.business_role not null default 'VIEWER',
  created_at   timestamptz not null default now(),
  updated_at   timestamptz not null default now(),
  unique (business_id, user_id)
);

comment on table public.business_members is
  'Join between a user and a business, carrying the role. This table is the '
  'authority for tenant access; RLS policies elsewhere resolve through it.';

-- user_id is the hot path: every RLS check resolves the caller's businesses.
create index business_members_user_id_idx on public.business_members (user_id);
create index business_members_business_id_idx on public.business_members (business_id);

create trigger business_members_set_updated_at
  before update on public.business_members
  for each row execute function public.set_updated_at();


-- ----------------------------------------------------------------------------
-- 6. Tenancy helper functions
-- ----------------------------------------------------------------------------
-- These are the building blocks for every RLS policy in the product, now and
-- in later phases. SECURITY DEFINER to avoid RLS recursion (see header).

-- Every business the current user belongs to.
create or replace function public.current_user_business_ids()
returns setof uuid
language sql
security definer
set search_path = ''
stable
as $$
  select bm.business_id
  from public.business_members bm
  where bm.user_id = (select auth.uid());
$$;

comment on function public.current_user_business_ids() is
  'The businesses the calling user belongs to. Basis of every tenant policy.';


-- Does the current user hold one of these roles in this business?
create or replace function public.current_user_has_role(
  p_business_id uuid,
  p_roles       public.business_role[]
)
returns boolean
language sql
security definer
set search_path = ''
stable
as $$
  select exists (
    select 1
    from public.business_members bm
    where bm.business_id = p_business_id
      and bm.user_id = (select auth.uid())
      and bm.role = any (p_roles)
  );
$$;


-- Does the current user share any business with this other user? Used so
-- teammates can see each other's names without exposing every profile.
create or replace function public.shares_business_with_current_user(p_user_id uuid)
returns boolean
language sql
security definer
set search_path = ''
stable
as $$
  select exists (
    select 1
    from public.business_members mine
    join public.business_members theirs
      on theirs.business_id = mine.business_id
    where mine.user_id = (select auth.uid())
      and theirs.user_id = p_user_id
  );
$$;


-- ----------------------------------------------------------------------------
-- 7. Integrity: a business must always have an owner
-- ----------------------------------------------------------------------------
-- Without this, an owner could remove or demote themselves and leave the
-- business permanently unadministrable.

create or replace function public.prevent_last_owner_removal()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_owner_count integer;
begin
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

create trigger business_members_protect_last_owner
  before update or delete on public.business_members
  for each row execute function public.prevent_last_owner_removal();


-- ----------------------------------------------------------------------------
-- 8. Creating a business
-- ----------------------------------------------------------------------------
-- Creating a business and becoming its owner must be ATOMIC. If the two
-- statements could run separately, a failure between them would leave an
-- orphaned business nobody can administer. A function body is one
-- transaction, so this cannot half-succeed.
--
-- This is also why businesses has no INSERT policy: the only supported way to
-- create one is through here.

create or replace function public.create_business(
  p_name     text,
  p_slug     text,
  p_currency char(3) default 'BDT',
  p_timezone text    default 'UTC'
)
returns public.businesses
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_user_id  uuid := (select auth.uid());
  v_business public.businesses;
begin
  if v_user_id is null then
    raise exception 'Not authenticated.' using errcode = '28000';
  end if;

  insert into public.businesses (name, slug, currency, timezone, created_by)
  values (
    trim(p_name),
    lower(trim(p_slug)),
    upper(p_currency),
    p_timezone,
    v_user_id
  )
  returning * into v_business;

  insert into public.business_members (business_id, user_id, role)
  values (v_business.id, v_user_id, 'OWNER');

  return v_business;
end;
$$;


-- ----------------------------------------------------------------------------
-- 9. Row Level Security
-- ----------------------------------------------------------------------------
-- RLS is the security boundary. It is enabled on every table, with no
-- exceptions, in the same migration that creates the table.

alter table public.profiles          enable row level security;
alter table public.businesses        enable row level security;
alter table public.business_members  enable row level security;

-- Also apply policies to the table owner. Without this, a superuser-owned
-- table silently bypasses RLS.
alter table public.profiles          force row level security;
alter table public.businesses        force row level security;
alter table public.business_members  force row level security;


-- ---- profiles --------------------------------------------------------------
-- Read your own profile, and those of people you share a business with.
create policy "profiles_select_self_or_teammate"
  on public.profiles for select to authenticated
  using (
    id = (select auth.uid())
    or public.shares_business_with_current_user(id)
  );

-- Update only your own profile.
create policy "profiles_update_self"
  on public.profiles for update to authenticated
  using (id = (select auth.uid()))
  with check (id = (select auth.uid()));

-- No INSERT or DELETE policies: profiles are created by the signup trigger and
-- removed by cascade when the auth user is deleted.


-- ---- businesses ------------------------------------------------------------
create policy "businesses_select_member"
  on public.businesses for select to authenticated
  using (id in (select public.current_user_business_ids()));

create policy "businesses_update_admin"
  on public.businesses for update to authenticated
  using (public.current_user_has_role(id, array['OWNER', 'ADMIN']::public.business_role[]))
  with check (public.current_user_has_role(id, array['OWNER', 'ADMIN']::public.business_role[]));

create policy "businesses_delete_owner"
  on public.businesses for delete to authenticated
  using (public.current_user_has_role(id, array['OWNER']::public.business_role[]));

-- No INSERT policy — use public.create_business(). See section 8.


-- ---- business_members ------------------------------------------------------
create policy "business_members_select_same_business"
  on public.business_members for select to authenticated
  using (business_id in (select public.current_user_business_ids()));

create policy "business_members_insert_admin"
  on public.business_members for insert to authenticated
  with check (
    public.current_user_has_role(business_id, array['OWNER', 'ADMIN']::public.business_role[])
  );

create policy "business_members_update_admin"
  on public.business_members for update to authenticated
  using (
    public.current_user_has_role(business_id, array['OWNER', 'ADMIN']::public.business_role[])
  )
  with check (
    public.current_user_has_role(business_id, array['OWNER', 'ADMIN']::public.business_role[])
  );

-- Admins may remove members; anyone may remove themselves (leave a business).
-- The last-owner trigger still applies in both cases.
create policy "business_members_delete_admin_or_self"
  on public.business_members for delete to authenticated
  using (
    user_id = (select auth.uid())
    or public.current_user_has_role(business_id, array['OWNER', 'ADMIN']::public.business_role[])
  );


-- ----------------------------------------------------------------------------
-- 10. Privileges
-- ----------------------------------------------------------------------------
-- RLS filters rows; GRANT decides who may attempt a query at all. Anonymous
-- visitors have no business touching these tables, so revoke explicitly rather
-- than relying on defaults.

revoke all on public.profiles         from anon;
revoke all on public.businesses       from anon;
revoke all on public.business_members from anon;

grant select, update            on public.profiles         to authenticated;
grant select, update, delete    on public.businesses       to authenticated;
grant select, insert, update, delete on public.business_members to authenticated;

revoke all on function public.create_business(text, text, char, text) from anon, public;
grant execute on function public.create_business(text, text, char, text) to authenticated;

revoke all on function public.current_user_business_ids() from anon, public;
grant execute on function public.current_user_business_ids() to authenticated;

revoke all on function public.current_user_has_role(uuid, public.business_role[]) from anon, public;
grant execute on function public.current_user_has_role(uuid, public.business_role[]) to authenticated;

revoke all on function public.shares_business_with_current_user(uuid) from anon, public;
grant execute on function public.shares_business_with_current_user(uuid) to authenticated;
