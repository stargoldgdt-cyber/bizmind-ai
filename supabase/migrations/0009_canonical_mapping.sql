-- ============================================================================
-- 0009  Canonical field mapping
-- ============================================================================
-- FLEXIBLE SOURCE FIELDS. STANDARD BIZMIND MEANING.
--
-- A business should not have to rename its columns to use BizMind. One seller
-- writes "Product Wholesale Price", another writes "Landed Cost", a third
-- writes "COGS". All three can mean cost of goods. None of them proves it.
--
-- This migration adds the layer between a source column and a BizMind metric:
--
--   RAW SOURCE DATA -> SOURCE FIELD -> MAPPING -> CANONICAL METRIC -> ANALYTICS
--
-- and keeps every step of that chain on record, so months later it is still
-- possible to answer "where did this cost of goods number come from?".
--
-- WHAT IT DOES NOT DO
-- -------------------
-- It does not let a similar-looking name become a financial fact. Migration
-- 0008 established that a source field may only feed a BizMind figure once a
-- person has confirmed what it means, enforced by CHECK constraints rather
-- than by application code. That gate is untouched here. What is added is a
-- CANDIDATE: a column recording what BizMind suspects, kept strictly separate
-- from the column recording what BizMind is permitted to use.
--
-- One further rule is added, and it matters. A source column may only be
-- mapped to a metric BizMind treats as SOURCED. It may never be mapped to a
-- COMPUTED one -- gross profit, net profit, margin, average order value. Those
-- are conclusions the analytics engine reaches from figures it has checked. A
-- marketplace's own "Profit/Loss" column looks exactly like net profit and is
-- not: it is built from whatever that seller put in their cost column, and it
-- excludes every expense the marketplace never saw. Allowing it to occupy the
-- net profit slot would let it inherit trust it has not earned.
--
-- APPLY THIS IN THE SUPABASE SQL EDITOR.
-- Clear the editor first: click in it, press Ctrl+A, then Delete.
-- ============================================================================

begin;


-- ----------------------------------------------------------------------------
-- 1. canonical_metrics -- the vocabulary, enforced
-- ----------------------------------------------------------------------------
-- The full definitions, in the owner's language, live in
-- src/services/metrics/canonical.ts and are deliberately NOT copied here:
-- prose in two places drifts. What the database needs is the vocabulary
-- itself and, for each term, whether a source is allowed to supply it. That is
-- what a constraint can act on.
--
-- scripts/verify-mapping-profiles.mts asserts this table and that file agree,
-- so drift is a test failure rather than a surprise.
--
-- This is reference data shared by every tenant. It carries no business_id
-- because it belongs to no business: it is BizMind's own vocabulary. It is
-- readable by any signed-in user and writable by none.

create table public.canonical_metrics (
  key    text primary key,

  /**
   * 'sourced'  -- a confirmed source column may supply this figure.
   * 'computed' -- the analytics engine calculates it. No source may supply it.
   */
  origin text not null check (origin in ('sourced', 'computed')),

  created_at timestamptz not null default now(),

  /* Lets a foreign key require not just a real metric but a SOURCED one. */
  unique (key, origin)
);

comment on table public.canonical_metrics is
  'BizMind''s canonical metric vocabulary. Definitions live in '
  'src/services/metrics/canonical.ts; this table is what constraints enforce.';

insert into public.canonical_metrics (key, origin) values
  ('revenue',             'sourced'),
  ('payment_received',    'sourced'),
  ('cogs',                'sourced'),
  ('marketplace_fees',    'sourced'),
  ('advertising_cost',    'sourced'),
  ('shipping_expense',    'sourced'),
  ('storage_cost',        'sourced'),
  ('promotional_rebates', 'sourced'),
  ('refunds',             'sourced'),
  ('other_expenses',      'sourced'),
  ('operating_expenses',  'sourced'),
  ('total_expense',       'sourced'),
  ('orders',              'sourced'),
  ('units',               'sourced'),
  ('gross_profit',        'computed'),
  ('gross_margin',        'computed'),
  ('net_profit',          'computed'),
  ('net_margin',          'computed'),
  ('customers',           'computed'),
  ('aov',                 'computed'),
  ('cost_coverage',       'computed'),
  ('fee_coverage',        'computed');


