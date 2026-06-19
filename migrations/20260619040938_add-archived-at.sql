ALTER TABLE public.projects ADD COLUMN archived_at TIMESTAMPTZ;
ALTER TABLE public.branches ADD COLUMN archived_at TIMESTAMPTZ;
