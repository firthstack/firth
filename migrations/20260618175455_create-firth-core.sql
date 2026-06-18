-- projects
CREATE TABLE public.projects (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  owner UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'active',
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- branches
CREATE TABLE public.branches (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  project_id UUID NOT NULL REFERENCES public.projects(id) ON DELETE CASCADE,
  owner UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  parent_branch_id UUID REFERENCES public.branches(id) ON DELETE SET NULL,
  is_default BOOLEAN NOT NULL DEFAULT false,
  neon_branch_ref TEXT,
  status TEXT NOT NULL DEFAULT 'active',
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (project_id, name)
);

-- resources
CREATE TABLE public.resources (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  project_id UUID NOT NULL REFERENCES public.projects(id) ON DELETE CASCADE,
  owner UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  kind TEXT NOT NULL CHECK (kind IN ('neon','s3','fly')),
  provider_ref JSONB NOT NULL DEFAULT '{}'::jsonb,
  status TEXT NOT NULL DEFAULT 'pending',
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (project_id, kind)
);

-- secrets (ciphertext only; KEK lives outside the DB)
CREATE TABLE public.secrets (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  project_id UUID NOT NULL REFERENCES public.projects(id) ON DELETE CASCADE,
  owner UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  branch_id UUID REFERENCES public.branches(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  ciphertext TEXT NOT NULL,
  nonce TEXT NOT NULL,
  kek_version TEXT NOT NULL,
  expires_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- indexes on policy / lookup columns
CREATE INDEX idx_projects_owner ON public.projects(owner);
CREATE INDEX idx_branches_owner ON public.branches(owner);
CREATE INDEX idx_branches_project ON public.branches(project_id);
CREATE INDEX idx_resources_owner ON public.resources(owner);
CREATE INDEX idx_resources_project ON public.resources(project_id);
CREATE INDEX idx_secrets_owner ON public.secrets(owner);
CREATE INDEX idx_secrets_scope ON public.secrets(project_id, branch_id);

-- updated_at triggers (InsForge built-in)
CREATE TRIGGER projects_updated_at BEFORE UPDATE ON public.projects
  FOR EACH ROW EXECUTE FUNCTION system.update_updated_at();
CREATE TRIGGER branches_updated_at BEFORE UPDATE ON public.branches
  FOR EACH ROW EXECUTE FUNCTION system.update_updated_at();
CREATE TRIGGER resources_updated_at BEFORE UPDATE ON public.resources
  FOR EACH ROW EXECUTE FUNCTION system.update_updated_at();

-- immutable owner guard
CREATE FUNCTION public.prevent_owner_change()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.owner IS DISTINCT FROM OLD.owner THEN
    RAISE EXCEPTION 'owner is immutable';
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER projects_owner_guard BEFORE UPDATE ON public.projects
  FOR EACH ROW EXECUTE FUNCTION public.prevent_owner_change();
CREATE TRIGGER branches_owner_guard BEFORE UPDATE ON public.branches
  FOR EACH ROW EXECUTE FUNCTION public.prevent_owner_change();
CREATE TRIGGER resources_owner_guard BEFORE UPDATE ON public.resources
  FOR EACH ROW EXECUTE FUNCTION public.prevent_owner_change();

-- enable RLS
ALTER TABLE public.projects  ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.branches  ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.resources ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.secrets   ENABLE ROW LEVEL SECURITY;

-- owner-only policies (join-free; owner denormalized on every table)
CREATE POLICY projects_owner_all ON public.projects FOR ALL TO authenticated
  USING (owner = (SELECT auth.uid())) WITH CHECK (owner = (SELECT auth.uid()));
CREATE POLICY branches_owner_all ON public.branches FOR ALL TO authenticated
  USING (owner = (SELECT auth.uid())) WITH CHECK (owner = (SELECT auth.uid()));
CREATE POLICY resources_owner_all ON public.resources FOR ALL TO authenticated
  USING (owner = (SELECT auth.uid())) WITH CHECK (owner = (SELECT auth.uid()));
CREATE POLICY secrets_owner_all ON public.secrets FOR ALL TO authenticated
  USING (owner = (SELECT auth.uid())) WITH CHECK (owner = (SELECT auth.uid()));

-- privileges (RLS decides rows; grants decide operations)
GRANT USAGE ON SCHEMA public TO authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.projects, public.branches, public.resources TO authenticated;
-- secrets: app reads via the seam; user role may select/insert its own, never update ciphertext in place
GRANT SELECT, INSERT, DELETE ON public.secrets TO authenticated;