-- ----------------------------------------------------------------------------
-- 2. Mapping statuses
-- ----------------------------------------------------------------------------
-- Migration 0008 used three statuses. A mapping needs five, because "nobody
-- has looked at this yet", "we asked and are waiting" and "we asked and the
-- owner genuinely does not know" are three different situations, and only the
-- last one should stop us asking again.
--
-- A new type is created rather than values added to the old one: ALTER TYPE
-- ADD VALUE cannot be used later in the same transaction that adds it, and a
-- migration that cannot run in one transaction can half-apply.

create type public.mapping_status as enum (
  'SUGGESTED',            -- BizMind proposed it; nobody has looked yet
  'PENDING_CONFIRMATION', -- put to a person, awaiting their decision
  'CONFIRMED',            -- a person stated the meaning. Only this may be used
  'REJECTED',             -- examined and found NOT to mean what it looked like
  'UNKNOWN'               -- looked at, and honestly not known
);

-- The CHECK constraints reference the status column, so they are dropped and
-- rebuilt around the type change rather than left to survive it by luck.
alter table public.source_field_semantics
  drop constraint semantics_mapping_requires_confirmation,
  drop constraint semantics_confirmation_requires_attribution;

alter table public.source_field_semantics
  alter column status drop default;

alter table public.source_field_semantics
  alter column status type public.mapping_status
  using (
    case status::text
      -- 0008's default meant "we have not established this", which is exactly
      -- what PENDING_CONFIRMATION means now.
      when 'UNVERIFIED' then 'PENDING_CONFIRMATION'
      else status::text
    end
  )::public.mapping_status;

alter table public.source_field_semantics
  alter column status set default 'PENDING_CONFIRMATION';

alter table public.source_field_semantics
  add constraint semantics_mapping_requires_confirmation
    check (maps_to is null or status = 'CONFIRMED'),
  add constraint semantics_confirmation_requires_attribution
    check (status <> 'CONFIRMED' or (confirmed_by is not null and confirmed_at is not null));


-- ----------------------------------------------------------------------------
-- 3. Candidates, kept apart from confirmations
-- ----------------------------------------------------------------------------
-- Two columns, and the difference between them is the whole point of this
-- migration:
--
--   candidate_metric  what BizMind SUSPECTS this column means.
--                     Written by a name-matching rule. Never read by analytics.
--
--   maps_to           what BizMind is PERMITTED to treat this column as.
--                     Written only by a person, and constrained.
--
-- Keeping them in separate columns means a suggestion cannot be promoted by
-- accident, by a bug, or by an UPDATE that forgets the difference.

alter table public.source_field_semantics
  add column entity public.import_entity,
  add column candidate_metric text,
  add column candidate_confidence text
    check (candidate_confidence is null
           or candidate_confidence in ('high', 'medium', 'low')),
  add column candidate_reason text,
  add column ambiguity_warning text,

  /* Always the literal 'sourced', pinned by the check. Exists so the foreign
     keys below can demand not just a real metric but a SOURCED one. */
  add column sourced_origin text not null default 'sourced'
    check (sourced_origin = 'sourced');

comment on column public.source_field_semantics.candidate_metric is
  'What a name-matching rule suspects. Never consumed by analytics. Only '
  'maps_to authorises use, and only a person may set it.';

comment on column public.source_field_semantics.maps_to is
  'The canonical metric this field may feed. Constrained to metrics whose '
  'origin is ''sourced'': a source column can never BE gross profit.';

-- Both the candidate and the confirmed mapping must name a metric that exists
-- and that a source is allowed to supply. A NULL in the metric column
-- satisfies the key (MATCH SIMPLE), so an unmapped field remains legal.
alter table public.source_field_semantics
  add constraint semantics_maps_to_sourced_metric
    foreign key (maps_to, sourced_origin)
    references public.canonical_metrics (key, origin),
  add constraint semantics_candidate_sourced_metric
    foreign key (candidate_metric, sourced_origin)
    references public.canonical_metrics (key, origin);


-- ----------------------------------------------------------------------------
-- 4. Mapping profiles -- so the same question is not asked twice
-- ----------------------------------------------------------------------------
-- A profile records that a particular file SHAPE has been dealt with: this set
-- of columns, from this source, for this kind of import.
--
-- Note what a profile does NOT store: the metric. It stores which source
-- fields it covers, and each of those points at a row in
-- source_field_semantics, where the meaning lives behind the constraints. A
-- profile therefore cannot carry a mapping the gate would have refused --
-- not because the code is careful, but because there is nowhere to put one.

