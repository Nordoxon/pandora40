
CREATE TABLE public.watched_sites (
  id UUID NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
  url TEXT NOT NULL,
  label TEXT,
  telegram_chat_id TEXT NOT NULL,
  current_hash TEXT,
  last_checked_at TIMESTAMPTZ,
  last_status TEXT,
  is_active BOOLEAN NOT NULL DEFAULT true,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE public.change_history (
  id UUID NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
  site_id UUID NOT NULL REFERENCES public.watched_sites(id) ON DELETE CASCADE,
  event_type TEXT NOT NULL,
  message TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX idx_change_history_site_id ON public.change_history(site_id);
CREATE INDEX idx_change_history_created_at ON public.change_history(created_at DESC);

ALTER TABLE public.watched_sites ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.change_history ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Public can read watched_sites" ON public.watched_sites FOR SELECT USING (true);
CREATE POLICY "Public can insert watched_sites" ON public.watched_sites FOR INSERT WITH CHECK (true);
CREATE POLICY "Public can update watched_sites" ON public.watched_sites FOR UPDATE USING (true);
CREATE POLICY "Public can delete watched_sites" ON public.watched_sites FOR DELETE USING (true);

CREATE POLICY "Public can read change_history" ON public.change_history FOR SELECT USING (true);
CREATE POLICY "Public can insert change_history" ON public.change_history FOR INSERT WITH CHECK (true);
CREATE POLICY "Public can delete change_history" ON public.change_history FOR DELETE USING (true);

CREATE OR REPLACE FUNCTION public.update_updated_at_column()
RETURNS TRIGGER AS $$
BEGIN
  NEW.updated_at = now();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql SET search_path = public;

CREATE TRIGGER update_watched_sites_updated_at
BEFORE UPDATE ON public.watched_sites
FOR EACH ROW EXECUTE FUNCTION public.update_updated_at_column();

ALTER PUBLICATION supabase_realtime ADD TABLE public.watched_sites;
ALTER PUBLICATION supabase_realtime ADD TABLE public.change_history;
