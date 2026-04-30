-- Add scheduling and season-tracking columns to watched_sites
ALTER TABLE public.watched_sites
  ADD COLUMN IF NOT EXISTS next_check_at timestamptz,
  ADD COLUMN IF NOT EXISTS consecutive_errors int NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS season_status text NOT NULL DEFAULT 'unknown';

-- Cache table for kort40 login session (csrftoken + sessionid)
CREATE TABLE IF NOT EXISTS public.kort_session (
  id uuid NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
  site_id uuid NOT NULL UNIQUE,
  csrftoken text,
  sessionid text,
  expires_at timestamptz,
  updated_at timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE public.kort_session ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Public read kort_session" ON public.kort_session
  FOR SELECT USING (true);
CREATE POLICY "Public insert kort_session" ON public.kort_session
  FOR INSERT WITH CHECK (true);
CREATE POLICY "Public update kort_session" ON public.kort_session
  FOR UPDATE USING (true);
CREATE POLICY "Public delete kort_session" ON public.kort_session
  FOR DELETE USING (true);

CREATE TRIGGER update_kort_session_updated_at
  BEFORE UPDATE ON public.kort_session
  FOR EACH ROW
  EXECUTE FUNCTION public.update_updated_at_column();