create table public.source_mapping_profiles (
  id          uuid primary key default gen_random_uuid(),
  business_id uuid not null references public.businesses (id) on delete cascade,
  source      public.channel_type not null,
  entity      public.import_entity not null,

  /** What the owner calls this file. "Amazon.ae monthly settlement". */
  name        text not null,

  /**
   * The file's column set, normalised and sorted. Recognises the same export
   * next month regardless of column order or spacing -- and, just as
   * importantly, FAILS to recognise one that has gained a column, so the new
   * column gets asked about instead of being silently ignored.
   */
  signature   text not null,

  /** The headings exactly as they appeared, for showing the owner. */
  columns     text[] not null default '{}',

  created_by  uuid references public.profiles (id) on delete set null,
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now(),

  unique (business_id, source, entity, signature)
);

comment on table public.source_mapping_profiles is
  'A saved mapping for one file shape, so a confirmed mapping is reused rather '
  'than re-asked. Holds no metric: meaning always comes from '
  'source_field_semantics, behind the gate.';

create index source_mapping_profiles_business_idx
  on public.source_mapping_profiles (business_id, source, entity);

create trigger source_mapping_profiles_set_updated_at
  before update on public.source_mapping_profiles
  for each row execute function public.set_updated_at();


create table public.source_mapping_profile_fields (
  id          uuid primary key default gen_random_uuid(),
  business_id uuid not null references public.businesses (id) on delete cascade,
  profile_id  uuid not null
    references public.source_mapping_profiles (id) on delete cascade,

  /**
   * The meaning. Deliberately a reference rather than a copy: read through it
   * and the constraints of section 3 apply to every use.
   */
  semantics_id uuid not null
    references public.source_field_semantics (id) on delete cascade,

  /** Column order in the original file, so lineage can be shown as it looked. */
  position    integer not null default 0,

  created_at  timestamptz not null default now(),

  unique (profile_id, semantics_id)
);

comment on table public.source_mapping_profile_fields is
  'Which source fields a profile covers. Points at the gated semantics row; '
  'never stores a metric of its own.';

create index source_mapping_profile_fields_profile_idx
  on public.source_mapping_profile_fields (profile_id);


-- ----------------------------------------------------------------------------
-- 5. Recording a suggestion
-- ----------------------------------------------------------------------------
-- Writes what BizMind suspects. It cannot write what BizMind may use: the
-- insert never touches maps_to, and the status values it accepts do not
-- include CONFIRMED.

create or replace function public.suggest_source_field_semantics(
  p_business_id uuid,
  p_source      public.channel_type,
  p_entity      public.import_entity,
  p_field_key   text,
  p_source_label text,
  p_candidate_metric text default null,
  p_confidence  text default null,
  p_reason      text default null,
  p_ambiguity   text default null
)
returns public.source_field_semantics
language plpgsql
security invoker
set search_path = ''
as $$
declare
  v_row public.source_field_semantics;
begin
  if (select auth.uid()) is null then
    raise exception 'Not authenticated.' using errcode = '28000';
  end if;

  insert into public.source_field_semantics (
    business_id, source, entity, field_key, source_label,
    status, candidate_metric, candidate_confidence, candidate_reason,
    ambiguity_warning
  )
  values (
    p_business_id, p_source, p_entity, p_field_key, p_source_label,
    'PENDING_CONFIRMATION', p_candidate_metric, p_confidence, p_reason,
    p_ambiguity
  )
  on conflict (business_id, source, field_key) do update set
    /* A suggestion never disturbs a decision somebody already made. */
    entity               = coalesce(public.source_field_semantics.entity, excluded.entity),
    source_label         = excluded.source_label,
    candidate_metric     = excluded.candidate_metric,
    candidate_confidence = excluded.candidate_confidence,
    candidate_reason     = excluded.candidate_reason,
    ambiguity_warning    = excluded.ambiguity_warning
  where public.source_field_semantics.status in ('SUGGESTED', 'PENDING_CONFIRMATION')
  returning * into v_row;

  /* The row existed and was already decided. Return it untouched. */
  if v_row.id is null then
    select * into v_row
    from public.source_field_semantics
    where business_id = p_business_id
      and source = p_source
      and field_key = p_field_key;
  end if;

  return v_row;
