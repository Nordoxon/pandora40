import { createClient } from 'https://esm.sh/@supabase/supabase-js@2.45.0';

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
};

const GATEWAY_URL = 'https://connector-gateway.lovable.dev/telegram';

async function sha256(text: string): Promise<string> {
  const buf = new TextEncoder().encode(text);
  const hashBuf = await crypto.subtle.digest('SHA-256', buf);
  return Array.from(new Uint8Array(hashBuf))
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');
}

async function sendTelegram(chatId: string, text: string) {
  const LOVABLE_API_KEY = Deno.env.get('LOVABLE_API_KEY');
  const TELEGRAM_API_KEY = Deno.env.get('TELEGRAM_API_KEY');
  if (!LOVABLE_API_KEY || !TELEGRAM_API_KEY) {
    throw new Error('Telegram credentials are not configured');
  }
  const res = await fetch(`${GATEWAY_URL}/sendMessage`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${LOVABLE_API_KEY}`,
      'X-Connection-Api-Key': TELEGRAM_API_KEY,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ chat_id: chatId, text, parse_mode: 'HTML', disable_web_page_preview: true }),
  });
  const data = await res.json();
  if (!res.ok) {
    throw new Error(`Telegram error [${res.status}]: ${JSON.stringify(data)}`);
  }
  return data;
}

async function fetchHtml(url: string): Promise<string> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 25_000);
  try {
    const res = await fetch(url, {
      signal: controller.signal,
      headers: {
        'User-Agent':
          'Mozilla/5.0 (compatible; LovableSiteWatcher/1.0; +https://lovable.dev)',
        Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
      },
      redirect: 'follow',
    });
    if (!res.ok) {
      throw new Error(`HTTP ${res.status}`);
    }
    return await res.text();
  } finally {
    clearTimeout(timeout);
  }
}

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') {
    return new Response('ok', { headers: corsHeaders });
  }

  const supabaseUrl = Deno.env.get('SUPABASE_URL')!;
  const serviceKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;
  const supabase = createClient(supabaseUrl, serviceKey);

  // Optional: check a single site by id (used by "check now" button)
  let onlySiteId: string | null = null;
  if (req.method === 'POST') {
    try {
      const body = await req.json();
      if (body && typeof body.site_id === 'string') onlySiteId = body.site_id;
    } catch (_) {
      // ignore
    }
  }

  let query = supabase.from('watched_sites').select('*').eq('is_active', true);
  if (onlySiteId) query = supabase.from('watched_sites').select('*').eq('id', onlySiteId);

  const { data: sites, error } = await query;
  if (error) {
    return new Response(JSON.stringify({ error: error.message }), {
      status: 500,
      headers: { ...corsHeaders, 'Content-Type': 'application/json' },
    });
  }

  const results: Array<{ id: string; status: string; changed: boolean; message?: string }> = [];

  for (const site of sites ?? []) {
    try {
      const html = await fetchHtml(site.url);
      const hash = await sha256(html);
      const now = new Date().toISOString();

      const isFirst = !site.current_hash;
      const changed = !isFirst && site.current_hash !== hash;

      await supabase
        .from('watched_sites')
        .update({
          current_hash: hash,
          last_checked_at: now,
          last_status: 'ok',
        })
        .eq('id', site.id);

      if (isFirst) {
        await supabase.from('change_history').insert({
          site_id: site.id,
          event_type: 'baseline',
          message: 'Сохранено первоначальное состояние страницы.',
        });
        results.push({ id: site.id, status: 'baseline', changed: false });
      } else if (changed) {
        await supabase.from('change_history').insert({
          site_id: site.id,
          event_type: 'change',
          message: 'Обнаружены изменения HTML.',
        });

        const text =
          `⚠️ <b>Обнаружены изменения на сайте!</b>\n` +
          `URL: ${site.url}\n` +
          (site.label ? `Метка: ${site.label}\n` : '') +
          `Время: ${now}`;
        try {
          await sendTelegram(site.telegram_chat_id, text);
        } catch (tgErr) {
          const msg = tgErr instanceof Error ? tgErr.message : String(tgErr);
          await supabase.from('change_history').insert({
            site_id: site.id,
            event_type: 'error',
            message: `Telegram: ${msg}`,
          });
        }
        results.push({ id: site.id, status: 'changed', changed: true });
      } else {
        results.push({ id: site.id, status: 'unchanged', changed: false });
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      await supabase
        .from('watched_sites')
        .update({ last_checked_at: new Date().toISOString(), last_status: `error: ${msg}` })
        .eq('id', site.id);
      await supabase.from('change_history').insert({
        site_id: site.id,
        event_type: 'error',
        message: msg,
      });
      results.push({ id: site.id, status: 'error', changed: false, message: msg });
    }
  }

  return new Response(JSON.stringify({ ok: true, checked: results.length, results }), {
    headers: { ...corsHeaders, 'Content-Type': 'application/json' },
  });
});
