// Debug endpoint: probes various kort40 endpoints with the cached session
// to figure out how to fetch per-court availability.
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2.45.0';

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
};

const KORT40_BASE = 'https://kort40.online';
const UA =
  'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/147.0.0.0 Safari/537.36';

function jarToHeader(j: { csrftoken?: string | null; sessionid?: string | null }): string {
  const parts: string[] = [];
  if (j.csrftoken) parts.push(`csrftoken=${j.csrftoken}`);
  if (j.sessionid) parts.push(`sessionid=${j.sessionid}`);
  return parts.join('; ');
}

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: corsHeaders });

  const url = new URL(req.url);
  const date = url.searchParams.get('date') ?? '2026-05-02';

  const supabase = createClient(
    Deno.env.get('SUPABASE_URL')!,
    Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!,
  );

  const { data: session } = await supabase
    .from('kort_session')
    .select('csrftoken, sessionid')
    .order('updated_at', { ascending: false })
    .limit(1)
    .maybeSingle();

  if (!session?.sessionid) {
    return new Response(JSON.stringify({ error: 'no session' }), {
      headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      status: 500,
    });
  }

  const headers = {
    'User-Agent': UA,
    Accept: 'application/json, text/html, */*',
    Referer: `${KORT40_BASE}/reserve/`,
    Cookie: jarToHeader(session),
    'X-CSRFToken': session.csrftoken ?? '',
  };

  const probes = [
    `/api/get-available-times/?date=${date}`,
    `/api/get_courts/`,
    `/api/get_courts/?date=${date}`,
    `/api/get_courts_status/`,
    `/api/get_courts_status/?date=${date}`,
    `/api/booked_times/`,
    `/api/booked_times/?date=${date}`,
    `/api/hot_reservation/`,
    `/api/hot_reservation/?date=${date}`,
    `/api/currentday/`,
    `/api/count_games/`,
  ];

  const results: Array<{ path: string; status: number; preview: string }> = [];
  for (const p of probes) {
    try {
      const r = await fetch(`${KORT40_BASE}${p}`, { headers });
      const text = await r.text();
      results.push({
        path: p,
        status: r.status,
        preview: text.slice(0, 800),
      });
    } catch (e) {
      results.push({ path: p, status: -1, preview: String(e).slice(0, 300) });
    }
  }

  return new Response(JSON.stringify({ date, results }, null, 2), {
    headers: { ...corsHeaders, 'Content-Type': 'application/json' },
  });
});