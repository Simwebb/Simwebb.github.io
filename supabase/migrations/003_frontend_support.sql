-- =========================================================================
-- simweb — frontend-as-static-host support layer
--
-- Run AFTER 001_init.sql and 002_soft_delete.sql. Adds:
--   (1) handle_new_auth_user trigger — auto-creates public.users when
--       supabase.auth.signUp succeeds. Username collision rolls back the
--       auth row atomically.
--   (2) insert_project_version RPC — atomic next-version + re-pointer.
--   (3) increment_view_count RPC — public, anonymous-friendly.
--   (4) pg_cron schedule for soft-delete purge.
--   (5) project_feed_v is widened so the owner still appears in their
--       own feed when they make a project private/unlisted.
-- =========================================================================

-- -------------------------------------------------------------------------
-- 1. handle_new_auth_user()
-- -------------------------------------------------------------------------
-- Called automatically after a row is inserted into auth.users (which is
-- what supabase.auth.signUp does under the hood).
--
-- On a username uniqueness/checks failure we RAISE — Postgres aborts the
-- surrounding transaction, and (because the auth row insert is the same
-- transaction as the trigger firing) the auth row gets rolled back, too.
-- That gives us atomic "username taken" semantics without any RPC.
create or replace function public.handle_new_auth_user()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  uname text := new.raw_user_meta_data->>'username';
  disp  text := coalesce(new.raw_user_meta_data->>'display_name',
                         new.raw_user_meta_data->>'username');
begin
  if uname is null or uname !~ '^[a-z0-9_]{3,24}$' then
    raise exception 'invalid_username' using errcode = '23514';
  end if;

  insert into public.users (id, username, display_name)
  values (new.id, lower(uname), disp);

  return new;

exception
  when unique_violation then
    raise exception 'username_taken' using errcode = '23505';
  when check_violation then
    raise exception 'invalid_username' using errcode = '23514';
end $$;

drop trigger if exists on_auth_user_created on auth.users;
create trigger on_auth_user_created
  after insert on auth.users
  for each row execute procedure public.handle_new_auth_user();

-- -------------------------------------------------------------------------
-- 2. insert_project_version() — atomic append + re-point
-- -------------------------------------------------------------------------
-- Replaces the slipped-page race in the old netlify/projects-update.js
-- retry loop. The SELECT FOR UPDATE row-lock on projects + the COALESCE
-- MAX inside the same transaction guarantees two concurrent calls can't
-- both pick the same version_number.
create or replace function public.insert_project_version(
  p_project_id        uuid,
  p_prompt            text,
  p_model             text,
  p_code              text,
  p_parent_version_id uuid default null,
  p_origin            public.version_origin default 'edit'
)
returns table (id uuid, version_number integer)
language plpgsql
security invoker
set search_path = public
as $$
declare
  v_owner uuid;
  v_next  integer;
  v_id    uuid;
begin
  select owner_id into v_owner
    from public.projects
   where id = p_project_id
   for update;
  if not found then
    raise exception 'project_not_found';
  end if;
  if v_owner <> auth.uid() then
    raise exception 'forbidden' using errcode = '42501';
  end if;

  select coalesce(max(version_number), 0) + 1 into v_next
    from public.project_versions
   where project_id = p_project_id;

  insert into public.project_versions
    (project_id, version_number, prompt, model, code,
     parent_version_id, origin)
  values
    (p_project_id, v_next, p_prompt, p_model, p_code,
     p_parent_version_id, p_origin)
  returning id into v_id;

  update public.projects
     set current_version_id = v_id
   where id = p_project_id;

  return query select v_id, v_next;
end $$;

grant execute on function public.insert_project_version(
  uuid, text, text, text, uuid, public.version_origin
) to authenticated;

-- -------------------------------------------------------------------------
-- 3. increment_view_count() — anyone can bump, including anonymous
-- -------------------------------------------------------------------------
-- RLS prevents non-owners from updating projects.view_count directly, so
-- this SECURITY DEFINER RPC is the only sanctioned path. Idempotent in
-- the sense that POSTing twice in 50ms still produces correct counts;
-- the only abuse vector is somebody POSTing in a tight loop, which we
-- accept for v1.
create or replace function public.increment_view_count(p_project_id uuid)
returns integer
language sql
security definer
set search_path = public
as $$
  update public.projects
     set view_count = view_count + 1
   where id = p_project_id
  returning view_count;
$$;

grant execute on function public.increment_view_count(uuid) to anon, authenticated;

-- -------------------------------------------------------------------------
-- 4. pg_cron — daily hard-delete after the 14-day grace window
-- -------------------------------------------------------------------------
-- Replaces netlify/functions/purge-deleted.js. The pg_cron extension is
-- available on Supabase free tier (Database → Extensions). The cascade on
-- public.users(id) → auth.users(id) + projects + versions + likes +
-- favorites propagates the hard delete in one statement.
create extension if not exists pg_cron;

do $$
begin
  if exists (select 1 from cron.job where jobname = 'simweb-purge-deleted') then
    perform cron.unschedule('simweb-purge-deleted');
  end if;
end $$;

select cron.schedule(
  'simweb-purge-deleted',
  '15 3 * * *',  -- 03:15 UTC daily
  $cmd$
    delete from auth.users a
     where exists (
       select 1 from public.users u
        where u.id = a.id
          and u.deleted_at is not null
          and u.deleted_at < now() - interval '14 days'
     );
  $cmd$
);

-- -------------------------------------------------------------------------
-- 5. project_feed_v — let owners still see their private/unlisted rows
-- -------------------------------------------------------------------------
-- The original view only had visibility = 'public', which means an owner
-- who flipped a project to private could no longer open their own edit
-- page. Now: a row is in the feed if it's public, OR the caller is the
-- owner. The deleted_at guard from migration 002 stays.
create or replace view public.project_feed_v as
  select p.*,
         u.username     as owner_username,
         u.display_name as owner_display_name,
         u.avatar_url   as owner_avatar_url
    from public.projects p
    join public.users  u on u.id = p.owner_id
   where u.deleted_at is null
     and (p.visibility = 'public' or p.owner_id = auth.uid())
   order by p.updated_at desc;

-- =========================================================================
-- Done. After applying this migration, also:
--   • Deploy the openrouter-build Edge Function (supabase functions deploy).
--   • Set the Edge Function secrets:
--       supabase secrets set OPENROUTER_API_KEY=sk-or-v1-...
--       supabase secrets set PUBLIC_SITE_URL=https://your-site.example.com
-- =========================================================================
