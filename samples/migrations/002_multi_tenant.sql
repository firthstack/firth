-- 002_multi_tenant.sql — accounts + per-user ownership.
create table if not exists users (
  id            uuid primary key default gen_random_uuid(),
  email         text not null unique,
  password_hash text not null,
  created_at    timestamptz not null default clock_timestamp()
);

create table if not exists sessions (
  token_hash text primary key,                 -- sha256(raw token); raw token is only ever sent to the client
  user_id    uuid not null references users(id) on delete cascade,
  created_at timestamptz not null default clock_timestamp(),
  expires_at timestamptz not null
);
create index if not exists sessions_user_id_idx on sessions(user_id);

-- Give todos an owner. Pre-existing ownerless rows are early test data that can't be backfilled to a
-- NOT NULL owner, so they are removed (approved) — but ONLY on first apply (when user_id doesn't exist
-- yet), so a re-run of this migration can never wipe owned todos.
do $$
begin
  if not exists (
    select 1 from information_schema.columns
    where table_name = 'todos' and column_name = 'user_id'
  ) then
    delete from todos;
  end if;
end $$;
alter table todos add column if not exists user_id uuid not null references users(id) on delete cascade;
create index if not exists todos_user_id_idx on todos(user_id);
