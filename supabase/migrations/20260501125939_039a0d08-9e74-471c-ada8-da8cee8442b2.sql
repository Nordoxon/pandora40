CREATE TABLE public.pending_telegram_messages (
  id uuid NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
  text text NOT NULL,
  attempts integer NOT NULL DEFAULT 0,
  last_error text,
  next_attempt_at timestamptz NOT NULL DEFAULT now(),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX idx_pending_tg_next_attempt ON public.pending_telegram_messages (next_attempt_at);

ALTER TABLE public.pending_telegram_messages ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Public read pending_telegram_messages"
  ON public.pending_telegram_messages FOR SELECT USING (true);
CREATE POLICY "Public insert pending_telegram_messages"
  ON public.pending_telegram_messages FOR INSERT WITH CHECK (true);
CREATE POLICY "Public update pending_telegram_messages"
  ON public.pending_telegram_messages FOR UPDATE USING (true);
CREATE POLICY "Public delete pending_telegram_messages"
  ON public.pending_telegram_messages FOR DELETE USING (true);

CREATE TRIGGER trg_pending_tg_updated_at
  BEFORE UPDATE ON public.pending_telegram_messages
  FOR EACH ROW EXECUTE FUNCTION public.update_updated_at_column();