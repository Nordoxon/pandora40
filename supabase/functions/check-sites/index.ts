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

// ---------- kort40.online integration ----------

interface CookieJar {
  [name: string]: string;
}

function parseSetCookie(headers: Headers, jar: CookieJar) {
  // Deno: getSetCookie() returns array of raw Set-Cookie strings
  const raw = (headers as any).getSetCookie?.() ?? [];
  for (const line of raw) {
    const [pair] = line.split(';');
    const idx = pair.indexOf('=');
    if (idx < 0) continue;
    const name = pair.slice(0, idx).trim();
    const value = pair.slice(idx + 1).trim();
    if (name) jar[name] = value;
  }
}

function jarToHeader(jar: CookieJar): string {
  return Object.entries(jar)
    .map(([k, v]) => `${k}=${v}`)
    .join('; ');
}

const KORT40_BASE = 'https://kort40.online';
const UA =
  'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/147.0.0.0 Safari/537.36';

/**
 * Result of attempting to obtain a kort40 session.
 * status:
 *  - 'ok'      — got a working session
 *  - 'closed'  — site responded but bookings appear closed (no API / non-JSON / specific 4xx)
 *  - 'error'   — network/credential failure we should surface
 */
type LoginResult =
  | { status: 'ok'; jar: CookieJar; freshLogin: boolean }
  | { status: 'closed'; reason: string }
  | { status: 'error'; reason: string };

async function kort40FreshLogin(email: string, password: string): Promise<LoginResult> {
  const jar: CookieJar = {};

  // Step 1: warm up to get csrftoken
  let r1: Response;
  try {
    r1 = await fetch(`${KORT40_BASE}/`, {
      headers: { 'User-Agent': UA, Accept: 'text/html', 'Accept-Language': 'ru,en;q=0.7' },
    });
  } catch (e) {
    return { status: 'error', reason: `network: ${e instanceof Error ? e.message : String(e)}` };
  }
  const homeBody = await r1.text();
  parseSetCookie(r1.headers, jar);

  if (!jar.csrftoken) {
    // Some seasonal landing pages drop the API entirely — treat as closed
    if (/season|сезон|закрыт|closed/i.test(homeBody)) {
      return { status: 'closed', reason: 'no csrftoken; landing looks like off-season page' };
    }
    return { status: 'closed', reason: 'no csrftoken cookie' };
  }

  const loginPaths = ['/api/login/', '/api/auth/login/', '/api/sign-in/'];
  let lastErr = '';
  for (const path of loginPaths) {
    let res: Response;
    try {
      res = await fetch(`${KORT40_BASE}${path}`, {
        method: 'POST',
        headers: {
          'User-Agent': UA,
          'Content-Type': 'application/json',
          Accept: 'application/json',
          'Accept-Language': 'ru,en;q=0.7',
          Referer: `${KORT40_BASE}/login`,
          Origin: KORT40_BASE,
          Cookie: jarToHeader(jar),
          'X-CSRFToken': jar.csrftoken,
        },
        body: JSON.stringify({ email, password }),
      });
    } catch (e) {
      lastErr = `${path} network: ${e instanceof Error ? e.message : String(e)}`;
      continue;
    }
    parseSetCookie(res.headers, jar);
    const body = await res.text();
    if (res.ok && jar.sessionid) {
      return { status: 'ok', jar, freshLogin: true };
    }
    // 404 on every login path → API not deployed for this season
    lastErr = `${path} -> ${res.status} ${body.slice(0, 200)}`;
    if (res.status === 401 || res.status === 403) {
      // Wrong credentials — surface immediately
      return { status: 'error', reason: `auth ${res.status} on ${path}: ${body.slice(0, 200)}` };
    }
  }

  // None of the login endpoints worked, but we did get csrftoken — treat as closed/seasonal
  return { status: 'closed', reason: `login endpoints unavailable: ${lastErr}` };
}

async function getKort40Session(supabase: any, site: any): Promise<LoginResult> {
  const email = Deno.env.get('KORT40_EMAIL');
  const password = Deno.env.get('KORT40_PASSWORD');
  if (!email || !password) {
    return { status: 'error', reason: 'KORT40_EMAIL / KORT40_PASSWORD не настроены' };
  }

  // Try to reuse cached session
  const { data: cached } = await supabase
    .from('kort_session')
    .select('csrftoken,sessionid,expires_at')
    .eq('site_id', site.id)
    .maybeSingle();

  const stillValid =
    cached?.sessionid &&
    cached?.csrftoken &&
    (!cached.expires_at || new Date(cached.expires_at).getTime() > Date.now() + 30_000);

  if (stillValid) {
    return {
      status: 'ok',
      jar: { csrftoken: cached.csrftoken, sessionid: cached.sessionid },
      freshLogin: false,
    };
  }

  const fresh = await kort40FreshLogin(email, password);
  if (fresh.status === 'ok') {
    // Cache for 6 hours
    const expiresAt = new Date(Date.now() + 6 * 60 * 60 * 1000).toISOString();
    await supabase
      .from('kort_session')
      .upsert(
        {
          site_id: site.id,
          csrftoken: fresh.jar.csrftoken,
          sessionid: fresh.jar.sessionid,
          expires_at: expiresAt,
        },
        { onConflict: 'site_id' },
      );
  } else {
    // Drop any stale cached session
    await supabase.from('kort_session').delete().eq('site_id', site.id);
  }
  return fresh;
}

