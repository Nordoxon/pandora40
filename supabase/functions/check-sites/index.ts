import { createClient } from 'https://esm.sh/@supabase/supabase-js@2.45.0';

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
};

const GATEWAY_URL = 'https://connector-gateway.lovable.dev/telegram';

// Maximum attempts before we give up retrying a queued message.
// Each check runs once per minute, so 60 attempts ≈ 1 hour of retrying.
const MAX_QUEUE_ATTEMPTS = 60;

/**
 * Queue a Telegram message for later retry. Used when sendTelegram throws
 * (gateway 502, network errors, etc.) so the notification is not lost.
 */
async function enqueuePendingTelegram(
  supabase: ReturnType<typeof createClient>,
  text: string,
  errorMsg: string,
) {
  try {
    await supabase.from('pending_telegram_messages').insert({
      text,
      attempts: 1,
      last_error: errorMsg.slice(0, 500),
      // first retry in ~1 minute (next check tick)
      next_attempt_at: new Date(Date.now() + 60_000).toISOString(),
    });
  } catch (e) {
    console.error('failed to enqueue pending telegram message:', e);
  }
}

/**
 * Drain the pending Telegram queue. Called at the start of every check run.
 * On success: row deleted. On failure: attempts++, exponential backoff for next retry.
 */
async function flushPendingTelegram(supabase: ReturnType<typeof createClient>) {
  const nowIso = new Date().toISOString();
  const { data: pending, error } = await supabase
    .from('pending_telegram_messages')
    .select('id, text, attempts')
    .lte('next_attempt_at', nowIso)
    .order('created_at', { ascending: true })
    .limit(20);
  if (error || !pending || pending.length === 0) return;

  for (const row of pending as Array<{ id: string; text: string; attempts: number }>) {
    try {
      await sendTelegram(null, row.text);
      await supabase.from('pending_telegram_messages').delete().eq('id', row.id);
      console.log(`flushed pending telegram message ${row.id} (was attempt #${row.attempts})`);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      const nextAttempts = row.attempts + 1;
      if (nextAttempts >= MAX_QUEUE_ATTEMPTS) {
        // Give up: drop from queue and log a permanent error.
        await supabase.from('pending_telegram_messages').delete().eq('id', row.id);
        console.error(`giving up on pending telegram message ${row.id} after ${nextAttempts} attempts: ${msg}`);
      } else {
        // Backoff: 1, 2, 4, ..., capped at 10 minutes.
        const backoffMs = Math.min(10 * 60_000, 60_000 * Math.pow(2, nextAttempts - 1));
        await supabase
          .from('pending_telegram_messages')
          .update({
            attempts: nextAttempts,
            last_error: msg.slice(0, 500),
            next_attempt_at: new Date(Date.now() + backoffMs).toISOString(),
          })
          .eq('id', row.id);
      }
      // Stop after first failure this run — gateway is likely still down,
      // no point hammering it with the rest of the queue.
      break;
    }
  }
}

async function sha256(text: string): Promise<string> {
  const buf = new TextEncoder().encode(text);
  const hashBuf = await crypto.subtle.digest('SHA-256', buf);
  return Array.from(new Uint8Array(hashBuf))
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');
}

