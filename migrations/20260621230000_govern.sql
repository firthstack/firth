CREATE TABLE public.governance_rules (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  project_id UUID NOT NULL REFERENCES public.projects(id) ON DELETE CASCADE,
  owner UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  action TEXT NOT NULL,
  decision TEXT NOT NULL CHECK (decision IN ('allow','deny','approve')),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (project_id, action)
);
CREATE INDEX idx_governance_rules_owner ON public.governance_rules(owner);

CREATE TABLE public.approvals (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  project_id UUID NOT NULL REFERENCES public.projects(id) ON DELETE CASCADE,
  owner UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  action TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','granted','denied','consumed')),
  requested_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  decided_at TIMESTAMPTZ
);
CREATE INDEX idx_approvals_owner ON public.approvals(owner);
CREATE INDEX idx_approvals_lookup ON public.approvals(project_id, action, status);

ALTER TABLE public.governance_rules ENABLE ROW LEVEL SECURITY;
CREATE POLICY governance_rules_owner_all ON public.governance_rules FOR ALL TO authenticated
  USING (owner = (SELECT auth.uid())) WITH CHECK (owner = (SELECT auth.uid()));
ALTER TABLE public.approvals ENABLE ROW LEVEL SECURITY;
CREATE POLICY approvals_owner_all ON public.approvals FOR ALL TO authenticated
  USING (owner = (SELECT auth.uid())) WITH CHECK (owner = (SELECT auth.uid()));

GRANT SELECT, INSERT, UPDATE ON public.governance_rules TO authenticated;
GRANT SELECT, INSERT, UPDATE ON public.approvals TO authenticated;