async function kort40FetchSlots(jar: CookieJar, date: string): Promise<unknown> {
  const res = await fetch(
    `${KORT40_BASE}/api/get-available-times/?date=${date}`,
    {
      headers: {
        'User-Agent': UA,
        Accept: 'application/json',
        Referer: `${KORT40_BASE}/`,
        Cookie: jarToHeader(jar),
        'X-CSRFToken': jar.csrftoken ?? '',
      },
    },
  );
  const text = await res.text();
  if (!res.ok) {
    // Mark auth issues so caller can invalidate session
    if (res.status === 401 || res.status === 403) {
      throw new Error(`AUTH_${res.status}`);
    }
    if (res.status === 404 || res.status === 503) {
      throw new Error(`CLOSED_${res.status}`);
    }
    throw new Error(`get-available-times ${date} -> ${res.status}: ${text.slice(0, 200)}`);
  }
  try {
    return JSON.parse(text);
  } catch {
    throw new Error(`CLOSED_HTML`); // got HTML instead of JSON — typical "season closed"
  }
}

interface NormalizedSlot {
  key: string;
  date: string;
  startTime: string;
  endTime: string;
  court: string;
  raw: unknown;
}

/**
 * Normalize unknown response shapes into a flat list of available slots.
 * Recursively walks the JSON, collects objects that look like slots
 * (have time/court fields) and only keeps available ones.
 */
function extractAvailableSlots(data: unknown, date: string): NormalizedSlot[] {
  const out: NormalizedSlot[] = [];
  const seen = new WeakSet<object>();

  function walk(node: unknown, ctx: { court?: string }) {
    if (!node || typeof node !== 'object') return;
    if (seen.has(node as object)) return;
    seen.add(node as object);

    if (Array.isArray(node)) {
      for (const item of node) walk(item, ctx);
      return;
    }

    const obj = node as Record<string, unknown>;

    // Detect a slot-like object
    const start =
      (obj.start_time as string) ??
      (obj.start as string) ??
      (obj.time_from as string) ??
      (obj.from as string) ??
      (obj.time as string);
    const end =
      (obj.end_time as string) ??
      (obj.end as string) ??
      (obj.time_to as string) ??
      (obj.to as string);

    const isAvailable =
      obj.is_available === true ||
      obj.available === true ||
      obj.is_free === true ||
      obj.free === true ||
      obj.status === 'available' ||
      obj.status === 'free';

    const isExplicitlyBusy =
      obj.is_available === false ||
      obj.available === false ||
      obj.is_busy === true ||
      obj.busy === true ||
      obj.is_booked === true ||
      obj.booked === true ||
      obj.status === 'busy' ||
      obj.status === 'booked';

    const courtName =
      (obj.court as string) ??
      (obj.court_name as string) ??
      (obj.name as string) ??
      ctx.court ??
      '—';

    if (start && (isAvailable || (!isExplicitlyBusy && obj.user_id == null && obj.user == null && obj.client == null))) {
      // Only count as available if explicitly available OR has no owner/booking.
      if (isAvailable) {
        out.push({
          key: `${date}|${courtName}|${start}|${end ?? ''}`,
          date,
          startTime: String(start),
          endTime: end ? String(end) : '',
          court: String(courtName),
          raw: obj,
        });
      }
    }

    // Recurse into nested fields
    const nextCtx = {
      court:
        (obj.court_name as string) ??
        (obj.court as string) ??
        ctx.court,
    };
    for (const key of Object.keys(obj)) {
      walk(obj[key], nextCtx);
    }
  }

  walk(data, {});
  return out;
}

function formatDateRu(date: string): string {
  // YYYY-MM-DD -> "28 апр (вт)"
  const d = new Date(date + 'T00:00:00');
  const months = ['янв', 'фев', 'мар', 'апр', 'май', 'июн', 'июл', 'авг', 'сен', 'окт', 'ноя', 'дек'];
  const days = ['вс', 'пн', 'вт', 'ср', 'чт', 'пт', 'сб'];
  return `${d.getDate()} ${months[d.getMonth()]} (${days[d.getDay()]})`;
}

