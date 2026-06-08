
-- kort_session: contains live session tokens / CSRF credentials. Lock down fully.
DROP POLICY IF EXISTS "Public read kort_session" ON public.kort_session;
DROP POLICY IF EXISTS "Public insert kort_session" ON public.kort_session;
DROP POLICY IF EXISTS "Public update kort_session" ON public.kort_session;
DROP POLICY IF EXISTS "Public delete kort_session" ON public.kort_session;
REVOKE ALL ON public.kort_session FROM anon, authenticated;

-- pending_telegram_messages: internal queue. Lock down fully.
DROP POLICY IF EXISTS "Public read pending_telegram_messages" ON public.pending_telegram_messages;
DROP POLICY IF EXISTS "Public insert pending_telegram_messages" ON public.pending_telegram_messages;
DROP POLICY IF EXISTS "Public update pending_telegram_messages" ON public.pending_telegram_messages;
DROP POLICY IF EXISTS "Public delete pending_telegram_messages" ON public.pending_telegram_messages;
REVOKE ALL ON public.pending_telegram_messages FROM anon, authenticated;

-- change_history: keep public read (frontend HistoryFeed), remove public writes.
DROP POLICY IF EXISTS "Public can insert change_history" ON public.change_history;
DROP POLICY IF EXISTS "Public can delete change_history" ON public.change_history;
REVOKE INSERT, UPDATE, DELETE ON public.change_history FROM anon, authenticated;

-- kort_slots: keep public read (calendar), remove public writes.
DROP POLICY IF EXISTS "Public insert kort_slots" ON public.kort_slots;
DROP POLICY IF EXISTS "Public delete kort_slots" ON public.kort_slots;
REVOKE INSERT, UPDATE, DELETE ON public.kort_slots FROM anon, authenticated;

-- kort_slots_seen: keep public read, remove public writes.
DROP POLICY IF EXISTS "Public insert kort_slots_seen" ON public.kort_slots_seen;
DROP POLICY IF EXISTS "Public update kort_slots_seen" ON public.kort_slots_seen;
DROP POLICY IF EXISTS "Public delete kort_slots_seen" ON public.kort_slots_seen;
REVOKE INSERT, UPDATE, DELETE ON public.kort_slots_seen FROM anon, authenticated;

-- kort_slot_audit: keep public read, remove public writes.
DROP POLICY IF EXISTS "Public insert kort_slot_audit" ON public.kort_slot_audit;
DROP POLICY IF EXISTS "Public update kort_slot_audit" ON public.kort_slot_audit;
DROP POLICY IF EXISTS "Public delete kort_slot_audit" ON public.kort_slot_audit;
REVOKE INSERT, UPDATE, DELETE ON public.kort_slot_audit FROM anon, authenticated;

-- watched_sites: keep public read (frontend reads site config), remove public writes.
DROP POLICY IF EXISTS "Public can insert watched_sites" ON public.watched_sites;
DROP POLICY IF EXISTS "Public can update watched_sites" ON public.watched_sites;
DROP POLICY IF EXISTS "Public can delete watched_sites" ON public.watched_sites;
REVOKE INSERT, UPDATE, DELETE ON public.watched_sites FROM anon, authenticated;
