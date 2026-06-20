-- 001_create_todos.sql — single-user todo list (no owner column, no RLS:
-- this is the app's own DB, accessed via a full-privilege DATABASE_URL).
create table if not exists todos (
  id         uuid primary key default gen_random_uuid(),
  title      text not null check (char_length(title) between 1 and 500),
  completed  boolean not null default false,
  created_at timestamptz not null default clock_timestamp(),
  updated_at timestamptz not null default clock_timestamp()
);
create index if not exists todos_created_at_idx on todos (created_at);