end;
$$;


-- ----------------------------------------------------------------------------
-- 6. Confirming -- attributable, audited, never automatic
-- ----------------------------------------------------------------------------
-- Replaces the 0008 version, which took the old enum type. A function's
-- argument types cannot be changed in place, so it is dropped and recreated.
--
-- DROPPING A FUNCTION ALSO DISCARDS ITS GRANTS. The grant is reissued in
-- section 9 and asserted in section 10. Migration 0008 learned this the hard
-- way with the analytics functions: the code installs cleanly and then nobody
-- can call it.

drop function if exists public.confirm_source_field_semantics(
  uuid, public.channel_type, text, public.semantics_status, text, text);

create or replace function public.confirm_source_field_semantics(
  p_business_id uuid,
  p_source      public.channel_type,
  p_field_key   text,
  p_status      public.mapping_status,
  p_maps_to     text default null,
  p_note        text default null,
  p_source_label text default null,
  p_entity      public.import_entity default null
)
returns public.source_field_semantics
language plpgsql
security invoker
set search_path = ''
as $$
declare
  v_user uuid := (select auth.uid());
  v_row  public.source_field_semantics;
  v_before jsonb;
  v_origin text;
begin
  if v_user is null then
    raise exception 'Not authenticated.' using errcode = '28000';
  end if;

  -- Only an owner or admin may decide that a source field means something. It
  -- changes what every profit figure in the business is built from.
  if not public.current_user_has_role(
       p_business_id, array['OWNER','ADMIN']::public.business_role[]) then
    raise exception 'Only an owner or admin can confirm what a source field means.'
      using errcode = '42501';
  end if;

  if p_status = 'CONFIRMED' and p_maps_to is null then
    raise exception
      'Confirming a field requires stating which BizMind metric it means.'
      using errcode = 'P0001';
  end if;

  -- Refuse a computed metric with an explanation, rather than letting the
  -- foreign key report it as a missing row. The distinction is the point of
  -- the feature, so it is worth saying out loud.
  if p_maps_to is not null then
    select origin into v_origin
    from public.canonical_metrics where key = p_maps_to;

    if v_origin is null then
      raise exception '"%" is not a BizMind metric.', p_maps_to
        using errcode = 'P0001';
    end if;

    if v_origin <> 'sourced' then
      raise exception
        '"%" is calculated by BizMind from figures it has checked, so no source '
        'column can be mapped to it. Map the underlying figures instead.', p_maps_to
        using errcode = 'P0001';
    end if;
  end if;

  select to_jsonb(s) into v_before
  from public.source_field_semantics s
  where s.business_id = p_business_id
    and s.source = p_source
    and s.field_key = p_field_key;

  insert into public.source_field_semantics (
    business_id, source, entity, field_key, source_label, status, maps_to, note,
    confirmed_by, confirmed_at
  )
  values (
    p_business_id, p_source, p_entity, p_field_key,
    coalesce(p_source_label, p_field_key), p_status, p_maps_to, p_note,
    case when p_status = 'CONFIRMED' then v_user end,
    case when p_status = 'CONFIRMED' then now() end
  )
  on conflict (business_id, source, field_key) do update set
    entity       = coalesce(excluded.entity, public.source_field_semantics.entity),
    source_label = coalesce(excluded.source_label, public.source_field_semantics.source_label),
    status       = excluded.status,
    maps_to      = excluded.maps_to,
    note         = coalesce(excluded.note, public.source_field_semantics.note),
    confirmed_by = excluded.confirmed_by,
    confirmed_at = excluded.confirmed_at
  returning * into v_row;

  perform public.write_audit_log(
    p_business_id,
    'source_field_semantics.' || lower(p_status::text),
    'source_field_semantics',
    v_row.id,
    v_before,
    jsonb_build_object(
      'field_key', p_field_key,
      'source_label', v_row.source_label,
      'status', p_status,
      'maps_to', p_maps_to,
      'candidate_metric', v_row.candidate_metric,
      'note', p_note
    )
  );

  return v_row;
end;
$$;


-- ----------------------------------------------------------------------------
-- 7. Saving and reusing a profile
-- ----------------------------------------------------------------------------

