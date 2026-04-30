CREATE TABLE public.kort_slots_seen (
  id uuid NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
  site_id uuid NOT NULL,
  slot_key text NOT NULL,
  slot_date date NOT NULL,
  start_time text,
  end_time text,
  court_name text,
  first_seen_at timestamptz NOT NULL DEFAULT now(),
  last_seen_at timestamptz NOT NULL DEFAULT now(),
  last_busy_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT kort_slots_seen_site_key_unique UNIQUE (site_id, slot_key)
);

CREATE INDEX idx_kort_slots_seen_site ON public.kort_slots_seen(site_id);

ALTER TABLE public.kort_slots_seen ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Public read kort_slots_seen"
  ON public.kort_slots_seen FOR SELECT
  USING (true);

CREATE POLICY "Public insert kort_slots_seen"
  ON public.kort_slots_seen FOR INSERT
  WITH CHECK (true);

CREATE POLICY "Public update kort_slots_seen"
  ON public.kort_slots_seen FOR UPDATE
  USING (true);

CREATE POLICY "Public delete kort_slots_seen"
  ON public.kort_slots_seen FOR DELETE
  USING (true);

CREATE TRIGGER update_kort_slots_seen_updated_at
  BEFORE UPDATE ON public.kort_slots_seen
  FOR EACH ROW
  EXECUTE FUNCTION public.update_updated_at_column();