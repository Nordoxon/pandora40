CREATE TABLE public.kort_slot_audit (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  site_id uuid NOT NULL,
  slot_key text NOT NULL,
  slot_date date NOT NULL,
  start_time text,
  end_time text,
  court_name text,
  classification text NOT NULL,
  reason text,
  raw jsonb,
  classified_at timestamptz NOT NULL DEFAULT now(),
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX idx_kort_slot_audit_site_date ON public.kort_slot_audit (site_id, slot_date);
CREATE INDEX idx_kort_slot_audit_classification ON public.kort_slot_audit (site_id, classification);
CREATE UNIQUE INDEX uq_kort_slot_audit_site_key ON public.kort_slot_audit (site_id, slot_key);

ALTER TABLE public.kort_slot_audit ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Public read kort_slot_audit" ON public.kort_slot_audit FOR SELECT USING (true);
CREATE POLICY "Public insert kort_slot_audit" ON public.kort_slot_audit FOR INSERT WITH CHECK (true);
CREATE POLICY "Public update kort_slot_audit" ON public.kort_slot_audit FOR UPDATE USING (true);
CREATE POLICY "Public delete kort_slot_audit" ON public.kort_slot_audit FOR DELETE USING (true);