-- 003_todo_images.sql — one optional image per todo (Tigris storage object key).
-- Additive and idempotent: a single nullable column; existing rows are unaffected.
alter table todos add column if not exists image_key text;
