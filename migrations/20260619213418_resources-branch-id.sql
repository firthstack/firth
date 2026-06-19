-- Make resources branch-aware: fly rows are per-branch; neon/s3 stay project-scoped.
ALTER TABLE public.resources
  ADD COLUMN branch_id UUID REFERENCES public.branches(id) ON DELETE CASCADE;

-- Swap the project-scoped unique key for a branch-aware one.
ALTER TABLE public.resources DROP CONSTRAINT resources_project_id_kind_key;
CREATE UNIQUE INDEX resources_proj_branch_kind_uniq
  ON public.resources (project_id, branch_id, kind);

-- Index for per-branch lookups.
CREATE INDEX idx_resources_branch ON public.resources(branch_id);

-- Backfill: existing fly rows belong to their project's default (live) branch.
UPDATE public.resources r
SET branch_id = (SELECT b.id FROM public.branches b
                 WHERE b.project_id = r.project_id AND b.is_default AND b.archived_at IS NULL)
WHERE r.kind = 'fly' AND r.branch_id IS NULL;
