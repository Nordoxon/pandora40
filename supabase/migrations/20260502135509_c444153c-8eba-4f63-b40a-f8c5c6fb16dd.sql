DELETE FROM public.kort_slots;
DELETE FROM public.kort_slots_seen;
DELETE FROM public.kort_slot_audit;
DELETE FROM public.pending_telegram_messages;
UPDATE public.watched_sites SET current_hash = NULL, last_status = 'reset for get_courts_status migration' WHERE url ILIKE '%kort40%';