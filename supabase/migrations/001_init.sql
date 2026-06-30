-- =========================================================================
-- simweb — initial schema
-- Run this in Supabase SQL Editor (Database → SQL Editor → New query)
-- after creating your project. Then set SUPABASE_URL and
-- SUPABASE_SERVICE_ROLE_KEY as Netlify env vars.
-- =========================================================================

-- Enable extensions (citext for case-insensitive usernames)
create extension if not exists "citext";
create extension if not exists "pgcrypto";

-- -------------------------------------------------------------------------
-- users: extends auth.users with public profile data
-- email / password is managed by Supabase auth (auth.users table)
-- -------------------------------------------------------------------------
create table if not exists public.users (
  id            uuid primary key references auth.users(id) on delete cascade,
  username      citext unique not null
                check (username ~ '^[a-z0-9_]{3,24}$'),
  display_name  text not null default '',
  bio           text not null default '',
  avatar_url    text,
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now()
);
create index if not exists users_username_lower_idx on public.users ((lower(username)));

-- -------------------------------------------------------------------------
-- projects: a "website" with a current version pointer and aggregate stats
-- -------------------------------------------------------------------------
create type public.project_visibility as enum ('public', 'unlisted', 'private');

create table if not exists public.projects (
  id                  uuid primary key default gen_random_uuid(),
  owner_id            uuid not null references public.users(id) on delete cascade,
  slug                citext unique not null
                      check (slug ~ '^[a-z0-9][a-z0-9-]{1,60}$'),
  title               text not null default 'Untitled',
  description         text not null default '',
  current_version_id  uuid,
  visibility          public.project_visibility not null default 'public',
  view_count          integer not null default 0,
  like_count          integer not null default 0,
  favorite_count      integer not null default 0,
  fork_count          integer not null default 0,
  created_at          timestamptz not null default now(),
  updated_at          timestamptz not null default now()
);
create index if not exists projects_owner_idx       on public.projects (owner_id);
create index if not exists projects_visibility_idx  on public.projects (visibility);
create index if not exists projects_updated_idx     on public.projects (updated_at desc);
create index if not exists projects_likes_idx       on public.projects (like_count desc);
create index if not exists projects_views_idx       on public.projects (view_count desc);

-- -------------------------------------------------------------------------
-- project_versions: append-only history of every code edit
-- -------------------------------------------------------------------------
create type public.version_origin as enum ('create', 'edit', 'fork');

create table if not exists public.project_versions (
  id                 uuid primary key default gen_random_uuid(),
  project_id         uuid not null references public.projects(id) on delete cascade,
  version_number     integer not null,
  prompt             text not null,
  model              text not null,
  code               text not null,
  parent_version_id  uuid references public.project_versions(id) on delete set null,
  origin             public.version_origin not null default 'edit',
  created_at         timestamptz not null default now(),
  unique (project_id, version_number)
);
create index if not exists versions_project_idx on public.project_versions (project_id, version_number desc);

-- Now that versions exists, make the FK on projects.current_version_id valid.
alter table public.projects
  drop constraint if exists projects_current_version_fk;
alter table public.projects
  add constraint projects_current_version_fk
  foreign key (current_version_id) references public.project_versions(id) on delete set null
  not valid;   -- already-existing rows may have null; new rows will be checked

-- -------------------------------------------------------------------------
-- likes: who liked what (composite PK prevents duplicates)
-- -------------------------------------------------------------------------
create table if not exists public.likes (
  user_id     uuid not null references public.users(id) on delete cascade,
  project_id  uuid not null references public.projects(id) on delete cascade,
  created_at  timestamptz not null default now(),
  primary key (user_id, project_id)
);
create index if not exists likes_project_idx on public.likes (project_id);

-- -------------------------------------------------------------------------
-- favorites: who bookmarked what
-- -------------------------------------------------------------------------
create table if not exists public.favorites (
  user_id     uuid not null references public.users(id) on delete cascade,
  project_id  uuid not null references public.projects(id) on delete cascade,
  created_at  timestamptz not null default now(),
  primary key (user_id, project_id)
);
create index if not exists favorites_user_idx on public.favorites (user_id);

-- -------------------------------------------------------------------------
-- Trigger: keep aggregate like_count/favorite_count in sync with rows
-- -------------------------------------------------------------------------
create or replace function public.recompute_project_like_count()
returns trigger language plpgsql as $$
begin
  update public.projects
     set like_count = (select count(*) from public.likes where project_id = NEW.project_id),
         updated_at = now()
   where id = NEW.project_id;
  return NEW;
end $$;

create or replace function public.recompute_project_like_count_del()
returns trigger language plpgsql as $$
begin
  update public.projects
     set like_count = (select count(*) from public.likes where project_id = OLD.project_id)
   where id = OLD.project_id;
  return OLD;