create or replace function public.save_mapping_profile(
  p_business_id uuid,
  p_source      public.channel_type,
  p_entity      public.import_entity,
  p_name        text,
  p_signature   text,
  p_columns     text[],
  p_field_keys  text[]
)
returns public.source_mapping_profiles
language plpgsql
security invoker
set search_path = ''
as $$
declare
  v_user    uuid := (select auth.uid());
  v_profile public.source_mapping_profiles;
  v_key     text;
  v_index   integer := 0;
  v_sem     uuid;
begin
  if v_user is null then
    raise exception 'Not authenticated.' using errcode = '28000';
  end if;

  if not public.current_user_has_role(
       p_business_id, array['OWNER','ADMIN','STAFF']::public.business_role[]) then
    raise exception 'You do not have permission to save a mapping for this business.'
      using errcode = '42501';
  end if;

  insert into public.source_mapping_profiles
    (business_id, source, entity, name, signature, columns, created_by)
  values
    (p_business_id, p_source, p_entity, p_name, p_signature,
     coalesce(p_columns, '{}'::text[]), v_user)
  on conflict (business_id, source, entity, signature) do update set
    name    = excluded.name,
    columns = excluded.columns
  returning * into v_profile;

  -- Rebuild the field list. The semantics rows themselves are untouched: a
  -- profile is a bundle of references, and forgetting the bundle must never
  -- forget a decision somebody made.
  delete from public.source_mapping_profile_fields where profile_id = v_profile.id;

  foreach v_key in array coalesce(p_field_keys, '{}'::text[])
  loop
    select id into v_sem
    from public.source_field_semantics
    where business_id = p_business_id and source = p_source and field_key = v_key;

    if v_sem is not null then
      insert into public.source_mapping_profile_fields
        (business_id, profile_id, semantics_id, position)
      values (p_business_id, v_profile.id, v_sem, v_index)
      on conflict (profile_id, semantics_id) do nothing;
    end if;

    v_index := v_index + 1;
  end loop;

  perform public.write_audit_log(
    p_business_id,
    'source_mapping_profile.saved',
    'source_mapping_profiles',
    v_profile.id,
    null,
    jsonb_build_object('name', p_name, 'signature', p_signature,
                       'fields', coalesce(array_length(p_field_keys, 1), 0))
  );

  return v_profile;
end;
$$;


-- ----------------------------------------------------------------------------
-- 8. Resolving a profile, and lineage
-- ----------------------------------------------------------------------------
-- What the import wizard asks on the way in: have we seen this file shape
-- before, and if so what is settled and what still needs a decision?
--
-- `needs_confirmation` is the answer that matters. A saved profile does not
-- mean "import it silently": a column that has appeared since, or one whose
-- meaning was never settled, is returned so it can be asked about.

create or replace function public.resolve_mapping_profile(
  p_business_id uuid,
  p_source      public.channel_type,
  p_entity      public.import_entity,
  p_signature   text
)
returns table (
  profile_id       uuid,
  profile_name     text,
  field_key        text,
  source_label     text,
  status           public.mapping_status,
  maps_to          text,
  candidate_metric text,
  confidence       text,
  confirmed_at     timestamptz,
  usable           boolean
)
language sql
security invoker
set search_path = ''
as $$
  select
    p.id,
    p.name,
    s.field_key,
    s.source_label,
    s.status,
    s.maps_to,
    s.candidate_metric,
    s.candidate_confidence,
    s.confirmed_at,
    /* The only condition under which a source figure may be used. */
    (s.status = 'CONFIRMED' and s.maps_to is not null) as usable
  from public.source_mapping_profiles p
  join public.source_mapping_profile_fields f on f.profile_id = p.id
  join public.source_field_semantics s on s.id = f.semantics_id
  where p.business_id = p_business_id
    and p.source = p_source
    and p.entity = p_entity
    and p.signature = p_signature
  order by f.position;
$$;


