DELETE FROM public.kort_slots;
UPDATE public.watched_sites SET current_hash = NULL WHERE monitor_type = 'kort40';
DELETE FROM public.pending_telegram_messages;