async function processKort40Site(supabase: any, site: any, daysAhead = 30) {
  const email = Deno.env.get('KORT40_EMAIL');
  const password = Deno.env.get('KORT40_PASSWORD');
  if (!email || !password) {
    throw new Error('KORT40_EMAIL / KORT40_PASSWORD не настроены в секретах');
  }

  const jar = await kort40Login(email, password);

  const dates: string[] = [];
  const today = new Date();
  for (let i = 0; i < daysAhead; i++) {
    const d = new Date(today.getTime() + i * 86400000);
    dates.push(d.toISOString().slice(0, 10));
  }

  // Fetch in parallel batches of 8 to stay polite
  const allSlots: NormalizedSlot[] = [];
  const errors: string[] = [];
  let firstRawSample: unknown = null;

  const batchSize = 8;
  for (let i = 0; i < dates.length; i += batchSize) {
    const batch = dates.slice(i, i + batchSize);
    const results = await Promise.allSettled(batch.map((d) => kort40FetchSlots(jar, d)));
    results.forEach((r, idx) => {
      const d = batch[idx];
      if (r.status === 'fulfilled') {
        if (firstRawSample === null) firstRawSample = r.value;
        allSlots.push(...extractAvailableSlots(r.value, d));
      } else {
        errors.push(`${d}: ${r.reason instanceof Error ? r.reason.message : String(r.reason)}`);
      }
    });
  }

  // Compare with previous state
  const { data: prevSlots, error: prevErr } = await supabase
    .from('kort_slots')
    .select('slot_key')
    .eq('site_id', site.id);
  if (prevErr) throw new Error(`db read kort_slots: ${prevErr.message}`);

  const prevKeys = new Set((prevSlots ?? []).map((s: any) => s.slot_key));
  const currentKeys = new Set(allSlots.map((s) => s.key));

  const isFirstRun = prevKeys.size === 0;
  const newSlots = allSlots.filter((s) => !prevKeys.has(s.key));
  const goneKeys = [...prevKeys].filter((k) => !currentKeys.has(k));

  // Replace stored state with current snapshot
  await supabase.from('kort_slots').delete().eq('site_id', site.id);
  if (allSlots.length > 0) {
    const rows = allSlots.map((s) => ({
      site_id: site.id,
      slot_key: s.key,
      slot_date: s.date,
      start_time: s.startTime,
      end_time: s.endTime,
      court_name: s.court,
      raw: s.raw as any,
    }));
    // Insert in chunks of 500
    for (let i = 0; i < rows.length; i += 500) {
      await supabase.from('kort_slots').insert(rows.slice(i, i + 500));
    }
  }

  await supabase
    .from('watched_sites')
    .update({
      last_checked_at: new Date().toISOString(),
      last_status: errors.length > 0 ? `partial: ${errors.length} errors` : 'ok',
      current_hash: `slots:${allSlots.length}`,
    })
    .eq('id', site.id);

  if (isFirstRun) {
    await supabase.from('change_history').insert({
      site_id: site.id,
      event_type: 'baseline',
      message: `Сохранено начальное состояние: ${allSlots.length} свободных слотов на ${daysAhead} дн.`,
    });
    // Diagnostics: log a sample so we can adjust parser if shape differs
    console.log('kort40 first-run sample (truncated):', JSON.stringify(firstRawSample).slice(0, 2000));
    return { changed: false, found: allSlots.length, errors };
  }

  if (newSlots.length > 0) {
    // Group by date for nicer message
    const byDate = new Map<string, NormalizedSlot[]>();
    for (const s of newSlots) {
      if (!byDate.has(s.date)) byDate.set(s.date, []);
      byDate.get(s.date)!.push(s);
    }

    const lines: string[] = ['🎾 <b>Освободились корты на kort40.online</b>'];
    const dateKeys = [...byDate.keys()].sort();
    for (const d of dateKeys) {
      lines.push(`\n📅 <b>${formatDateRu(d)}</b>`);
      const slots = byDate.get(d)!.sort((a, b) => a.startTime.localeCompare(b.startTime));
      for (const s of slots.slice(0, 12)) {
        const time = s.endTime ? `${s.startTime}–${s.endTime}` : s.startTime;
        lines.push(`• ${time} · ${s.court}`);
      }
      if (slots.length > 12) lines.push(`• …и ещё ${slots.length - 12}`);
    }
    lines.push(`\n<a href="${KORT40_BASE}/">Открыть kort40.online</a>`);

    await supabase.from('change_history').insert({
      site_id: site.id,
      event_type: 'change',
      message: `Появилось ${newSlots.length} новых свободных слотов`,
    });

    try {
      await sendTelegram(site.telegram_chat_id, lines.join('\n'));
    } catch (tgErr) {
      const msg = tgErr instanceof Error ? tgErr.message : String(tgErr);
      await supabase.from('change_history').insert({
        site_id: site.id,
        event_type: 'error',
        message: `Telegram: ${msg}`,
      });
    }
  }

  if (errors.length > 0) {
    await supabase.from('change_history').insert({
      site_id: site.id,
      event_type: 'error',
      message: `Ошибки запросов: ${errors.slice(0, 3).join(' | ')}${errors.length > 3 ? ` (+${errors.length - 3})` : ''}`,
    });
  }

  return { changed: newSlots.length > 0, found: allSlots.length, new: newSlots.length, gone: goneKeys.length, errors };
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
      if (site.monitor_type === 'kort40') {
        const r = await processKort40Site(supabase, site, 30);
        results.push({
          id: site.id,
          status: r.changed ? 'changed' : 'unchanged',
          changed: r.changed,
          message: `kort40: found=${r.found} new=${r.new ?? 0} errors=${r.errors.length}`,
        });
        continue;
      }

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