-- Where a number came from. The chain, in one row per confirmed mapping:
--   canonical metric <- source column <- source <- who said so, and when.
create or replace function public.mapping_lineage(
  p_business_id uuid,
  p_metric      text default null
)
returns table (
  canonical_metric text,
  source           public.channel_type,
  source_label     text,
  field_key        text,
  status           public.mapping_status,
  confirmed_by     uuid,
  confirmed_by_name text,
  confirmed_at     timestamptz,
  note             text,
  candidate_metric text,
  candidate_confidence text,
  records_preserved bigint
)
language sql
security invoker
set search_path = ''
as $$
  select
    s.maps_to,
    s.source,
    s.source_label,
    s.field_key,
    s.status,
    s.confirmed_by,
    pr.full_name,
    s.confirmed_at,
    s.note,
    s.candidate_metric,
    s.candidate_confidence,
    (select count(*)
       from public.source_records r
      where r.business_id = s.business_id
        and r.source = s.source) as records_preserved
  from public.source_field_semantics s
  left join public.profiles pr on pr.id = s.confirmed_by
  where s.business_id = p_business_id
    and (p_metric is null or s.maps_to = p_metric)
  order by s.maps_to nulls last, s.source_label;
$$;


-- ----------------------------------------------------------------------------
-- 9. Row Level Security and privileges
-- ----------------------------------------------------------------------------

do $$
declare
  t text;
begin
  foreach t in array array['source_mapping_profiles', 'source_mapping_profile_fields']
  loop
    execute format('alter table public.%I enable row level security', t);
    execute format('alter table public.%I force row level security', t);

    execute format($f$
      create policy %I on public.%I for select to authenticated
      using (business_id in (select public.current_user_business_ids()))
    $f$, t || '_select_member', t);

    execute format($f$
      create policy %I on public.%I for insert to authenticated
      with check (public.current_user_has_role(
        business_id, array['OWNER','ADMIN','STAFF']::public.business_role[]))
    $f$, t || '_insert_staff', t);

    execute format($f$
      create policy %I on public.%I for update to authenticated
      using (public.current_user_has_role(
        business_id, array['OWNER','ADMIN','STAFF']::public.business_role[]))
      with check (public.current_user_has_role(
        business_id, array['OWNER','ADMIN','STAFF']::public.business_role[]))
    $f$, t || '_update_staff', t);

    execute format($f$
      create policy %I on public.%I for delete to authenticated
      using (public.current_user_has_role(
        business_id, array['OWNER','ADMIN']::public.business_role[]))
    $f$, t || '_delete_admin', t);

    execute format('revoke all on public.%I from anon', t);
    execute format(
      'grant select, insert, update, delete on public.%I to authenticated', t);
  end loop;
end;
$$;

-- The vocabulary is readable by everyone signed in and writable by nobody.
-- A tenant that could add a metric could invent a slot for a figure nothing
-- has checked.
-- RLS is enabled but deliberately NOT forced: a migration running as the table
-- owner must still be able to add a term to the vocabulary. No tenant can,
-- because there is no write policy and no write grant.
alter table public.canonical_metrics enable row level security;

create policy canonical_metrics_select_authenticated
  on public.canonical_metrics for select to authenticated using (true);

revoke all on public.canonical_metrics from anon, authenticated;
grant select on public.canonical_metrics to authenticated;

revoke all on function public.confirm_source_field_semantics(
  uuid, public.channel_type, text, public.mapping_status, text, text, text,
  public.import_entity) from anon, public;
grant execute on function public.confirm_source_field_semantics(
  uuid, public.channel_type, text, public.mapping_status, text, text, text,
  public.import_entity) to authenticated;

revoke all on function public.suggest_source_field_semantics(
  uuid, public.channel_type, public.import_entity, text, text, text, text, text,
  text) from anon, public;
grant execute on function public.suggest_source_field_semantics(
  uuid, public.channel_type, public.import_entity, text, text, text, text, text,
  text) to authenticated;

revoke all on function public.save_mapping_profile(
  uuid, public.channel_type, public.import_entity, text, text, text[], text[])
  from anon, public;
grant execute on function public.save_mapping_profile(
  uuid, public.channel_type, public.import_entity, text, text, text[], text[])
  to authenticated;

revoke all on function public.resolve_mapping_profile(
  uuid, public.channel_type, public.import_entity, text) from anon, public;
grant execute on function public.resolve_mapping_profile(
  uuid, public.channel_type, public.import_entity, text) to authenticated;

revoke all on function public.mapping_lineage(uuid, text) from anon, public;
grant execute on function public.mapping_lineage(uuid, text) to authenticated;

-- 0008's enum has no remaining users now that the function is rebuilt.
drop type if exists public.semantics_status;


