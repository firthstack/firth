CREATE TABLE public.events (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  project_id UUID NOT NULL REFERENCES public.projects(id) ON DELETE CASCADE,
  owner UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  branch_id UUID REFERENCES public.branches(id) ON DELETE SET NULL,
  source TEXT NOT NULL CHECK (source IN ('agent','resource')),
  kind TEXT NOT NULL,
  payload JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX idx_events_owner ON public.events(owner);
CREATE INDEX idx_events_timeline ON public.events(project_id, created_at DESC);

ALTER TABLE public.events ENABLE ROW LEVEL SECURITY;
CREATE POLICY events_owner_all ON public.events FOR ALL TO authenticated
  USING (owner = (SELECT auth.uid())) WITH CHECK (owner = (SELECT auth.uid()));

GRANT USAGE ON SCHEMA public TO authenticated;
GRANT SELECT, INSERT ON public.events TO authenticated;