async function sendTelegram(_chatId: string | null | undefined, text: string) {
  const LOVABLE_API_KEY = Deno.env.get('LOVABLE_API_KEY');
  const TELEGRAM_API_KEY = Deno.env.get('TELEGRAM_API_KEY');
  const TELEGRAM_CHAT_ID = Deno.env.get('TELEGRAM_CHAT_ID');
  if (!LOVABLE_API_KEY || !TELEGRAM_API_KEY || !TELEGRAM_CHAT_ID) {
    throw new Error('Telegram credentials (TELEGRAM_CHAT_ID) are not configured');
  }
  // Telegram hard limit is 4096 chars per message. Split safely on line breaks
  // to avoid breaking HTML tags mid-tag. Also throttle to respect Telegram rate limits
  // (≈1 msg/sec to the same chat).
  const MAX_LEN = 3800; // keep a safety margin under 4096
  const chunks: string[] = [];
  if (text.length <= MAX_LEN) {
    chunks.push(text);
  } else {
    const lines = text.split('\n');
    let buf = '';
    for (const line of lines) {
      // If a single line is itself too long, hard-split it.
      if (line.length > MAX_LEN) {
        if (buf) { chunks.push(buf); buf = ''; }
        for (let i = 0; i < line.length; i += MAX_LEN) {
          chunks.push(line.slice(i, i + MAX_LEN));
        }
        continue;
      }
      if (buf.length + line.length + 1 > MAX_LEN) {
        chunks.push(buf);
        buf = line;
      } else {
        buf = buf ? `${buf}\n${line}` : line;
      }
    }
    if (buf) chunks.push(buf);
  }

  let lastData: unknown = null;
  for (let i = 0; i < chunks.length; i++) {
    const part = chunks.length > 1 ? `${chunks[i]}\n\n<i>(${i + 1}/${chunks.length})</i>` : chunks[i];
    // Retry transient failures (5xx from gateway/Telegram, network errors, 429 without retry_after)
    const MAX_ATTEMPTS = 6;
    let data: unknown = null;
    let attempt = 0;
    let delivered = false;
    let chatIdToUse: string | number = TELEGRAM_CHAT_ID;
    while (attempt < MAX_ATTEMPTS && !delivered) {
      attempt++;
      let res: Response | null = null;
      let networkErr: unknown = null;
      try {
        res = await fetch(`${GATEWAY_URL}/sendMessage`, {
          method: 'POST',
          headers: {
            Authorization: `Bearer ${LOVABLE_API_KEY}`,
            'X-Connection-Api-Key': TELEGRAM_API_KEY,
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({
            chat_id: chatIdToUse,
            text: part,
            parse_mode: 'HTML',
            disable_web_page_preview: true,
          }),
        });
      } catch (err) {
        networkErr = err;
      }

      if (!res) {
        // network / fetch failure
        if (attempt < MAX_ATTEMPTS) {
          await new Promise((r) => setTimeout(r, Math.min(15_000, 1000 * Math.pow(2, attempt - 1))));
          continue;
        }
        throw new Error(`Telegram network error: ${networkErr instanceof Error ? networkErr.message : String(networkErr)}`);
      }

      data = await res.json().catch(() => ({}));
      if (res.ok) {
        delivered = true;
        break;
      }

      // Honour Telegram's retry_after on flood (429)
      const retryAfter = (data as any)?.parameters?.retry_after;
      if (res.status === 429 && typeof retryAfter === 'number') {
        await new Promise((r) => setTimeout(r, (retryAfter + 1) * 1000));
        attempt--; // don't count toward attempts
        continue;
      }

      // Auto-handle group → supergroup migration: Telegram returns 400 with parameters.migrate_to_chat_id
      const migrateTo = (data as any)?.parameters?.migrate_to_chat_id;
      if (res.status === 400 && typeof migrateTo === 'number') {
        chatIdToUse = migrateTo;
        attempt--; // retry immediately with new chat id, don't count
        continue;
      }

      // Retry on transient errors: 5xx (incl. 502 upstream_request_failed) and 429
      const isTransient = res.status >= 500 || res.status === 429 || res.status === 408;
      if (isTransient && attempt < MAX_ATTEMPTS) {
        // Exponential backoff with jitter, capped at 15s
        const base = Math.min(15_000, 1000 * Math.pow(2, attempt - 1));
        const jitter = Math.floor(Math.random() * 500);
        await new Promise((r) => setTimeout(r, base + jitter));
        continue;
      }

      throw new Error(`Telegram error [${res.status}] after ${attempt} attempt(s): ${JSON.stringify(data)}`);
    }
    lastData = data;
    // Pacing between messages: ~1.1s to stay under per-chat rate limit
    if (i < chunks.length - 1) {
      await new Promise((r) => setTimeout(r, 1100));
    }
  }
  return lastData;
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
const KORT40_TIMEZONE_OFFSET_HOURS = 3;
const KORT40_DAY_START_HOUR = 6;
const KORT40_DAY_END_HOUR = 23;

// kort40 hour numbering, empirically determined by comparing the API payload
// to the live site UI for 2026-05-02 (16:30 MSK):
//   API:  available_hours=[6..12, 21,22,23], reserved=[13,14,15,16,18,19,20], hot_available=[17]
//   UI:   only 17–18 (orange) and 20–21 (green) are bookable for the rest of the day.
// This means:
//   • `available_hours` and `reserved` use the END hour of the slot (e.g. 21 ⇒ 20–21).
//   • `hot_available` uses the START hour of the slot (e.g. 17 ⇒ 17–18).
// We normalise everything to START hour, which matches our DB schema
// (`start_time = '17:00'` for the 17–18 slot).
function endHourToStart(hour: number): number {
  // 21 (end) → 20 (start); 0 (end, i.e. midnight) → 23 (start)
  return (hour + 23) % 24;
}

// `hot_available` is already in start-hour form — no conversion needed.
function hotHourToStart(hour: number): number {
  return hour;
}

function isKort40VisibleHour(hour: number): boolean {
  return hour >= KORT40_DAY_START_HOUR && hour <= KORT40_DAY_END_HOUR;
}

function formatHourRange(hour: number): { start: string; end: string } {
  return {
    start: `${String(hour).padStart(2, '0')}:00`,
    end: `${String((hour + 1) % 24).padStart(2, '0')}:00`,
  };
}

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

  // Step 1: warm up to get csrftoken.
  // The site is now a React SPA — `/` returns a static HTML shell with no cookies.
  // Public endpoints like `/api/news/` don't set csrftoken either; only auth-gated
  // endpoints do. `/api/profile/` reliably returns 401 + `Set-Cookie: csrftoken=...`,
  // which is exactly what we need to subsequently call `/api/login/`.
  let r1: Response;
  try {
    r1 = await fetch(`${KORT40_BASE}/api/profile/`, {
      headers: {
        'User-Agent': UA,
        Accept: 'application/json',
        'Accept-Language': 'ru,en;q=0.7',
        Referer: `${KORT40_BASE}/`,
      },
    });
  } catch (e) {
    return { status: 'error', reason: `network: ${e instanceof Error ? e.message : String(e)}` };
  }
  // 401 is expected here (we're not logged in yet). We only care about the Set-Cookie header.
  await r1.text().catch(() => '');
  parseSetCookie(r1.headers, jar);

  if (!jar.csrftoken) {
    return { status: 'closed', reason: `no csrftoken cookie from /api/profile/ (status ${r1.status})` };
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
      // Credentials don't match the (possibly rebuilt) auth backend.
      // Treat this as 'closed' rather than a hard error so we keep polling
      // quietly every 10 min instead of spamming change_history every minute.
      return {
        status: 'closed',
        reason: `login auth ${res.status} on ${path} — credentials need refresh`,
      };
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
  // Retry on 429 with exponential backoff — kort40 has aggressive rate limiting.
  const MAX_ATTEMPTS = 4;
  let lastStatus = 0;
  let lastBody = '';
  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
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
    if (res.ok) {
      try {
        return JSON.parse(text);
      } catch {
        throw new Error(`CLOSED_HTML`);
      }
    }
    lastStatus = res.status;
    lastBody = text;
    if (res.status === 401 || res.status === 403) {
      throw new Error(`AUTH_${res.status}`);
    }
    if (res.status === 404 || res.status === 503) {
      throw new Error(`CLOSED_${res.status}`);
    }
    // Retry on 429 / 5xx with backoff and jitter.
    const isTransient = res.status === 429 || res.status >= 500;
    if (isTransient && attempt < MAX_ATTEMPTS) {
      const base = Math.min(8000, 800 * Math.pow(2, attempt - 1));
      const jitter = Math.floor(Math.random() * 400);
      await new Promise((r) => setTimeout(r, base + jitter));
      continue;
    }
    break;
  }
  throw new Error(`get-available-times ${date} -> ${lastStatus}: ${lastBody.slice(0, 200)}`);
}

/**
 * Fetch per-court status for a single (date, hour) via /api/get_courts_status/.
 * This is the SOURCE OF TRUTH used by the kort40 booking UI:
 *   { date, hour, busy_courts: ["1","2"] }
 * A slot is free for the user if at least one of the two courts is NOT in busy_courts.
 */
async function kort40FetchCourtsStatus(
  jar: CookieJar,
  date: string,
  hour: number,
): Promise<{ busy_courts: string[] }> {
  const MAX_ATTEMPTS = 3;
  let lastStatus = 0;
  let lastBody = '';
  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    const res = await fetch(
      `${KORT40_BASE}/api/get_courts_status/?date=${date}&hour=${hour}`,
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
    if (res.ok) {
      try {
        const parsed = JSON.parse(text) as { busy_courts?: unknown };
        const busy = Array.isArray(parsed.busy_courts)
          ? parsed.busy_courts.map((c) => String(c))
          : [];
        return { busy_courts: busy };
      } catch {
        throw new Error('CLOSED_HTML');
      }
    }
    lastStatus = res.status;
    lastBody = text;
    if (res.status === 401 || res.status === 403) throw new Error(`AUTH_${res.status}`);
    if (res.status === 404 || res.status === 503) throw new Error(`CLOSED_${res.status}`);
    const isTransient = res.status === 429 || res.status >= 500;
    if (isTransient && attempt < MAX_ATTEMPTS) {
      const base = Math.min(4000, 500 * Math.pow(2, attempt - 1));
      const jitter = Math.floor(Math.random() * 250);
      await new Promise((r) => setTimeout(r, base + jitter));
      continue;
    }
    break;
  }
  throw new Error(`get_courts_status ${date} h=${hour} -> ${lastStatus}: ${lastBody.slice(0, 200)}`);
}

/**
 * Fetch full per-day classified slots for a date using the stable
 * `/api/get-available-times/` response only.
 *
 * We intentionally prefer the legacy single-request path here because the
 * per-hour `/api/get_courts_status/` probing causes persistent 429s from
 * kort40 and breaks the minute-by-minute monitoring loop.
 */
async function kort40FetchClassifiedDay(
  jar: CookieJar,
  date: string,
): Promise<{ classified: ClassifiedSlot[]; raw: unknown }> {
  const timesRaw = (await kort40FetchSlots(jar, date)) as Record<string, unknown>;
  return {
    raw: timesRaw,
    classified: extractClassifiedSlots(timesRaw, date),
  };
}

/** Fetch logged-in user profile — used to diagnose account-specific blocks. */
async function kort40FetchProfile(jar: CookieJar): Promise<unknown> {
  const res = await fetch(`${KORT40_BASE}/api/profile/`, {
    headers: {
      'User-Agent': UA,
      Accept: 'application/json',
      Referer: `${KORT40_BASE}/`,
      Cookie: jarToHeader(jar),
      'X-CSRFToken': jar.csrftoken ?? '',
    },
  });
  const text = await res.text();
  let parsed: unknown;
  try { parsed = JSON.parse(text); } catch { parsed = { _raw: text.slice(0, 500) }; }
  return { _status: res.status, ...(parsed as object) };
}

interface NormalizedSlot {
  key: string;
  date: string;
  startTime: string;
  endTime: string;
  court: string;
  raw: unknown;
}

type SlotClassification =
  | 'available'
  | 'busy'
  | 'not_bookable'
  | 'locked'
  | 'limit_reached'
  | 'season_blocked'
  | 'hot_only'
  | 'unknown';

interface ClassifiedSlot {
  key: string;
  date: string;
  startTime: string;
  endTime: string;
  court: string;
  classification: SlotClassification;
  reason: string;
  raw: unknown;
}

/**
 * Normalize unknown response shapes into a flat list of available slots.
 * Recursively walks the JSON, collects objects that look like slots
 * (have time/court fields) and only keeps available ones.
 */
function extractAvailableSlots(data: unknown, date: string): NormalizedSlot[] {
  return extractClassifiedSlots(data, date)
    .filter((s) => s.classification === 'available')
    .map(({ classification: _c, reason: _r, ...rest }) => rest);
}

/**
 * Walk the API response and classify EVERY slot-like object we find.
 * Used to surface why some visually-present slots aren't actually bookable.
 */
function extractClassifiedSlots(data: unknown, date: string): ClassifiedSlot[] {
  const out: ClassifiedSlot[] = [];
  const seen = new WeakSet<object>();

  // kort40 portal UI does NOT trust available_hours directly.
  // It renders the visible 06:00–23:00 ring by taking `reserved`
  // (shifted to local time), `reserved_hours_by_current_user`, `hot_available`
  // and treating every remaining visible hour as available.
  // Handle this top-level shape directly before generic walk.
  if (data && typeof data === 'object' && !Array.isArray(data)) {
    const root = data as Record<string, unknown>;
    const hasHourArrays =
      Array.isArray(root.available_hours) ||
      Array.isArray(root.reserved) ||
      Array.isArray(root.hot_available) ||
      Array.isArray(root.reserved_hours_by_current_user);
    if (hasHourArrays) {
      const toNumberArray = (arr: unknown): number[] => {
        if (!Array.isArray(arr)) return [];
        return arr
          .map((h) => (typeof h === 'number' ? h : Number(h)))
          .filter((h) => Number.isFinite(h));
      };

      // Day fully blocked: all hour arrays empty + a `detail` reason.
      // Don't fabricate hourly slots — only emit a season_blocked marker.
      const totalHours =
        (Array.isArray(root.available_hours) ? root.available_hours.length : 0) +
        (Array.isArray(root.reserved) ? root.reserved.length : 0) +
        (Array.isArray(root.hot_available) ? root.hot_available.length : 0) +
        (Array.isArray(root.reserved_hours_by_current_user)
          ? root.reserved_hours_by_current_user.length
          : 0);
      if (totalHours === 0 && typeof root.detail === 'string' && root.detail.trim().length > 0) {
        out.push({
          key: `${date}|__day_blocked__`,
          date,
          startTime: '',
          endTime: '',
          court: '—',
          classification: 'season_blocked',
          reason: (root.detail as string).slice(0, 250),
          raw: { detail: root.detail },
        });
        return out;
      }

      // Normalise everything to START hour (see comment near endHourToStart).
      const reservedStart = new Set(
        toNumberArray(root.reserved).map(endHourToStart).filter(isKort40VisibleHour),
      );
      const userReservedStart = new Set(
        toNumberArray(root.reserved_hours_by_current_user)
          .map(endHourToStart)
          .filter(isKort40VisibleHour),
      );
      const hotStart = new Set(
        toNumberArray(root.hot_available).map(hotHourToStart).filter(isKort40VisibleHour),
      );
      const availableStart = new Set(
        toNumberArray(root.available_hours).map(endHourToStart).filter(isKort40VisibleHour),
      );

      const now = new Date();
      const moscowNow = new Date(now.getTime() + KORT40_TIMEZONE_OFFSET_HOURS * 60 * 60 * 1000);
      const todayMoscow = moscowNow.toISOString().slice(0, 10);
      const currentHourMoscow = moscowNow.getUTCHours();
      const isTodayMoscow = date === todayMoscow;

      for (let hour = KORT40_DAY_START_HOUR; hour <= KORT40_DAY_END_HOUR; hour++) {
        const { start, end } = formatHourRange(hour);
        let classification: SlotClassification;
        let reason: string;

        // Positive classification: a slot is free ONLY if the API explicitly
        // lists it in `available_hours` or `hot_available` AND it is in the
        // future. Everything else is busy or not bookable. This matches the
        // live UI.
        if (isTodayMoscow && hour <= currentHourMoscow) {
          classification = 'not_bookable';
          reason = 'past';
        } else if (availableStart.has(hour)) {
          classification = 'available';
          reason = 'available_hours';
        } else if (hotStart.has(hour)) {
          classification = 'available';
          reason = 'hot_available';
        } else if (userReservedStart.has(hour)) {
          classification = 'busy';
          reason = 'reserved_hours_by_current_user';
        } else if (reservedStart.has(hour)) {
          classification = 'busy';
          reason = 'reserved';
        } else {
          // Slot is in none of the lists and not in the past — treat as not
          // bookable (e.g. outside the booking horizon, locked by the venue).
          classification = 'not_bookable';
          reason = 'unlisted';
        }

        out.push({
          key: `${date}|kort40|${start}`,
          date,
          startTime: start,
          endTime: end,
          court: 'kort40',
          classification,
          reason,
          raw: {
            hour,
            source: reason,
            available: availableStart.has(hour),
            reserved: reservedStart.has(hour),
            user_reserved: userReservedStart.has(hour),
            hot_available: hotStart.has(hour),
          },
        });
      }

      // If detail is present AND there are zero hours of any kind → season_blocked for this date
      const total =
        (Array.isArray(root.available_hours) ? root.available_hours.length : 0) +
        (Array.isArray(root.reserved) ? root.reserved.length : 0) +
        (Array.isArray(root.hot_available) ? root.hot_available.length : 0) +
        (Array.isArray(root.reserved_hours_by_current_user)
          ? root.reserved_hours_by_current_user.length
          : 0);
      if (total === 0 && typeof root.detail === 'string') {
        out.push({
          key: `${date}|__day_blocked__`,
          date,
          startTime: '',
          endTime: '',
          court: '—',
          classification: 'season_blocked',
          reason: (root.detail as string).slice(0, 250),
          raw: { detail: root.detail },
        });
      }
      return out;
    }
  }

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

    if (start) {
      // Heuristic flags for "visible but not bookable" buckets
      const isLocked =
        obj.is_locked === true ||
        obj.locked === true ||
        obj.is_blocked === true ||
        obj.blocked === true ||
        obj.status === 'locked' ||
        obj.status === 'blocked' ||
        obj.status === 'closed';
      const isNotBookable =
        obj.is_bookable === false ||
        obj.bookable === false ||
        obj.can_book === false ||
        obj.is_available_for_booking === false;
      const reachedLimit =
        obj.limit_reached === true ||
        obj.over_limit === true ||
        obj.too_many_bookings === true ||
        (typeof obj.error === 'string' && /limit|превыш/i.test(obj.error as string));
      const hasOwner =
        obj.user_id != null || obj.user != null || obj.client != null || obj.client_id != null;

      let classification: SlotClassification;
      let reason: string;
      if (isAvailable && !isLocked && !isNotBookable && !reachedLimit) {
        classification = 'available';
        reason = 'flag:available';
      } else if (reachedLimit) {
        classification = 'limit_reached';
        reason = 'flag:limit_reached';
      } else if (isLocked) {
        classification = 'locked';
        reason = 'flag:locked/blocked/closed';
      } else if (isNotBookable) {
        classification = 'not_bookable';
        reason = 'flag:bookable=false';
      } else if (isExplicitlyBusy || hasOwner) {
        classification = 'busy';
        reason = hasOwner ? 'has owner/client' : 'flag:busy/booked';
      } else if (isAvailable === false && !hasOwner) {
        classification = 'not_bookable';
        reason = 'available=false, no owner';
      } else {
        classification = 'unknown';
        reason = `keys=${Object.keys(obj).slice(0, 8).join(',')}`;
      }

      out.push({
        key: `${date}|${courtName}|${start}|${end ?? ''}`,
        date,
        startTime: String(start),
        endTime: end ? String(end) : '',
        court: String(courtName),
        classification,
        reason,
        raw: obj,
      });
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

const CLOSED_BACKOFF_MS = 10 * 60 * 1000; // 10 минут когда сайт закрыт
const OPEN_INTERVAL_MS = 60 * 1000;        // 1 минута когда сайт работает

function buildSlotsList(slots: NormalizedSlot[], header: string): string {
  const byDate = new Map<string, NormalizedSlot[]>();
  for (const s of slots) {
    if (!byDate.has(s.date)) byDate.set(s.date, []);
    byDate.get(s.date)!.push(s);
  }
  const lines: string[] = [header];
  const dateKeys = [...byDate.keys()].sort();
  // Сообщение всё равно будет автоматически разбито на части в sendTelegram,
  // поэтому показываем больше дней и слотов при открытии сезона.
  for (const d of dateKeys.slice(0, 30)) {
    lines.push(`\n📅 <b>${formatDateRu(d)}</b>`);
    const dayList = byDate.get(d)!.sort((a, b) => a.startTime.localeCompare(b.startTime));
    for (const s of dayList.slice(0, 20)) {
      const time = s.endTime ? `${s.startTime}–${s.endTime}` : s.startTime;
      lines.push(`• ${time} · ${s.court}`);
    }
    if (dayList.length > 20) lines.push(`• …и ещё ${dayList.length - 20}`);
  }
  if (dateKeys.length > 30) lines.push(`\n…и ещё ${dateKeys.length - 30} дней`);
  lines.push(`\n<a href="${KORT40_BASE}/">Открыть kort40.online</a>`);
  return lines.join('\n');
}

function pluralSlots(n: number): string {
  const mod10 = n % 10;
  const mod100 = n % 100;
  if (mod10 === 1 && mod100 !== 11) return 'слот';
  if (mod10 >= 2 && mod10 <= 4 && (mod100 < 12 || mod100 > 14)) return 'слота';
  return 'слотов';
}

/**
 * Build a compact human-readable summary of which slots opened up,
 * for storing in change_history.message. Example:
 *   "9 мая 19:00–20:00, 21:00–22:00; 10 мая 14:00–15:00 (Корт 1)"
 * Truncates if there are too many entries.
 */
function summarizeFreedSlots(slots: NormalizedSlot[]): string {
  if (slots.length === 0) return '';
  const byDate = new Map<string, NormalizedSlot[]>();
  for (const s of slots) {
    if (!byDate.has(s.date)) byDate.set(s.date, []);
    byDate.get(s.date)!.push(s);
  }
  const dateKeys = [...byDate.keys()].sort();
  const MAX_DAYS = 5;
  const MAX_TIMES_PER_DAY = 6;
  // Detect single-court vs multi-court to decide whether to append court name
  const courtSet = new Set(slots.map((s) => s.court));
  const showCourt = courtSet.size > 1;

  const dayParts: string[] = [];
  for (const d of dateKeys.slice(0, MAX_DAYS)) {
    const list = byDate.get(d)!.sort((a, b) => a.startTime.localeCompare(b.startTime));
    const times = list.slice(0, MAX_TIMES_PER_DAY).map((s) => {
      const t = s.endTime ? `${s.startTime}–${s.endTime}` : s.startTime;
      return showCourt ? `${t} (${s.court})` : t;
    });
    if (list.length > MAX_TIMES_PER_DAY) {
      times.push(`…ещё ${list.length - MAX_TIMES_PER_DAY}`);
    }
    dayParts.push(`${formatDateRu(d)} ${times.join(', ')}`);
  }
  let result = dayParts.join('; ');
  if (dateKeys.length > MAX_DAYS) {
    result += `; …ещё ${dateKeys.length - MAX_DAYS} дн.`;
  }
  return result;
}

async function markSeasonClosed(supabase: any, site: any, reason: string) {
  const wasOpen = site.season_status === 'open';
  const nextCheck = new Date(Date.now() + CLOSED_BACKOFF_MS).toISOString();
  await supabase
    .from('watched_sites')
    .update({
      last_checked_at: new Date().toISOString(),
      last_status: `closed: ${reason.slice(0, 120)}`,
      season_status: 'closed',
      consecutive_errors: 0, // closed ≠ error
      next_check_at: nextCheck,
    })
    .eq('id', site.id);

  if (wasOpen) {
    await supabase.from('change_history').insert({
      site_id: site.id,
      event_type: 'season_close',
      message: `Бронирование закрыто. Опрос — раз в 10 минут.`,
    });
  }
}

async function processKort40Site(supabase: any, site: any, daysAhead = 30) {
  // 1) Get session
  const login = await getKort40Session(supabase, site);
  if (login.status === 'closed') {
    await markSeasonClosed(supabase, site, login.reason);
    return { status: 'closed' as const, reason: login.reason };
  }
  if (login.status === 'error') {
    throw new Error(login.reason);
  }

  let jar = login.jar;
  let didReLogin = login.freshLogin;

  // Log profile to diagnose account-specific issues (limits, banned, unverified, etc.)
  try {
    const profile = await kort40FetchProfile(jar);
    console.log(`kort40 profile ${site.id}:`, JSON.stringify(profile).slice(0, 1500));
  } catch (e) {
    console.log(`kort40 profile fetch error: ${e instanceof Error ? e.message : String(e)}`);
  }

  // 2) Probe today's date first
  const dates: string[] = [];
  const today = new Date();
  for (let i = 0; i < daysAhead; i++) {
    const d = new Date(today.getTime() + i * 86400000);
    dates.push(d.toISOString().slice(0, 10));
  }

  const allSlots: NormalizedSlot[] = [];
  const allClassified: ClassifiedSlot[] = [];
  const errors: string[] = [];
  let firstRawSample: unknown = null;
  let closedSignals = 0;
  let okResponses = 0;
  let detailMessage: string | null = null;

  // Each date now triggers ~19 sub-requests (1× get-available-times + 18× get_courts_status).
  // kort40 rate-limits aggressively (429 above ~6 concurrent reqs), so we process dates
  // strictly serially. Within a date, hours run 3 at a time (see HOUR_CONCURRENCY).
  const batchSize = 1;

  async function runBatch(batchDates: string[]) {
    const results = await Promise.allSettled(
      batchDates.map((d) => kort40FetchClassifiedDay(jar, d)),
    );
    for (let idx = 0; idx < results.length; idx++) {
      const r = results[idx];
      const d = batchDates[idx];
      if (r.status === 'fulfilled') {
        okResponses++;
        if (firstRawSample === null) firstRawSample = r.value.raw;
        try {
          console.log(`kort40 raw ${d}:`, JSON.stringify(r.value.raw).slice(0, 2000));
        } catch (_) {
          console.log(`kort40 raw ${d}: <unserializable>`);
        }
        const rawObj = r.value.raw as Record<string, unknown> | null;
        if (
          detailMessage === null &&
          rawObj &&
          typeof rawObj === 'object' &&
          typeof (rawObj as any).detail === 'string'
        ) {
          detailMessage = (rawObj as any).detail as string;
        }
        const classified = r.value.classified;
        allClassified.push(...classified);
        for (const c of classified) {
          if (c.classification === 'available') {
            allSlots.push({
              key: c.key,
              date: c.date,
              startTime: c.startTime,
              endTime: c.endTime,
              court: c.court,
              raw: c.raw,
            });
          }
        }
      } else {
        const msg = r.reason instanceof Error ? r.reason.message : String(r.reason);
        if (msg === 'CLOSED_HTML' || msg.startsWith('CLOSED_')) closedSignals++;
        else if (msg.startsWith('AUTH_')) errors.push(`${d}: ${msg}`);
        else errors.push(`${d}: ${msg}`);
      }
    }
  }

  for (let i = 0; i < dates.length; i += batchSize) {
    const batch = dates.slice(i, i + batchSize);
    await runBatch(batch);

    // If first batch returns AUTH errors → re-login once and retry
    if (i === 0 && !didReLogin && errors.some((e) => e.includes('AUTH_'))) {
      await supabase.from('kort_session').delete().eq('site_id', site.id);
      const fresh = await kort40FreshLogin(
        Deno.env.get('KORT40_EMAIL')!,
        Deno.env.get('KORT40_PASSWORD')!,
      );
      if (fresh.status === 'ok') {
        jar = fresh.jar;
        didReLogin = true;
        await supabase.from('kort_session').upsert(
          {
            site_id: site.id,
            csrftoken: fresh.jar.csrftoken,
            sessionid: fresh.jar.sessionid,
            expires_at: new Date(Date.now() + 6 * 60 * 60 * 1000).toISOString(),
          },
          { onConflict: 'site_id' },
        );
        errors.length = 0;
        await runBatch(batch); // retry
      } else if (fresh.status === 'closed') {
        await markSeasonClosed(supabase, site, fresh.reason);
        return { status: 'closed' as const, reason: fresh.reason };
      } else {
        throw new Error(fresh.reason);
      }
    }

    // Pause between dates to keep request rate modest.
    if (i + batchSize < dates.length) await new Promise((r) => setTimeout(r, 250));
  }

  // 3) If majority of probes say "closed", treat the whole site as closed
  if (okResponses === 0 && closedSignals > 0) {
    await markSeasonClosed(supabase, site, `${closedSignals} dates returned non-JSON / 404`);
    return { status: 'closed' as const, reason: 'API returns no JSON' };
  }

  // 3a) Replace audit snapshot — useful for diagnosing "visible but not bookable" slots
  const auditCounts: Record<SlotClassification, number> = {
    available: 0,
    busy: 0,
    not_bookable: 0,
    locked: 0,
    limit_reached: 0,
    season_blocked: 0,
    hot_only: 0,
    unknown: 0,
  };
  for (const c of allClassified) auditCounts[c.classification]++;

  await supabase.from('kort_slot_audit').delete().eq('site_id', site.id);
  if (allClassified.length > 0) {
    const auditRows = allClassified.map((c) => ({
      site_id: site.id,
      slot_key: c.key,
      slot_date: c.date,
      start_time: c.startTime,
      end_time: c.endTime,
      court_name: c.court,
      classification: c.classification,
      reason: c.reason,
      raw: c.raw as any,
    }));
    for (let i = 0; i < auditRows.length; i += 500) {
      const { error: auditErr } = await supabase
        .from('kort_slot_audit')
        .insert(auditRows.slice(i, i + 500));
      if (auditErr) console.error('kort_slot_audit insert error:', auditErr.message);
    }
  }
  console.log(
    `kort40 audit ${site.id}: free=${auditCounts.available} busy=${auditCounts.busy} ` +
      `not_bookable=${auditCounts.not_bookable} locked=${auditCounts.locked} ` +
      `limit_reached=${auditCounts.limit_reached} hot_only=${auditCounts.hot_only} ` +
      `unknown=${auditCounts.unknown} ` +
      `total=${allClassified.length}`,
  );

  // 3b) If ANY date failed to fetch (429, network, etc.), the snapshot is partial.
  // Using it for diff would falsely flag dropped-then-recovered slots as "freed".
  // Skip baseline + diff + snapshot replacement; just record the error and retry next tick.
  if (errors.length > 0) {
    await supabase
      .from('watched_sites')
      .update({
        last_checked_at: new Date().toISOString(),
        last_status:
          `partial: ${errors.length} errors • snapshot skipped • ` +
          `free=${auditCounts.available} busy=${auditCounts.busy}`,
        // do NOT change current_hash / season_status — keep previous baseline intact
        next_check_at: new Date(Date.now() + OPEN_INTERVAL_MS).toISOString(),
      })
      .eq('id', site.id);
    await supabase.from('change_history').insert({
      site_id: site.id,
      event_type: 'error',
      message:
        `Частичная проверка: ${errors.length} запрос(ов) не прошли — снапшот не обновлён, повтор на следующей минуте. ` +
        `Первая ошибка: ${errors[0].slice(0, 200)}`,
    });
    return {
      status: 'partial' as const,
      errors: errors.length,
      okResponses,
    };
  }

  // 4) Site is OPEN — diff slots vs previous snapshot
  const { data: prevSlots, error: prevErr } = await supabase
    .from('kort_slots')
    .select('slot_key')
    .eq('site_id', site.id);
  if (prevErr) throw new Error(`db read kort_slots: ${prevErr.message}`);

  const prevKeys = new Set((prevSlots ?? []).map((s: any) => s.slot_key));
  const currentKeys = new Set(allSlots.map((s) => s.key));
  const isFirstSnapshot = prevKeys.size === 0;
  const newSlots = allSlots.filter((s) => !prevKeys.has(s.key));
  const goneKeys = [...prevKeys].filter((k) => !currentKeys.has(k));
  const seasonJustOpened = site.season_status !== 'open';

  // Load "seen" history to distinguish "slot appeared for the first time"
  // from "slot was busy and now freed up". We only notify for the latter,
  // otherwise long-horizon evergreen-free slots would spam the bot.
  const { data: seenRows, error: seenErr } = await supabase
    .from('kort_slots_seen')
    .select('slot_key,last_busy_at')
    .eq('site_id', site.id);
  if (seenErr) throw new Error(`db read kort_slots_seen: ${seenErr.message}`);

  const seenMap = new Map<string, { last_busy_at: string | null }>();
  for (const r of seenRows ?? []) {
    seenMap.set((r as any).slot_key, { last_busy_at: (r as any).last_busy_at });
  }

  // The kort40 schedule is fixed: every day 6:00–24:00 × 2 courts. There is no
  // such thing as a slot "appearing for the first time" mid-monitoring — if we
  // see a free slot now that wasn't free in the previous snapshot, it means it
  // was busy before and just got released (cancellation or a brand-new day in
  // the 30-day horizon, which functionally is the same: previously unavailable
  // → now free). So after the very first snapshot, every newSlot is a freed slot.
  const freedSlots = newSlots;

  // Replace stored snapshot
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
    for (let i = 0; i < rows.length; i += 500) {
      await supabase.from('kort_slots').insert(rows.slice(i, i + 500));
    }
  }

  // Update the long-term "seen" log:
  //  - upsert all currently-free slots → bumps last_seen_at, registers first-time keys
  //  - mark slots that disappeared from the free list as busy (last_busy_at = now)
  const nowIso = new Date().toISOString();
  if (allSlots.length > 0) {
    const seenRowsToUpsert = allSlots.map((s) => ({
      site_id: site.id,
      slot_key: s.key,
      slot_date: s.date,
      start_time: s.startTime,
      end_time: s.endTime,
      court_name: s.court,
      last_seen_at: nowIso,
    }));
    for (let i = 0; i < seenRowsToUpsert.length; i += 500) {
      const { error: upErr } = await supabase
        .from('kort_slots_seen')
        .upsert(seenRowsToUpsert.slice(i, i + 500), { onConflict: 'site_id,slot_key' });
      if (upErr) console.error('kort_slots_seen upsert error:', upErr.message);
    }
  }
  if (goneKeys.length > 0) {
    // Chunk the IN(...) filter to keep request size sane.
    for (let i = 0; i < goneKeys.length; i += 200) {
      const chunk = goneKeys.slice(i, i + 200);
      const { error: busyErr } = await supabase
        .from('kort_slots_seen')
        .update({ last_busy_at: nowIso })
        .eq('site_id', site.id)
        .in('slot_key', chunk);
      if (busyErr) console.error('kort_slots_seen mark-busy error:', busyErr.message);
    }
  }

  await supabase
    .from('watched_sites')
    .update({
      last_checked_at: new Date().toISOString(),
      last_status:
        (errors.length > 0 ? `partial: ${errors.length} errors • ` : 'ok • ') +
        `free=${auditCounts.available} busy=${auditCounts.busy} ` +
        `nb=${auditCounts.not_bookable} lock=${auditCounts.locked} ` +
        `lim=${auditCounts.limit_reached} blk=${auditCounts.season_blocked} ` +
        `un=${auditCounts.unknown}` +
        (detailMessage ? ` • detail: ${detailMessage.slice(0, 100)}` : ''),
      current_hash: `slots:${allSlots.length}`,
      season_status: 'open',
      consecutive_errors: 0,
      next_check_at: new Date(Date.now() + OPEN_INTERVAL_MS).toISOString(),
    })
    .eq('id', site.id);

  // 5) Notifications
  if (seasonJustOpened) {
    // Season just transitioned closed/unknown → open
    const header = `🎾 <b>Бронирование на kort40.online открыто!</b>\nСвободно ${allSlots.length} слотов на ближайшие ${daysAhead} дн.`;
    const text = allSlots.length > 0 ? buildSlotsList(allSlots, header) : `${header}\n\n<a href="${KORT40_BASE}/">Открыть kort40.online</a>`;

    await supabase.from('change_history').insert({
      site_id: site.id,
      event_type: 'season_open',
      message: `Сезон открыт: ${allSlots.length} свободных слотов на ${daysAhead} дн.`,
    });
    try {
      await sendTelegram(site.telegram_chat_id, text);
    } catch (tgErr) {
      const msg = tgErr instanceof Error ? tgErr.message : String(tgErr);
      await enqueuePendingTelegram(supabase, text, msg);
      await supabase.from('change_history').insert({
        site_id: site.id,
        event_type: 'error',
        message: `Telegram: ${msg} — поставлено в очередь повторов`,
      });
    }
    console.log('kort40 first-open sample:', JSON.stringify(firstRawSample).slice(0, 1500));
    return { status: 'season_open' as const, found: allSlots.length };
  }

  if (isFirstSnapshot) {
    await supabase.from('change_history').insert({
      site_id: site.id,
      event_type: 'baseline',
      message: `Сохранено начальное состояние: ${allSlots.length} свободных слотов на ${daysAhead} дн.`,
    });
    return { status: 'baseline' as const, found: allSlots.length };
  }

  if (freedSlots.length > 0) {
    const text = buildSlotsList(freedSlots, '🎾 <b>Освободились корты на kort40.online</b>\n<i>(кто-то отменил бронь)</i>');
    const summary = summarizeFreedSlots(freedSlots);
    await supabase.from('change_history').insert({
      site_id: site.id,
      event_type: 'change',
      message: `Освободилось ${freedSlots.length} ${pluralSlots(freedSlots.length)} после отмены брони: ${summary}`,
    });
    try {
      await sendTelegram(site.telegram_chat_id, text);
    } catch (tgErr) {
      const msg = tgErr instanceof Error ? tgErr.message : String(tgErr);
      await enqueuePendingTelegram(supabase, text, msg);
      await supabase.from('change_history').insert({
        site_id: site.id,
        event_type: 'error',
        message: `Telegram: ${msg} — поставлено в очередь повторов`,
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

  return {
    status: 'open' as const,
    found: allSlots.length,
    new: newSlots.length,
    freed: freedSlots.length,
    gone: goneKeys.length,
    errors,
  };
}

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') {
    return new Response('ok', { headers: corsHeaders });
  }

  const supabaseUrl = Deno.env.get('SUPABASE_URL')!;
  const serviceKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;
  const supabase = createClient(supabaseUrl, serviceKey);

  // Try to deliver any messages that previously failed (e.g. gateway 502).
  // Runs before normal checks so retries happen on every cron tick.
  try {
    await flushPendingTelegram(supabase);
  } catch (e) {
    console.error('flushPendingTelegram failed:', e);
  }

  // Diagnose mode: return raw kort40 responses for the configured account
  // so we can see exactly what the site says about THIS user.
  const url = new URL(req.url);
  if (url.searchParams.get('diagnose') === 'kort40') {
    const { data: site } = await supabase
      .from('watched_sites')
      .select('*')
      .eq('monitor_type', 'kort40')
      .eq('is_active', true)
      .limit(1)
      .maybeSingle();
    if (!site) {
      return new Response(JSON.stringify({ error: 'no kort40 site' }), {
        status: 404,
        headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      });
    }
    // Force fresh login to make sure stale session isn't masking the issue
    await supabase.from('kort_session').delete().eq('site_id', site.id);
    const login = await getKort40Session(supabase, site);
    if (login.status !== 'ok') {
      return new Response(JSON.stringify({ login }), {
        status: 200,
        headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      });
    }
    const profile = await kort40FetchProfile(login.jar).catch((e) => ({ error: String(e) }));
    const today = new Date();
    const probeDates: string[] = [];
    const horizonParam = Number(url.searchParams.get('days') ?? '30');
    const horizon = Number.isFinite(horizonParam) ? Math.max(1, Math.min(30, horizonParam)) : 30;
    for (let i = 0; i < horizon; i++) {
      probeDates.push(new Date(today.getTime() + i * 86400000).toISOString().slice(0, 10));
    }
    const slots: Record<string, unknown> = {};
    for (const d of probeDates) {
      try {
        slots[d] = await kort40FetchSlots(login.jar, d);
      } catch (e) {
        slots[d] = { error: e instanceof Error ? e.message : String(e) };
      }
    }
    // Compact view: dates where current user already has a reservation
    const userBookings: Record<string, number[]> = {};
    for (const [d, raw] of Object.entries(slots)) {
      const r = raw as { reserved_hours_by_current_user?: unknown };
      if (Array.isArray(r?.reserved_hours_by_current_user) && r.reserved_hours_by_current_user.length > 0) {
        userBookings[d] = r.reserved_hours_by_current_user as number[];
      }
    }
    return new Response(
      JSON.stringify({ profile, userBookings, slots }, null, 2),
      { status: 200, headers: { ...corsHeaders, 'Content-Type': 'application/json' } },
    );
  }

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
    // Respect backoff window unless this is a manual "check now"
    if (
      !onlySiteId &&
      site.next_check_at &&
      new Date(site.next_check_at).getTime() > Date.now()
    ) {
      results.push({
        id: site.id,
        status: 'skipped',
        changed: false,
        message: `next_check_at=${site.next_check_at}`,
      });
      continue;
    }

    try {
      if (site.monitor_type === 'kort40') {
        const r = await processKort40Site(supabase, site, 30);
        results.push({
          id: site.id,
          status: r.status,
          changed: r.status === 'season_open' || ('new' in r && (r as any).new > 0),
          message: `kort40: ${r.status} ${'found' in r ? `found=${(r as any).found}` : ''}`,
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
          await enqueuePendingTelegram(supabase, text, msg);
          await supabase.from('change_history').insert({
            site_id: site.id,
            event_type: 'error',
            message: `Telegram: ${msg} — поставлено в очередь повторов`,
          });
        }
        results.push({ id: site.id, status: 'changed', changed: true });
      } else {
        results.push({ id: site.id, status: 'unchanged', changed: false });
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      const nextErrors = (site.consecutive_errors ?? 0) + 1;
      // After 3 consecutive errors, back off to 10 minutes
      const backoff = nextErrors >= 3 ? CLOSED_BACKOFF_MS : OPEN_INTERVAL_MS;
      await supabase
        .from('watched_sites')
        .update({
          last_checked_at: new Date().toISOString(),
          last_status: `error: ${msg.slice(0, 200)}`,
          consecutive_errors: nextErrors,
          next_check_at: new Date(Date.now() + backoff).toISOString(),
        })
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