-- ----------------------------------------------------------------------------
-- 10. Self-verification
-- ----------------------------------------------------------------------------
-- A migration that reports success without checking its own guarantees is how
-- a silent security hole ships.

do $$
declare
  t           text;
  fn          text;
  v_rls       boolean;
  v_policies  integer;
  v_business  uuid;
  v_profile   uuid;
  v_gate_held boolean;
  v_count     integer;
begin
  foreach t in array array['source_mapping_profiles', 'source_mapping_profile_fields']
  loop
    select c.relrowsecurity into v_rls
    from pg_class c join pg_namespace n on n.oid = c.relnamespace
    where n.nspname = 'public' and c.relname = t;

    if v_rls is not true then
      raise exception 'SECURITY: table public.% has RLS disabled', t;
    end if;

    select count(*) into v_policies
    from pg_policies where schemaname = 'public' and tablename = t;

    if v_policies <> 4 then
      raise exception 'SECURITY: table public.% has % policies, expected 4', t, v_policies;
    end if;
  end loop;

  -- Dropping a function discards its privileges. Every function this migration
  -- creates or replaces must still be executable by a signed-in user.
  foreach fn in array array[
    'confirm_source_field_semantics', 'suggest_source_field_semantics',
    'save_mapping_profile', 'resolve_mapping_profile', 'mapping_lineage'
  ]
  loop
    if not exists (
      select 1 from pg_proc p join pg_namespace n on n.oid = p.pronamespace
      where n.nspname = 'public' and p.proname = fn
        and has_function_privilege('authenticated', p.oid, 'EXECUTE')
    ) then
      raise exception
        'SECURITY: authenticated cannot execute %(). Its grant was not reissued.', fn;
    end if;
  end loop;

  -- The vocabulary must be complete, or a legitimate mapping would be refused.
  select count(*) into v_count from public.canonical_metrics;
  if v_count <> 22 then
    raise exception 'canonical_metrics has % rows, expected 22', v_count;
  end if;

  select id into v_business from public.businesses limit 1;

  if v_business is null then
    raise notice
      'No businesses exist yet, so the mapping gates could not be exercised. '
      'The constraints are in place; re-run these assertions once a business exists.';
  else
    -- GATE 1 (from 0008, must still hold): an unconfirmed field cannot map.
    v_gate_held := false;
    begin
      insert into public.source_field_semantics
        (business_id, source, field_key, source_label, status, maps_to)
      values (v_business, 'AMAZON', 'gate_check_0009', 'gate check',
              'PENDING_CONFIRMATION', 'cogs');
    exception
      when check_violation then v_gate_held := true;
    end;

    if not v_gate_held then
      delete from public.source_field_semantics
      where business_id = v_business and field_key = 'gate_check_0009';
      raise exception
        'SAFETY: an unconfirmed source field was allowed to map to a metric.';
    end if;

    -- GATE 2 (new): a source column cannot be mapped to a COMPUTED metric,
    -- however properly it was confirmed.
    --
    -- Needs a real profile to satisfy the attribution constraint. Without one
    -- the insert would fail for a DIFFERENT reason and the gate would appear
    -- to hold without ever being tested, so it is skipped and said so.
    select id into v_profile from public.profiles limit 1;

    if v_profile is null then
      raise notice
        'No profiles exist yet, so the computed-metric gate could not be '
        'exercised. The foreign key is in place; re-run once a user exists.';
    else
      v_gate_held := false;
      begin
        insert into public.source_field_semantics
          (business_id, source, field_key, source_label, status, maps_to,
           confirmed_by, confirmed_at)
        values (v_business, 'AMAZON', 'gate_check_computed', 'Profit/Loss',
                'CONFIRMED', 'net_profit', v_profile, now());
      exception
        when foreign_key_violation then v_gate_held := true;
      end;

      if not v_gate_held then
        delete from public.source_field_semantics
        where business_id = v_business and field_key = 'gate_check_computed';
        raise exception
          'SAFETY: a source column was allowed to map to a COMPUTED metric. A '
          'marketplace figure could masquerade as one BizMind calculated.';
      end if;
    end if;
  end if;

  raise notice
    'Migration 0009 verified: vocabulary enforced, candidates kept apart from '
    'confirmations, computed metrics unreachable from any source, RLS in place.';
end;
$$;


commit;
