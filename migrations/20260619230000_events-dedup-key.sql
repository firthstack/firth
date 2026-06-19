-- Add a content-hash idempotency key for uploaded audit findings.
-- Non-partial unique index: Postgres treats NULLs as distinct, so existing
-- resource/agent events with a NULL dedup_key never conflict and are unaffected.
ALTER TABLE public.events ADD COLUMN dedup_key TEXT;

CREATE UNIQUE INDEX events_owner_proj_dedup_uniq
  ON public.events (owner, project_id, dedup_key);
