
ALTER TABLE public.watched_sites
  ADD COLUMN monitor_type TEXT NOT NULL DEFAULT 'html';

CREATE TABLE public.kort_slots (
  id UUID NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
  site_id UUID NOT NULL REFERENCES public.watched_sites(id) ON DELETE CASCADE,
  slot_key TEXT NOT NULL,
  slot_date DATE NOT NULL,
  start_time TEXT,
  end_time TEXT,
  court_name TEXT,
  raw JSONB,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (site_id, slot_key)
);

CREATE INDEX idx_kort_slots_site_date ON public.kort_slots(site_id, slot_date);

ALTER TABLE public.kort_slots ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Public read kort_slots" ON public.kort_slots FOR SELECT USING (true);
CREATE POLICY "Public insert kort_slots" ON public.kort_slots FOR INSERT WITH CHECK (true);
CREATE POLICY "Public delete kort_slots" ON public.kort_slots FOR DELETE USING (true);
