-- =========================================================================
-- simweb — soft-delete with 14-day grace window
-- Apply after 001_init.sql
-- =========================================================================

-- Add deleted_at to users. When non-null the account is "pending deletion".
-- We hard-delete via the daily scheduled function (netlify/functions/purge-deleted.js)
-- once deleted_at + the grace window is in the past.
alter table public.users
  add column if not exists deleted_at timestamptz default null;

alter table public.users
  add column if not exists deletion_reason text default null;

create index if not exists users_deleted_at_idx
  on public.users (deleted_at)
  where deleted_at is not null;

-- Auto-hide "deleted" users from the public feed by tightening the
-- project_feed_v view (don't surface projects whose owner is pending-deletion).
create or replace view public.project_feed_v as
  select p.*,
         u.username        as owner_username,
         u.display_name    as owner_display_name,
         u.avatar_url      as owner_avatar_url
    from public.projects p
    join public.users u on u.id = p.owner_id
   where p.visibility = 'public'
     and u.deleted_at is null
   order by p.updated_at desc;

-- Helper: returns the timestamp at which a soft-deleted user is purged.
-- Used by both client UI (countdown) and the purge function.
create or replace function public.deletion_scheduled_for(u public.users)
returns timestamptz language sql immutable as $$
  select u.deleted_at + interval '14 days'
$$;

comment on column public.users.deleted_at is
  'Soft-delete marker. Scheduled for hard-deletion 14 days after this timestamp by the daily purge-deleted Netlify function.';
