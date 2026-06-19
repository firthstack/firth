-- Allow reusing a branch name after the old branch is soft-deleted (archived).
-- The original always-on UNIQUE(project_id, name) blocks reuse, because a soft-deleted
-- branch keeps its tombstone row (with its name) for the observe/audit history. Replace
-- the constraint with a PARTIAL unique index that applies only to live (non-archived)
-- rows: two live branches still can't share a name, but an archived branch's name is
-- freed for reuse.
ALTER TABLE public.branches DROP CONSTRAINT branches_project_id_name_key;

CREATE UNIQUE INDEX branches_project_name_live_uniq
  ON public.branches (project_id, name)
  WHERE archived_at IS NULL;