end $$;

drop trigger if exists likes_recompute_ins on public.likes;
create trigger likes_recompute_ins
  after insert on public.likes
  for each row execute procedure public.recompute_project_like_count();

drop trigger if exists likes_recompute_del on public.likes;
create trigger likes_recompute_del
  after delete on public.likes
  for each row execute procedure public.recompute_project_like_count_del();

create or replace function public.recompute_project_favorite_count()
returns trigger language plpgsql as $$
begin
  update public.projects
     set favorite_count = (select count(*) from public.favorites where project_id = NEW.project_id)
   where id = NEW.project_id;
  return NEW;
end $$;

create or replace function public.recompute_project_favorite_count_del()
returns trigger language plpgsql as $$
begin
  update public.projects
     set favorite_count = (select count(*) from public.favorites where project_id = OLD.project_id)
   where id = OLD.project_id;
  return OLD;
end $$;

drop trigger if exists favorites_recompute_ins on public.favorites;
create trigger favorites_recompute_ins
  after insert on public.favorites
  for each row execute procedure public.recompute_project_favorite_count();

drop trigger if exists favorites_recompute_del on public.favorites;
create trigger favorites_recompute_del
  after delete on public.favorites
  for each row execute procedure public.recompute_project_favorite_count_del();

-- -------------------------------------------------------------------------
-- Trigger: on new project, automatically insert version 1 of empty code
-- -------------------------------------------------------------------------
create or replace function public.touch_updated_at()
returns trigger language plpgsql as $$
begin
  NEW.updated_at = now();
  return NEW;
end $$;

drop trigger if exists projects_touch on public.projects;
create trigger projects_touch
  before update on public.projects
  for each row execute procedure public.touch_updated_at();

drop trigger if exists users_touch on public.users;
create trigger users_touch
  before update on public.users
  for each row execute procedure public.touch_updated_at();

-- -------------------------------------------------------------------------
-- Row Level Security: row visibility is enforced here. The Netlify
-- functions talk to Supabase via the service role key, so they bypass RLS
-- for trusted inserts/updates. RLS protects against misuse if the anon key
-- is ever exposed client-side.
-- -------------------------------------------------------------------------
alter table public.users            enable row level security;
alter table public.projects         enable row level security;
alter table public.project_versions enable row level security;
alter table public.likes            enable row level security;
alter table public.favorites        enable row level security;

drop policy if exists users_read_all     on public.users;
drop policy if exists users_update_self  on public.users;
create policy users_read_all    on public.users for select using (true);
create policy users_update_self on public.users for update using (auth.uid() = id);

drop policy if exists projects_read_public on public.projects;
drop policy if exists projects_owner_all   on public.projects;
create policy projects_read_public on public.projects
  for select using (visibility = 'public'
                    or auth.uid() = owner_id);
create policy projects_owner_all on public.projects
  for all using (auth.uid() = owner_id) with check (auth.uid() = owner_id);

drop policy if exists versions_read       on public.project_versions;
drop policy if exists versions_owner_all  on public.project_versions;
create policy versions_read on public.project_versions
  for select using (
    exists (select 1 from public.projects p
             where p.id = project_id
               and (p.visibility = 'public' or p.owner_id = auth.uid()))
  );
create policy versions_owner_all on public.project_versions
  for all using (
    exists (select 1 from public.projects p
             where p.id = project_id and p.owner_id = auth.uid())
  ) with check (
    exists (select 1 from public.projects p
             where p.id = project_id and p.owner_id = auth.uid())
  );

drop policy if exists likes_read_all     on public.likes;
drop policy if exists likes_self_all     on public.likes;
create policy likes_read_all on public.likes for select using (true);
create policy likes_self_all on public.likes
  for all using (auth.uid() = user_id) with check (auth.uid() = user_id);

drop policy if exists favs_read_all      on public.favorites;
drop policy if exists favs_self_all      on public.favorites;
create policy favs_read_all on public.favorites for select using (true);
create policy favs_self_all on public.favorites
  for all using (auth.uid() = user_id) with check (auth.uid() = user_id);

-- -------------------------------------------------------------------------
-- Helpful views (function-side queries can use these)
-- -------------------------------------------------------------------------
create or replace view public.project_feed_v as
  select p.*,
         u.username        as owner_username,
         u.display_name    as owner_display_name,
         u.avatar_url      as owner_avatar_url
    from public.projects p
    join public.users u on u.id = p.owner_id
   where p.visibility = 'public'
   order by p.updated_at desc;

-- -------------------------------------------------------------------------
-- Done. Don't forget to run the auth setup at:
--   Authentication → Providers → Email — disable "Confirm email" if you
--   want instant signups without SMTP setup (development only).
-- =========================================================================
